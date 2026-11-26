import { lstatSync, readdirSync, readFileSync } from 'node:fs'
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
 * 3. A Payload local API call that passes both `context` and the shared `req`. Payload merges that context
 *    into `req.context`, and it stays there for every later operation on the request, so a skip flag meant
 *    for one internal write switches the plugin's hooks off for the rest of the request. A `req` made with
 *    `isolateObjectProperty(req, ['context'])`, in the call or assigned to `req` earlier in the file, is skipped.
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

/** Local constant objects (`const READ = { pagination: false }`), by name, so a spread can be followed. */
export function collectObjects(src: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?=\{)/g)) map.set(m[1]!, balanced(src, m.index! + m[0].length))
  return map
}

/** Whether the call, or an object spread into it, sets `pagination: false`. */
function paginationOff(text: string, objects: Map<string, string>, seen = new Set<string>()): boolean {
  if (/pagination\s*:\s*false/.test(text)) return true
  for (const m of text.matchAll(/\.\.\.\s*([A-Za-z_$][\w$]*)\b(?!\s*[.(\[])/g)) {
    const name = m[1]!
    if (seen.has(name)) continue
    seen.add(name)
    const body = objects.get(name)
    if (body && paginationOff(body, objects, seen)) return true
  }
  return false
}

/** Whether a Payload call that carries `req` comes before `end` in the function. An Array `.find` doesn't carry it. */
function earlierQuery(src: string, start: number, end: number): boolean {
  const before = src.slice(start, end)
  for (const m of before.matchAll(/\.(?:find|findByID|findOne|count|create|update|delete|findGlobal|updateGlobal)\s*\(/g)) {
    if (/\breq\b/.test(balanced(src, start + m.index! + m[0].length - 1))) return true
  }
  return false
}

export function lintSource(path: string, source: string, shared: Map<string, string> = new Map()): Finding[] {
  const src = stripComments(source)
  const objects = new Map([...shared, ...collectObjects(src)])
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
    if (paginationOff(call, objects)) continue
    if (earlierQuery(src, enclosingStart(src, m.index!), m.index!)) continue
    add('paginated-find-in-transaction', 'A paginated find with req may be a transaction’s first query', m.index!, 'payload.find runs its query and its count at once; as the first query on a transaction’s one Mongo session that throws NoSuchTransaction. Add pagination: false, or use a single query. (Heuristic: it can’t see whether a transaction is open, or what called this function.)')
  }

  // 3. context with the shared req. Payload's createLocalReq merges the call's context into req.context.
  const localCall = /\.(?:find|findByID|findOne|count|create|update|delete|duplicate|findGlobal|updateGlobal|findVersions|restoreVersion)\s*\(/g
  for (let m = localCall.exec(src); m; m = localCall.exec(src)) {
    const call = balanced(src, m.index! + m[0].length - 1)
    if (!/[{,]\s*context\s*[:,}]/.test(call)) continue
    if (!/[{,]\s*req\s*(?:[,}]|:\s*(?:[\w$]+\.)*req\b(?!\s*[.(]))/.test(call)) continue
    if (/isolateObjectProperty/.test(call)) continue
    if (/\breq\s*=\s*isolateObjectProperty\s*\(/.test(src.slice(0, m.index!))) continue
    add('context-on-shared-req', 'A local API call sets context on the shared req', m.index!, 'Passing context with req merges it into req.context, and it stays there for every later operation on the request, so a skip flag meant for this call turns hooks off for the rest of it. Pass req: isolateObjectProperty(req, [\'context\']) instead. (Heuristic: it can’t tell whether the request is used again.)')
  }
  return out
}

/** Lints every .ts, .tsx, .js, .mjs file under `dir` (skipping node_modules, dist and test folders, and symbolic links, which are never followed). Returns one pass finding when clean. */
export function lintDirectory(dir: string): Finding[] {
  const files: string[] = []
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (['node_modules', 'dist', '.git', 'test', 'tests', '__tests__'].includes(name)) continue
      const p = join(d, name)
      const st = lstatSync(p)
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) walk(p)
      else if (st.isFile() && /\.(tsx?|mjs|js)$/.test(name) && !/\.(test|spec|d)\.[tj]s$/.test(name)) files.push(p)
    }
  }
  walk(dir)
  const texts = files.map((f) => [f, readFileSync(f, 'utf8')] as const)
  // A constant imported from another file is followed only when its name is used once across the folder.
  const counts = new Map<string, number>()
  const shared = new Map<string, string>()
  for (const [, t] of texts) for (const [k, v] of collectObjects(stripComments(t))) (counts.set(k, (counts.get(k) ?? 0) + 1), shared.set(k, v))
  for (const [k, n] of counts) if (n > 1) shared.delete(k)
  const found = texts.flatMap(([f, t]) => lintSource(relative(dir, f), t, shared))
  return found.length ? found : [{ check: 'plugin-source-lint', title: 'Plugin source lint', severity: 'info', status: 'pass', role: 'code', path: '.', how: `Read ${files.length} file${files.length === 1 ? '' : 's'}; nothing to flag.` }]
}
