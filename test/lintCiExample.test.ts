import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { afterAll, describe, expect, it } from 'vitest'

import { formatReport, lintDirectory } from '../src/index.js'

// Runs the CI test that docs/review-checks.md tells plugin repos to copy, exactly as written there.
type Allowed = { file: string; rule: string; line: string; reason: string }

const doc = readFileSync(new URL('../docs/review-checks.md', import.meta.url), 'utf8')
const block = /## Running the lint in CI[\s\S]*?```ts\n([\s\S]*?)```/.exec(doc)![1]!
const swap = (text: string, from: string | RegExp, to: string) => {
  const out = text.replace(from, to)
  if (out === text) throw new Error(`The example no longer holds ${from}`)
  return out
}
let body = swap(block, /^import .*\n/gm, '')
body = swap(body, "fileURLToPath(new URL('../src', import.meta.url))", 'ROOT')
body = swap(body, /^const ALLOWED: .*= \[\]$/m, '')
const script = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

const run = (root: string, allowed: Allowed[]) => {
  let test: (() => void) | undefined
  const register = (_name: string, fn: () => void) => (test = fn)
  new Function('ROOT', 'ALLOWED', 'it', 'expect', 'readFileSync', 'join', 'formatReport', 'lintDirectory', script)(root, allowed, register, expect, readFileSync, join, formatReport, lintDirectory)
  test!()
}

const dirs: string[] = []
const folder = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), 'whitehat-ci-'))
  dirs.push(dir)
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  return dir
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

// Made-up fixture code.
const LINE = 'if (!crate.allows(1)) return'
const open = (name: string, ...body: string[]) => [`export function ${name}(crate) {`, ...body.map((l) => `  ${l}`), '}', ''].join('\n')
const entry: Allowed = { file: 'crate.ts', rule: 'truthy-host-answer', line: LINE, reason: 'A made-up reason' }
const one = () => folder({ 'crate.ts': open('a', LINE) })
const two = () => folder({ 'crate.ts': open('a', LINE) + open('b', `  ${LINE}`) })

describe('the copyable CI test in docs/review-checks.md', () => {
  it('passes clean source, and a hit with its own entry', () => {
    expect(() => run(folder({ 'a.ts': 'export const a = 1\n' }), [])).not.toThrow()
    expect(() => run(one(), [entry])).not.toThrow()
    // One entry for each of two identical hits; indentation doesn't count.
    expect(() => run(two(), [entry, entry])).not.toThrow()
  })
  it('fails a hit with no entry, and any other hit beside an allowed one', () => {
    expect(() => run(one(), [])).toThrow()
    const dir = folder({ 'crate.ts': open('a', LINE), 'other.ts': open('b', 'if (!crate.permits(1)) return') })
    expect(() => run(dir, [entry])).toThrow(/other\.ts:2/)
  })
  it('fails a second identical hit beyond what is allowed', () => {
    expect(() => run(two(), [entry])).toThrow(/crate\.ts:5/)
  })
  it('fails an entry that no longer matches', () => {
    expect(() => run(folder({ 'a.ts': 'export const a = 1\n' }), [entry])).toThrow(/match no hit/)
    expect(() => run(one(), [entry, entry])).toThrow(/match no hit/)
  })
  it('needs the same file, rule and line text, and a reason', () => {
    for (const wrong of [{ file: 'else.ts' }, { rule: 'context-on-shared-req' }, { line: 'if (!crate.allows(2)) return' }, { line: 'crate.allows' }, { reason: ' ' }])
      expect(() => run(one(), [{ ...entry, ...wrong }]), JSON.stringify(wrong)).toThrow()
    // The line was edited after it was allowed.
    expect(() => run(folder({ 'crate.ts': open('a', 'if (!crate.allows(1) || force) return') }), [entry])).toThrow()
  })
  it('fails a not-checked run, which is what reading no files gives', () => {
    expect(() => run(folder({}), [])).toThrow(/Read 0 source files/)
    expect(() => run(folder({ 'notes.md': 'x' }), [entry])).toThrow()
  })
})
