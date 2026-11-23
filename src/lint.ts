import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import type { Finding } from './index.js'

/**
 * A small static lint for two mistakes that reviews keep finding in plugin code. It reads source text, flags
 * places, and never edits anything. It is a heuristic: a hit says "look here", and a clean run is not proof.
 *
 * 1. A host's answer used as if any truthy value meant yes (`if (await options.canX(...))`). Only an exact
 *    `=== true` should count: an object, a string or 1 is not a yes.
 * 2. A paginated `payload.find` that passes `req`, without `pagination: false`, as the first query in its function.
 *    Payload runs the find and its count at once on the same Mongo session, and as a transaction's first
 *    query that fails with NoSuchTransaction. `findByID`, `pagination: false` and a find that follows another
 *    query in the same function are skipped. It reads every source file, since helpers are called from hooks.
 */

/** Blanks comments and keeps every newline, so line numbers stay right. */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\/|(^|[^:\\])\/\/[^\n]*/g, (m, lead: string | undefined) => (lead ? lead : '') + m.slice(lead?.length ?? 0).replace(/[^\n]/g, ' '))
}

/** Where the function around `index` starts: the nearest unmatched `{` before it. */
function enclosingStart(src: string, index: number): number {
  let depth = 0
  for (let i = index - 1; i >= 0; i--) {
    const c = src[i]
    if (c === '}') depth++
    else if (c === '{') {
      if (depth === 0) return i
      depth--
    }
  }
  return 0
}

const lineOf = (src: string, index: number) => src.slice(0, index).split('\n').length

/** Names that read like a host decision: access, veto, allow, can…, is…Allowed, guard, authorize, permit. */
const HOOK = String.raw`(?:[A-Za-z_$][\w$]*\??\.)+(?:access\w*|veto\w*|allow\w*|authori[sz]e\w*|permit\w*|can[A-Z]\w*|is\w*Allowed|guard\w*|\w*Access|\w*Veto)`
const CALL = String.raw`(?:await\s+)?${HOOK}\s*\??\.?\(`

function balanced(src: string, open: number): string {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (c === '(' || c === '{' || c === '[') depth++
    else if (c === ')' || c === '}' || c === ']') {
      depth--
      if (depth === 0) return src.slice(open, i + 1)
    }
  }
  return src.slice(open)
}

export function lintSource(path: string, source: string): Finding[] {
  const src = stripComments(source)
  const out: Finding[] = []
  const add = (check: string, title: string, index: number, how: string) =>
    out.push({ check, title, severity: 'medium', status: 'fail', role: 'code', path: `${path}:${lineOf(src, index)}`, how, reproduce: `Open ${path} at line ${lineOf(src, index)}.` })

  // 1a. Used directly in a condition: if (await opts.canX(...)), !opts.canX(...), canX(...) ? a : b, && and ||.
  const direct = new RegExp(String.raw`(?:\bif\s*\(\s*!?\s*|\bwhile\s*\(\s*!?\s*|[(!]\s*|[&|]{2}\s*)(${CALL})`, 'g')
  for (const m of src.matchAll(direct)) {
    const open = m.index! + m[0].length - 1
    const call = balanced(src, open)
    const after = src.slice(open + call.length, open + call.length + 12)
    if (/^\s*(===|!==|==|!=)/.test(after)) continue
    if (/^\)\s*(===|!==)/.test(after)) continue
    add('truthy-host-answer', 'A host answer counts as yes for any truthy value', m.index!, 'The host hook’s answer is used as a condition. Compare it with === true so an object, a string or 1 isn’t read as yes.')
  }
  // 1b. Stored, then used as a truth value.
  const stored = new RegExp(String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*${CALL}`, 'g')
  for (const m of src.matchAll(stored)) {
    const name = m[1]!
    const rest = src.slice(m.index! + m[0].length)
    const use = new RegExp(String.raw`(?:\bif\s*\(\s*!?\s*${name}\s*[)&|]|!\s*${name}\b(?!\s*[=.])|\b${name}\s*\?\s|\bBoolean\(\s*${name}\s*\)|[&|]{2}\s*${name}\b(?!\s*[=.]))`)
    const u = use.exec(rest)
    if (u && !new RegExp(String.raw`\b${name}\s*(===|!==)`).test(rest)) add('truthy-host-answer', 'A host answer counts as yes for any truthy value', m.index!, `${name} holds a host hook’s answer and is used as a condition. Compare it with === true.`)
  }

  // 2. A paginated find with req, as the first query of its function. It runs in any file, since helpers are
  // called from hooks. A find that follows another query in the same function isn't the first one in a
  // transaction, so it's skipped. It doesn't follow calls into other functions.
  for (const m of src.matchAll(/\.find\s*\(/g)) {
    const call = balanced(src, m.index! + m[0].length - 1)
    if (!/\breq\b/.test(call)) continue
    if (/pagination\s*:\s*false/.test(call)) continue
    if (/\.(?:find|findByID|findOne|count|create|update|delete|findGlobal|updateGlobal)\s*\(/.test(src.slice(enclosingStart(src, m.index!), m.index!))) continue
    add('paginated-find-in-transaction', 'A paginated find with req may be a transaction’s first query', m.index!, 'payload.find runs its query and its count at once; as the first query on a transaction’s one Mongo session that throws NoSuchTransaction. Add pagination: false, or use a single query. (Heuristic: it can’t see whether a transaction is open, or what called this function.)')
  }
  return out
}

/** Lints every .ts, .tsx, .js, .mjs file under `dir` (skipping node_modules, dist and test folders). Returns one pass finding when clean. */
export function lintDirectory(dir: string): Finding[] {
  const files: string[] = []
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (['node_modules', 'dist', '.git', 'test', 'tests', '__tests__'].includes(name)) continue
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(tsx?|mjs|js)$/.test(name) && !/\.(test|spec|d)\.[tj]s$/.test(name)) files.push(p)
    }
  }
  walk(dir)
  const found = files.flatMap((f) => lintSource(relative(dir, f), readFileSync(f, 'utf8')))
  return found.length ? found : [{ check: 'plugin-source-lint', title: 'Plugin source lint', severity: 'info', status: 'pass', role: 'code', path: dir, how: `Read ${files.length} file${files.length === 1 ? '' : 's'}; nothing to flag.` }]
}
