import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { lintDirectory, lintSource } from '../src/index.js'

// All fixture code here is made up.
const hits = (src: string) => lintSource('shape.ts', src).map((f) => f.check)
const lines = (...l: string[]) => l.join('\n')

const dirs: string[] = []
const folder = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), 'whitehat-shapes-'))
  dirs.push(dir)
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  return dir
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

describe('lint: a folder with no source files', () => {
  it('is not-checked, never a pass', () => {
    expect(lintDirectory(folder({}))).toMatchObject([{ status: 'not-checked', path: '.' }])
    const dir = folder({ 'readme.md': '# crates', 'crate.test.ts': 'export const a = 1\n', 'types.d.ts': 'export type A = 1\n' })
    mkdirSync(join(dir, 'node_modules'))
    writeFileSync(join(dir, 'node_modules', 'x.js'), 'export const a = 1\n')
    expect(lintDirectory(dir)).toMatchObject([{ status: 'not-checked' }])
  })
  it('still passes a clean folder that has source', () => {
    expect(lintDirectory(folder({ 'a.ts': 'export const a = 1\n' }))).toMatchObject([{ status: 'pass' }])
  })
})

// Code that looks safe from its text can still be unsafe, so the lint flags these and skips none of them.
const meter = lines('export class Meter {', '  allows(n: number) {', '    return n < 3', '  }', '}')
const sweep = lines('export function sweep() {', '  const meter = new Meter()', '  if (!meter.allows(1)) return', '}')
const swapped = (swap: string) => lines(meter, sweep.replace('  if (', `  ${swap}\n  if (`))
const endpoint = (method: string, ...body: string[]) =>
  lines('export const listCrates = {', "  path: '/crates',", `  ${method}`, '  handler: async (req) => {', ...body, '  },', '}')
const PAGED = "    return Response.json(await req.payload.find({ collection: 'crates', page: 1, req }))"

describe('lint: code that only looks safe is still flagged', () => {
  const asks = (src: string) => expect(hits(src)).toContain('truthy-host-answer')
  const pages = (src: string) => expect(hits(src)).toContain('paginated-find-in-transaction')

  it('flags a method with the host-hook name, even on the plugin’s own class', () => asks(lines(meter, sweep)))
  it('flags it after a bracket reassignment', () => asks(swapped("meter['allows'] = host.allows")))
  it('flags it after defineProperty', () => asks(swapped("Object.defineProperty(meter, 'allows', { value: host.allows })")))
  it('flags it after Object.assign', () => asks(swapped('Object.assign(meter, host)')))
  it('flags it when the type is a same-named one from another import', () => {
    const dir = folder({
      'meter.ts': lines(meter, 'export const own = new Meter()'),
      'use.ts': lines("import type { Meter } from './host.js'", 'export function f(meter: Meter) {', '  if (!meter.allows(1)) return', '}'),
    })
    expect(lintDirectory(dir)).toMatchObject([{ check: 'truthy-host-answer', path: 'use.ts:3' }])
  })

  it('flags a paged find in a GET endpoint', () => pages(endpoint("method: 'get',", PAGED)))
  it('flags a find inside a callback that was given req', () =>
    pages(endpoint("method: 'get',", "    return atomically(req, () => req.payload.find({ collection: 'crates', page: 1, req }))")))
  it('flags it when a spread can replace method: get', () => pages(endpoint("method: 'get',\n  ...overrides,", PAGED)))
  it('flags it when a brace inside a string comes before a write', () =>
    pages(endpoint("method: 'get',", "    const close = '}'", PAGED.replace('return', 'const found ='), "    await req.payload.update({ collection: 'crates', id: 1, data: { close }, req })")))
})
