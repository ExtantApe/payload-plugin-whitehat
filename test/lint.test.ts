import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { lintDirectory, lintSource, stripComments } from '../src/index.js'

const hits = (src: string) => lintSource('hook.ts', src).map((f) => `${f.check} ${f.path}`)

describe('5. static lint', () => {
  it('flags a host answer used as any truthy value, and names the line', () => {
    const src = ['export const hook = async ({ req }) => {', '  if (await options.canInvite(req)) return', '}'].join('\n')
    expect(hits(src)).toEqual(['truthy-host-answer hook.ts:2'])
  })
  it('flags a stored answer that is later tested for truth, a negation, and a ternary', () => {
    expect(hits('const ok = await options.access(req)\nif (ok) go()')).toEqual(['truthy-host-answer hook.ts:1'])
    expect(hits('const v = await opts.vetoInvite(id)\nif (!v) go()')).toEqual(['truthy-host-answer hook.ts:1'])
    expect(hits('const ok = await config.allowOutside(id)\nreturn ok ? a : b')).toEqual(['truthy-host-answer hook.ts:1'])
    expect(hits('if (!(await options.canInvite(req))) throw new Error()')).toEqual(['truthy-host-answer hook.ts:1'])
  })
  it('stays quiet when the answer is compared with exactly true, or is only in a comment', () => {
    expect(hits('if ((await options.canInvite(req)) === true) return')).toEqual([])
    expect(hits('const ok = await options.access(req)\nif (ok === true) go()')).toEqual([])
    expect(hits('// if (await options.canInvite(req)) return\n/* if (options.access(req)) */')).toEqual([])
  })
  it('flags a paginated find with req in a hook, and stays quiet with pagination: false or findByID', () => {
    const hook = (call: string) => `export const hooks = { beforeChange: [async ({ req }) => {\n  ${call}\n}] }`
    expect(hits(hook("await req.payload.find({ collection: 'x', where: w, req })"))).toEqual(['paginated-find-in-transaction hook.ts:2'])
    expect(hits(hook("await req.payload.find({ collection: 'x', where: w, req, pagination: false })"))).toEqual([])
    expect(hits(hook("await req.payload.findByID({ collection: 'x', id, req })"))).toEqual([])
    expect(hits(hook("await req.payload.find({ collection: 'x', where: w })"))).toEqual([])
  })
  it('reads helper files with no hook names in them', () => {
    expect(hits("export const first = (payload, req) => payload.find({ collection: 'x', req })")).toEqual(['paginated-find-in-transaction hook.ts:1'])
  })
  it('skips a find that follows another query in the same function, and flags one that follows a query in another function', () => {
    const after = "export const h = async ({ req }) => {\n  await req.payload.findByID({ collection: 'a', id, req })\n  await req.payload.find({ collection: 'x', limit: 1, req })\n}"
    expect(hits(after)).toEqual([])
    const other = "const a = async (req) => {\n  await req.payload.findByID({ collection: 'a', id, req })\n}\nconst b = async (req) => {\n  await req.payload.find({ collection: 'x', req })\n}"
    expect(hits(other)).toEqual(['paginated-find-in-transaction hook.ts:5'])
  })
  it('keeps line numbers across comments', () => {
    const s = stripComments('a\n/* one\ntwo */\nb // tail\nc')
    expect(s.split('\n')).toHaveLength(5)
    expect(s.split('\n')[3]!.trim()).toBe('b')
  })

  const dirs: string[] = []
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))
  it('reads a folder, skips tests and node_modules, and reports one pass when clean', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whitehat-lint-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'src'))
    mkdirSync(join(dir, 'node_modules'))
    writeFileSync(join(dir, 'src', 'a.ts'), 'if (await options.canInvite(req)) return\n')
    writeFileSync(join(dir, 'src', 'a.test.ts'), 'if (await options.canInvite(req)) return\n')
    writeFileSync(join(dir, 'node_modules', 'b.js'), 'if (await options.canInvite(req)) return\n')
    expect(lintDirectory(dir).map((f) => f.path)).toEqual([join('src', 'a.ts') + ':1'])
    writeFileSync(join(dir, 'src', 'a.ts'), 'if ((await options.canInvite(req)) === true) return\n')
    expect(lintDirectory(dir)).toMatchObject([{ status: 'pass', severity: 'info' }])
  })
})
