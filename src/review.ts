import type { Payload } from 'payload'

import type { Finding, Severity, Viewer } from './index.js'

/**
 * Checks for bug classes that human security review keeps finding in Payload plugins. They run from a plugin
 * repo's own test suite or CI against a Payload instance, with made-up users and records. Like the rest of
 * Whitehat they only look: a probe that was allowed is reported, and anything that couldn't be judged is
 * "not-checked", never "pass". Nothing here names a site, a plugin or a collection; the caller passes those in.
 *
 * Probes write on purpose (that is how a hole shows). Run them on a throwaway database, and give the checks a
 * `seed` or clean up afterwards.
 */

const statusOf = (e: unknown): number => Number((e as { status?: unknown })?.status ?? (e as { statusCode?: unknown })?.statusCode ?? NaN)
const clip = (s: string, n = 100) => (s.length > n ? `${s.slice(0, n)}…` : s)
const messageOf = (e: unknown): string => {
  const base = String((e as { message?: unknown })?.message ?? e)
  let data = ''
  try {
    const d = (e as { data?: unknown })?.data
    data = d === undefined ? '' : JSON.stringify(d)
  } catch {
    data = ''
  }
  return `${base}${data}`
}
const note = (check: string, title: string, role: string, how: string, path?: string, severity: Severity = 'high'): Finding => ({ check, title, severity, status: 'not-checked', role, path, how })

// ---------------------------------------------------------------------------------------------------------
// 1. Response-difference probe
// ---------------------------------------------------------------------------------------------------------

export type DifferenceOperation = {
  id: string
  title: string
  /** Does the write or read as this identity. Resolves with the response; a refusal throws. */
  run: (identity: Viewer) => Promise<unknown>
  /**
   * Optional. Reads state a caller could see afterwards: a row count, the rows, a history or event list. It runs
   * before and after `run` for each identity, and the change is compared. Return something that doesn't depend
   * on who is asking.
   */
  observe?: (identity: Viewer) => Promise<unknown>
  severity?: Severity
  reproduce?: string
}

type Outcome = { threw: boolean; status: number | null; message: string; shape: string; observed: string }

/** Ids, dates and long numbers differ between runs without meaning anything. */
const IDS = /\b[0-9a-f]{24}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\d{4}-\d{2}-\d{2}T[\d:.]+Z?|\b\d{9,}\b/gi

function shapeOf(v: unknown, depth = 0): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return depth > 6 ? '[]' : `[${v.length ? [...new Set(v.map((x) => shapeOf(x, depth + 1)))].sort().join('|') : ''}]`
  if (typeof v === 'object') {
    if (depth > 6) return '{}'
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${k}:${shapeOf((v as Record<string, unknown>)[k], depth + 1)}`)
      .join(',')}}`
  }
  return typeof v
}

const delta = (before: unknown, after: unknown): string => {
  if (typeof before === 'number' && typeof after === 'number') return `Δ${after - before}`
  const [a, b] = [JSON.stringify(before) ?? '', JSON.stringify(after) ?? '']
  return a === b ? 'unchanged' : b
}

/**
 * Runs each operation as two identities that differ in one property, and reports any difference a caller could
 * see: the error message, the status, the shape of what came back, or what changed in the state `observe` reads
 * (created rows, history, events). This is the oracle test: if a minor and an adult get different answers to the
 * same invite, the answer tells the caller which one is the minor.
 *
 * Each identity's own user id and the usual ids, dates and long numbers are masked before comparing; pass
 * `mask` to hide anything else that is meant to differ.
 */
export async function runResponseDifferenceProbe(input: { identities: [Viewer, Viewer]; operations: DifferenceOperation[]; mask?: (text: string) => string }): Promise<Finding[]> {
  const [a, b] = input.identities
  const out: Finding[] = []
  const pair = `${a.role} vs ${b.role}`
  if (!a || !b || a.role === b.role) return [note('response-difference', 'Responses don’t depend on who is asking', pair, 'Two identities with different roles are needed to compare answers.')]
  const own = (v: Viewer) => String((v.user as { id?: unknown } | null)?.id ?? '')
  const maskFor = (v: Viewer) => (text: string) => {
    let t = text
    const id = own(v)
    if (id.length >= 3) t = t.split(id).join('<id>')
    t = t.replace(IDS, '<x>')
    return input.mask ? input.mask(t) : t
  }
  for (const op of input.operations) {
    const severity = op.severity ?? 'high'
    const title = `${op.title}: both identities get the same answer`
    const outcomes: Outcome[] = []
    let broken: string | null = null
    for (const who of [a, b]) {
      const mask = maskFor(who)
      let before: unknown
      let after: unknown
      try {
        before = op.observe ? await op.observe(who) : undefined
      } catch (e) {
        broken = `observe failed: ${clip(messageOf(e), 80)}`
        break
      }
      let o: Outcome
      try {
        const res = await op.run(who)
        o = { threw: false, status: null, message: '', shape: mask(shapeOf(res)), observed: '' }
      } catch (e) {
        o = { threw: true, status: Number.isFinite(statusOf(e)) ? statusOf(e) : null, message: mask(messageOf(e)), shape: '', observed: '' }
      }
      try {
        after = op.observe ? await op.observe(who) : undefined
      } catch (e) {
        broken = `observe failed: ${clip(messageOf(e), 80)}`
        break
      }
      o.observed = op.observe ? mask(delta(before, after)) : ''
      outcomes.push(o)
    }
    if (broken || outcomes.length < 2) {
      out.push(note('response-difference', title, pair, broken ?? 'The probe could not run.', op.id, severity))
      continue
    }
    const [x, y] = outcomes as [Outcome, Outcome]
    if (x.threw && y.threw && (x.status ?? 0) >= 500 && (y.status ?? 0) >= 500) {
      out.push(note('response-difference', title, pair, 'Both answered with a server error, so the answers say nothing about access.', op.id, severity))
      continue
    }
    const diffs: string[] = []
    if (x.threw !== y.threw) diffs.push(`one was ${x.threw ? 'refused' : 'allowed'} and the other ${y.threw ? 'refused' : 'allowed'}`)
    if (x.status !== y.status) diffs.push(`status ${x.status ?? 'none'} vs ${y.status ?? 'none'}`)
    if (x.message !== y.message) diffs.push(`message "${clip(x.message)}" vs "${clip(y.message)}"`)
    if (x.shape !== y.shape) diffs.push('the returned data has a different shape')
    if (x.observed !== y.observed) diffs.push(`what a caller can read afterwards differs (${clip(x.observed, 40)} vs ${clip(y.observed, 40)})`)
    out.push({
      check: 'response-difference',
      title,
      severity,
      status: diffs.length ? 'fail' : 'pass',
      role: pair,
      path: op.id,
      how: diffs.length ? `The answer depends on the identity: ${diffs.join('; ')}.` : 'Both identities got the same status, message, shape and readable result.',
      reproduce: diffs.length ? (op.reproduce ?? 'Run the operation once as each identity and compare the two answers.') : undefined,
    })
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------
// 2. Settings that look on but aren't: transactions
// ---------------------------------------------------------------------------------------------------------

/**
 * A plugin that relies on transactions must refuse to run without them. Payload starts without transactions
 * when the database adapter is given `transactionOptions: false` (the adapter's `beginTransaction` then returns
 * null), and nothing warns: every write that expects to be atomic simply isn't.
 *
 * `start` boots the instance under test with transactions disabled. Either it refuses (throws), or a write that
 * relies on a transaction must refuse. A write that goes through is the finding. `refusal` says what a proper
 * refusal looks like; by default an error that mentions transactions. Any other error is "not checked".
 */
export async function runTransactionCheck(input: {
  start: () => Promise<{ payload: Payload; stop?: () => Promise<void> }>
  /** A write the plugin protects with a transaction, made on the instance `start` returned. */
  write: (payload: Payload) => Promise<unknown>
  refusal?: RegExp
  severity?: Severity
}): Promise<Finding[]> {
  const sev = input.severity ?? 'high'
  const check = 'transactions-required'
  const title = 'A plugin that needs transactions refuses to run without them'
  const refusal = input.refusal ?? /transaction/i
  const role = 'server'
  let started: Awaited<ReturnType<typeof input.start>> | undefined
  try {
    try {
      started = await input.start()
    } catch (e) {
      const said = messageOf(e)
      return refusal.test(said)
        ? [{ check, title, severity: sev, status: 'pass', role, path: 'start-up', how: 'It refused to start without transactions.' }]
        : [note(check, title, role, `Start-up failed for another reason: ${clip(said, 120)}`, 'start-up', sev)]
    }
    const { payload } = started
    const begin = (payload.db as { beginTransaction?: () => Promise<unknown> }).beginTransaction
    let id: unknown = null
    if (begin) {
      id = await begin.call(payload.db)
      if (id) {
        await (payload.db as { rollbackTransaction?: (i: unknown) => Promise<void> }).rollbackTransaction?.(id)
        return [note(check, title, role, 'Transactions are on in this instance, so nothing was learned. Start it with the database adapter’s transactionOptions set to false.', 'start-up', sev)]
      }
    }
    try {
      await input.write(payload)
    } catch (e) {
      const said = messageOf(e)
      return refusal.test(said)
        ? [{ check, title, severity: sev, status: 'pass', role, path: 'write', how: 'The write was refused because transactions are off.' }]
        : [note(check, title, role, `The write failed for another reason: ${clip(said, 120)}`, 'write', sev)]
    }
    return [{ check, title, severity: sev, status: 'fail', role, path: 'write', how: 'Transactions are off (beginTransaction answered null) and a write that relies on one still succeeded: the setting looks on but isn’t.', reproduce: 'Start Payload with the Mongo adapter’s transactionOptions: false, then make the protected write.' }]
  } finally {
    await started?.stop?.().catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------------------------------------
// 3. Server-code back doors
// ---------------------------------------------------------------------------------------------------------

export type ProtectedCollection = {
  slug: string
  /** Someone who must not be able to change or remove the protected rows. */
  identity: Viewer
  /** Matches only the rows `identity` must not touch. */
  protectedWhere: Record<string, unknown>
  /** A change to those rows that must be refused (a field the plugin guards). */
  data: Record<string, unknown>
  /**
   * Set when the plugin's rule is meant to hold even for server code that skips access (`overrideAccess: true`),
   * because it lives in a hook. Leave it off for rules that are only access functions.
   */
  holdsForServerCode?: boolean
  /** Puts the protected rows back; runs before every probe, since a probe that works changes them. */
  seed: () => Promise<void>
}

/**
 * For each protected collection: bulk update and bulk delete with a `where`, the same by id with
 * `disableTransaction: true`, and (when `holdsForServerCode`) with `overrideAccess: true`. Bulk operations
 * answer with `{ docs, errors }` instead of throwing, so a rule that only guards single writes lets them through.
 */
export async function runServerBackDoorCheck(payload: Payload, collections: ProtectedCollection[]): Promise<Finding[]> {
  const out: Finding[] = []
  for (const c of collections) {
    const role = c.identity.role
    const base = { collection: c.slug as never, user: c.identity.user as never }
    const probes: { id: string; title: string; run: (id: string | number) => Promise<boolean> }[] = [
      { id: 'bulk-update', title: 'Bulk update with a where', run: async () => ((await payload.update({ ...base, where: c.protectedWhere as never, data: c.data as never, overrideAccess: false })) as { docs: unknown[] }).docs.length > 0 },
      { id: 'bulk-delete', title: 'Bulk delete with a where', run: async () => ((await payload.delete({ ...base, where: c.protectedWhere as never, overrideAccess: false })) as { docs: unknown[] }).docs.length > 0 },
      { id: 'update-no-transaction', title: 'Update by id with disableTransaction', run: async (id) => !!(await payload.update({ ...base, id, data: c.data as never, overrideAccess: false, disableTransaction: true })) },
      { id: 'delete-no-transaction', title: 'Delete by id with disableTransaction', run: async (id) => !!(await payload.delete({ ...base, id, overrideAccess: false, disableTransaction: true })) },
    ]
    if (c.holdsForServerCode) {
      probes.push(
        { id: 'update-override-access', title: 'Update by id with overrideAccess', run: async (id) => !!(await payload.update({ ...base, id, data: c.data as never, overrideAccess: true })) },
        { id: 'delete-override-access', title: 'Delete by id with overrideAccess', run: async (id) => !!(await payload.delete({ ...base, id, overrideAccess: true })) },
      )
    }
    for (const p of probes) {
      const check = 'server-code-back-door'
      const title = `${c.slug}: ${p.title} is refused`
      const path = `${c.slug} · ${p.id}`
      try {
        await c.seed()
        const found = await payload.find({ collection: c.slug as never, where: c.protectedWhere as never, limit: 1, depth: 0, pagination: false, overrideAccess: true })
        const row = (found.docs[0] as { id?: string | number } | undefined)?.id
        if (row === undefined) {
          out.push(note(check, title, role, 'After seeding, no row matched protectedWhere, so there was nothing to try.', path))
          continue
        }
        let allowed: boolean
        try {
          allowed = await p.run(row)
        } catch {
          allowed = false
        }
        out.push({
          check,
          title,
          severity: 'high',
          status: allowed ? 'fail' : 'pass',
          role,
          path,
          how: allowed ? `The rule was skipped: ${p.title.toLowerCase()} changed a protected row.` : 'Refused, or nothing was changed.',
          reproduce: allowed ? `From server code, call payload.${p.id.includes('delete') ? 'delete' : 'update'} on ${c.slug} as that user (${p.id}).` : undefined,
        })
      } catch (e) {
        out.push(note(check, title, role, `The probe could not run: ${clip(messageOf(e), 120)}`, path))
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------
// 4. Host rules that replace defaults
// ---------------------------------------------------------------------------------------------------------

export type HostRuleOption = {
  /** The option's name, for the report. */
  id: string
  /**
   * Installs the host's answer as that option's value: return the answer from the hook, or throw it. A function
   * answer is handed to you already wrapped. Called with `undefined` first, for the plugin's own default.
   */
  install: (answer: HostAnswer | undefined) => void | Promise<void>
  /** Does the operation the plugin's default restricts, as someone the default refuses. Resolves if allowed; a refusal throws. */
  attempt: () => Promise<unknown>
  /**
   * Which answers may change the outcome. Default `['true']`: only an exact true (or a function returning one)
   * counts as yes. List `'where'` too when a narrow where is a real way for the host to widen this option.
   */
  mayWiden?: HostAnswerName[]
  /** Puts the instance back after each attempt. */
  restore?: () => Promise<void>
}
export type HostAnswerName = 'true' | 'empty-object' | 'null' | 'zero' | 'empty-string' | 'throw' | 'where'
export type HostAnswer = { name: HostAnswerName; value: unknown; throws?: boolean }
export const HOST_ANSWERS: HostAnswer[] = [
  { name: 'true', value: true },
  { name: 'empty-object', value: {} },
  { name: 'null', value: null },
  { name: 'zero', value: 0 },
  { name: 'empty-string', value: '' },
  { name: 'throw', value: new Error('host hook failed'), throws: true },
  { name: 'where', value: { id: { equals: 'a-narrow-filter' } } },
]

/**
 * Feeds each kind of host answer into a host-supplied rule and checks the plugin's defaults still hold. The
 * default outcome is measured first (`install(undefined)`). After that, only the answers in `mayWiden` may turn
 * a refusal into an allow. `{}`, null, 0, an empty string, a thrown error and a narrow where must all leave the
 * refusal in place: only an exact `true` or a function counts as yes, and a host rule can only widen within the
 * plugin's defaults.
 */
export async function runHostRuleCheck(options: HostRuleOption[]): Promise<Finding[]> {
  const out: Finding[] = []
  const attempt = async (o: HostRuleOption): Promise<'allowed' | 'refused'> => {
    try {
      await o.attempt()
      return 'allowed'
    } catch {
      return 'refused'
    } finally {
      await o.restore?.()
    }
  }
  for (const o of options) {
    const check = 'host-rule-replaces-default'
    const role = 'host'
    try {
      await o.install(undefined)
      const baseline = await attempt(o)
      if (baseline === 'allowed') {
        out.push(note(check, `${o.id}: the default restriction holds`, role, 'The operation was allowed with no host rule at all, so there is no default restriction to test.', o.id))
        continue
      }
      const widen = new Set<HostAnswerName>(o.mayWiden ?? ['true'])
      for (const answer of HOST_ANSWERS) {
        const title = `${o.id}: a host answer of ${answer.name} keeps the default restriction`
        await o.install(answer)
        const result = await attempt(o)
        const wrong = result === 'allowed' && !widen.has(answer.name)
        out.push({
          check,
          title,
          severity: 'high',
          status: wrong ? 'fail' : 'pass',
          role,
          path: `${o.id} · ${answer.name}`,
          how: wrong ? `A host answer of ${answer.name} switched a default restriction off.` : result === 'allowed' ? `${answer.name} is allowed to widen this option, and did.` : 'The default restriction still applied.',
          reproduce: wrong ? `Make the host's ${o.id} option answer ${answer.name === 'throw' ? 'by throwing' : answer.name} and repeat the operation.` : undefined,
        })
      }
    } catch (e) {
      out.push(note(check, `${o.id}: the default restriction holds`, role, `The probe could not run: ${clip(messageOf(e), 120)}`, o.id))
    } finally {
      await o.install(undefined)
    }
  }
  return out
}
