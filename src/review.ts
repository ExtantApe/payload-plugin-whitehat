import type { Payload } from 'payload'

import type { Finding, Severity, Viewer } from './index.js'

/**
 * Checks for bug classes that human security review keeps finding in Payload plugins. They run from a plugin
 * repo's own test suite or CI against a Payload instance, with made-up users and records. Like the rest of
 * Whitehat they report and never fix, and a probe that couldn't be judged is "not-checked". Only a recognized
 * refusal (see `isRefusal`) counts as refused: any other error, such as a transaction failure or a wrong
 * collection slug, is "not-checked". Nothing here names a site, a plugin or a collection; the caller passes
 * those in.
 *
 * Probes write on purpose (that is how a hole shows): they try to create, change and delete rows, and a probe
 * that works leaves the change behind. Run them on a throwaway database, and give the checks a `seed` or clean up.
 */

const statusOf = (e: unknown): number => Number((e as { status?: unknown })?.status ?? (e as { statusCode?: unknown })?.statusCode ?? NaN)

/** Statuses and error names that mean "the system said no": validation, sign-in, forbidden and not found. */
const REFUSAL_STATUSES = [400, 401, 403, 404, 422]
const REFUSAL_NAMES = ['Forbidden', 'UnauthorizedError', 'ValidationError', 'NotFound']
/**
 * Whether an error is a proper refusal. HTTP 400, 401, 403, 404 or 422, or Payload's Forbidden, UnauthorizedError,
 * ValidationError and NotFound. A plain Error, a database error such as NoSuchTransaction, or a 5xx is not.
 * Callers can pass their own `isRefusal` where the site refuses some other way.
 */
export function isRefusal(error: unknown): boolean {
  return REFUSAL_STATUSES.includes(statusOf(error)) || REFUSAL_NAMES.includes(String((error as { name?: unknown })?.name))
}
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

type Outcome = { threw: boolean; refused: boolean; status: number | null; message: string; shape: string; value: string; observed: string }

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

const json = (v: unknown): string => {
  try {
    return JSON.stringify(v) ?? 'undefined'
  } catch {
    return '[unserializable]'
  }
}

const delta = (before: unknown, after: unknown): string => {
  if (typeof before === 'number' && typeof after === 'number') return `Δ${after - before}`
  const [a, b] = [json(before), json(after)]
  return a === b ? 'unchanged' : b
}

/**
 * Runs each operation as two identities that differ in one property, and reports any difference a caller could
 * see: whether it was allowed, the error message, the status, the shape and the values of what came back (a count
 * of 1 against 0, a flag true against false), or what changed in the state `observe` reads (created rows,
 * history, events). This is the oracle test: if a minor and an adult get different answers to the same invite,
 * the answer tells the caller which one is the minor.
 *
 * Each identity's own user id and the usual ids, dates and long numbers are masked before comparing; pass
 * `mask` to hide anything else that is meant to differ. An error that isn't a recognized refusal (see
 * `isRefusal`), including the same crash for both, says nothing about access and is "not-checked".
 */
export async function runResponseDifferenceProbe(input: { identities: [Viewer, Viewer]; operations: DifferenceOperation[]; mask?: (text: string) => string; isRefusal?: (error: unknown) => boolean }): Promise<Finding[]> {
  const [a, b] = input.identities
  const out: Finding[] = []
  const pair = `${a?.role} vs ${b?.role}`
  if (!a || !b || a.role === b.role) return [note('response-difference', 'Responses don’t depend on who is asking', pair, 'Two identities with different roles are needed to compare answers.')]
  const refusal = input.isRefusal ?? isRefusal
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
        o = { threw: false, refused: false, status: null, message: '', shape: mask(shapeOf(res)), value: mask(json(res)), observed: '' }
      } catch (e) {
        o = { threw: true, refused: refusal(e), status: Number.isFinite(statusOf(e)) ? statusOf(e) : null, message: mask(messageOf(e)), shape: '', value: '', observed: '' }
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
    const crashed = [x, y].find((o) => o.threw && !o.refused)
    if (crashed) {
      out.push(note('response-difference', title, pair, `An answer was an error that isn’t a refusal (${clip(crashed.message, 80)}), so it says nothing about access.`, op.id, severity))
      continue
    }
    const diffs: string[] = []
    if (x.threw !== y.threw) diffs.push(`one was ${x.threw ? 'refused' : 'allowed'} and the other ${y.threw ? 'refused' : 'allowed'}`)
    if (x.status !== y.status) diffs.push(`status ${x.status ?? 'none'} vs ${y.status ?? 'none'}`)
    if (x.message !== y.message) diffs.push(`message "${clip(x.message)}" vs "${clip(y.message)}"`)
    if (x.shape !== y.shape) diffs.push('the returned data has a different shape')
    else if (x.value !== y.value) diffs.push(`the returned values differ (${clip(x.value, 40)} vs ${clip(y.value, 40)})`)
    if (x.observed !== y.observed) diffs.push(`what a caller can read afterwards differs (${clip(x.observed, 40)} vs ${clip(y.observed, 40)})`)
    out.push({
      check: 'response-difference',
      title,
      severity,
      status: diffs.length ? 'fail' : 'pass',
      role: pair,
      path: op.id,
      how: diffs.length ? `The answer depends on the identity: ${diffs.join('; ')}.` : 'Both identities got the same status, message, shape, values and readable result.',
      reproduce: diffs.length ? (op.reproduce ?? 'Run the operation once as each identity and compare the two answers.') : undefined,
    })
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------
// 2. Settings that look on but aren't: transactions
// ---------------------------------------------------------------------------------------------------------

/** Mongo's own complaints about transactions are not the plugin refusing. */
const DEFAULT_TX_REFUSAL = (said: string) => /transaction/i.test(said) && !/NoSuchTransaction|Transaction numbers are only allowed|replica set|TransientTransactionError|WriteConflict/i.test(said)

/**
 * A plugin that relies on transactions must refuse to run without them. Payload starts without transactions
 * when the database adapter is given `transactionOptions: false` (the adapter's `beginTransaction` then returns
 * null), and nothing warns: every write that expects to be atomic simply isn't.
 *
 * Two modes:
 * - `off-at-start` (default). `start` boots the instance with transactions disabled. Either it refuses (throws),
 *   or a write that relies on a transaction must refuse. A write that goes through is the finding.
 * - `null-after-start`. `start` boots a normal instance; the check then makes `beginTransaction` answer null
 *   for the writes only. A guard that checks transactions once at start-up passes start-up and is caught here,
 *   as is a guard that reads `req.transactionID` without awaiting it.
 *
 * `refusal` says what a proper refusal looks like; by default an error that mentions transactions but isn't
 * one of Mongo's own (NoSuchTransaction, "Transaction numbers are only allowed on a replica set member").
 * Any other error is "not checked".
 */
export async function runTransactionCheck(input: {
  start: () => Promise<{ payload: Payload; stop?: () => Promise<void> }>
  /** A write the plugin protects with a transaction, made on the instance `start` returned. */
  write: (payload: Payload) => Promise<unknown>
  mode?: 'off-at-start' | 'null-after-start'
  refusal?: RegExp | ((said: string) => boolean)
  severity?: Severity
}): Promise<Finding[]> {
  const sev = input.severity ?? 'high'
  const mode = input.mode ?? 'off-at-start'
  const check = 'transactions-required'
  const title = mode === 'off-at-start' ? 'A plugin that needs transactions refuses to run without them' : 'A plugin that needs transactions refuses a write when beginTransaction answers null'
  const refuses = (said: string) => (input.refusal instanceof RegExp ? input.refusal.test(said) : (input.refusal ?? DEFAULT_TX_REFUSAL)(said))
  const role = 'server'
  let started: Awaited<ReturnType<typeof input.start>> | undefined
  let restore: (() => void) | undefined
  try {
    try {
      started = await input.start()
    } catch (e) {
      const said = messageOf(e)
      if (mode === 'off-at-start' && refuses(said)) return [{ check, title, severity: sev, status: 'pass', role, path: 'start-up', how: 'It refused to start without transactions.' }]
      return [note(check, title, role, `Start-up failed for another reason: ${clip(said, 120)}`, 'start-up', sev)]
    }
    const { payload } = started
    const db = payload.db as unknown as { beginTransaction?: () => Promise<unknown>; rollbackTransaction?: (i: unknown) => Promise<void> }
    if (mode === 'off-at-start') {
      try {
        const id = db.beginTransaction ? await db.beginTransaction() : null
        if (id) {
          await db.rollbackTransaction?.(id)
          return [note(check, title, role, 'Transactions are on in this instance, so nothing was learned. Start it with the database adapter’s transactionOptions set to false.', 'start-up', sev)]
        }
      } catch (e) {
        return [note(check, title, role, `beginTransaction threw: ${clip(messageOf(e), 120)}`, 'start-up', sev)]
      }
    } else {
      const original = db.beginTransaction
      if (!original) return [note(check, title, role, 'This database adapter has no beginTransaction to replace.', 'start-up', sev)]
      db.beginTransaction = async () => null
      restore = () => void (db.beginTransaction = original)
    }
    try {
      await input.write(payload)
    } catch (e) {
      const said = messageOf(e)
      return refuses(said)
        ? [{ check, title, severity: sev, status: 'pass', role, path: 'write', how: 'The write was refused because transactions are off.' }]
        : [note(check, title, role, `The write failed for another reason: ${clip(said, 120)}`, 'write', sev)]
    }
    return [{ check, title, severity: sev, status: 'fail', role, path: 'write', how: 'beginTransaction answered null and a write that relies on a transaction still succeeded: the setting looks on but isn’t.', reproduce: 'Start Payload with the Mongo adapter’s transactionOptions: false (or make beginTransaction answer null), then make the protected write.' }]
  } finally {
    restore?.()
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
  /** Optional. A create that must be refused for `identity` (probed with `disableTransaction`, and with `overrideAccess` when `holdsForServerCode`). */
  create?: Record<string, unknown>
  /**
   * Set when the plugin's rule is meant to hold even for server code that skips access (`overrideAccess: true`,
   * no user), because it lives in a hook. Leave it off for rules that are only access functions.
   */
  holdsForServerCode?: boolean
  /** Puts the protected rows back; runs before every probe, since a probe that works changes them. */
  seed: () => Promise<void>
}

/** Mongo's own failures that a bulk operation reports in `errors` instead of throwing. */
const INFRA = /transaction|mongo|econn|timed? ?out|socket|topology/i

/**
 * For each protected collection: bulk update and bulk delete with a `where`, update, delete and (with `create`)
 * create with `disableTransaction: true`, and, when `holdsForServerCode`, the same with `overrideAccess: true`
 * plus bulk update and delete as server code (`overrideAccess: true`, no user). Bulk operations answer with
 * `{ docs, errors }` instead of throwing, so a rule that only guards single writes, or that commits one document
 * at a time, lets them through.
 *
 * Only a recognized refusal passes (see `isRefusal`). Any other error, and bulk errors that name the database,
 * are "not-checked".
 */
export async function runServerBackDoorCheck(payload: Payload, collections: ProtectedCollection[], options: { isRefusal?: (error: unknown) => boolean } = {}): Promise<Finding[]> {
  const out: Finding[] = []
  const refusal = options.isRefusal ?? isRefusal
  type Result = { docs?: unknown[]; errors?: { message?: string }[] }
  for (const c of collections) {
    const role = c.identity.role
    const base = { collection: c.slug as never, user: c.identity.user as never }
    const server = { collection: c.slug as never, overrideAccess: true as const }
    const bulk = (r: unknown): boolean => {
      const res = r as Result
      if ((res.docs?.length ?? 0) > 0) return true
      const infra = res.errors?.find((e) => INFRA.test(String(e.message)))
      if (infra) throw Object.assign(new Error(`bulk operation error: ${clip(String(infra.message), 80)}`), { crash: true })
      return false
    }
    const probes: { id: string; title: string; run: (id: string | number) => Promise<boolean>; delete?: boolean }[] = [
      { id: 'bulk-update', title: 'Bulk update with a where', run: async () => bulk(await payload.update({ ...base, where: c.protectedWhere as never, data: c.data as never, overrideAccess: false })) },
      { id: 'bulk-delete', title: 'Bulk delete with a where', delete: true, run: async () => bulk(await payload.delete({ ...base, where: c.protectedWhere as never, overrideAccess: false })) },
      { id: 'update-no-transaction', title: 'Update by id with disableTransaction', run: async (id) => !!(await payload.update({ ...base, id, data: c.data as never, overrideAccess: false, disableTransaction: true })) },
      { id: 'delete-no-transaction', title: 'Delete by id with disableTransaction', delete: true, run: async (id) => !!(await payload.delete({ ...base, id, overrideAccess: false, disableTransaction: true })) },
    ]
    if (c.create) probes.push({ id: 'create-no-transaction', title: 'Create with disableTransaction', run: async () => !!(await payload.create({ ...base, data: c.create as never, overrideAccess: false, disableTransaction: true })) })
    if (c.holdsForServerCode) {
      probes.push(
        { id: 'update-override-access', title: 'Update by id with overrideAccess', run: async (id) => !!(await payload.update({ ...base, id, data: c.data as never, overrideAccess: true })) },
        { id: 'delete-override-access', title: 'Delete by id with overrideAccess', delete: true, run: async (id) => !!(await payload.delete({ ...base, id, overrideAccess: true })) },
      )
      if (c.create) probes.push({ id: 'create-override-access', title: 'Create with overrideAccess', run: async () => !!(await payload.create({ ...base, data: c.create as never, overrideAccess: true })) })
      probes.push(
        { id: 'bulk-update-server-code', title: 'Bulk update from server code (no user, overrideAccess)', run: async () => bulk(await payload.update({ ...server, where: c.protectedWhere as never, data: c.data as never })) },
        { id: 'bulk-delete-server-code', title: 'Bulk delete from server code (no user, overrideAccess)', delete: true, run: async () => bulk(await payload.delete({ ...server, where: c.protectedWhere as never })) },
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
        } catch (e) {
          if ((e as { crash?: boolean }).crash || !refusal(e)) {
            out.push(note(check, title, role, `The probe failed with an error that isn’t a refusal: ${clip(messageOf(e), 120)}`, path))
            continue
          }
          allowed = false
        }
        out.push({
          check,
          title,
          severity: 'high',
          status: allowed ? 'fail' : 'pass',
          role,
          path,
          how: allowed ? `The rule was skipped: ${p.title.toLowerCase()} got through.` : 'Refused, or nothing was changed.',
          reproduce: allowed ? `From server code, call payload.${p.id.includes('delete') ? 'delete' : p.id.includes('create') ? 'create' : 'update'} on ${c.slug} (${p.id}).` : undefined,
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

export type HostAnswerName = 'true' | 'empty-object' | 'null' | 'zero' | 'empty-string' | 'throw' | 'where' | 'one' | 'yes-string' | 'empty-array' | 'false' | 'undefined' | 'function'
export type HostAnswer = { name: HostAnswerName; value: unknown; throws?: boolean }
export const HOST_ANSWERS: HostAnswer[] = [
  { name: 'true', value: true },
  { name: 'empty-object', value: {} },
  { name: 'null', value: null },
  { name: 'zero', value: 0 },
  { name: 'empty-string', value: '' },
  { name: 'throw', value: new Error('host hook failed'), throws: true },
  { name: 'where', value: { id: { equals: 'a-narrow-filter' } } },
  { name: 'one', value: 1 },
  { name: 'yes-string', value: 'yes' },
  { name: 'empty-array', value: [] },
  { name: 'false', value: false },
  { name: 'undefined', value: undefined },
  { name: 'function', value: () => true },
]

export type HostRuleOption = {
  /** The option's name, for the report. */
  id: string
  /**
   * `access` (default): the option can widen what the plugin allows. The attempt is something the default
   * refuses, and only the answers in `mayWiden` may change that.
   * `veto`: the option can refuse something the plugin allows. The attempt is something the default allows.
   * An exact `true` must refuse it, and so must a throw (a broken veto fails closed). The other answers
   * (null, 0, an empty string, false, undefined and so on) mean go ahead or are the plugin's choice, so any
   * allow or refusal is accepted for them; only a crash is flagged.
   */
  kind?: 'access' | 'veto'
  /**
   * Installs the host's answer as that option's value: return the answer from the hook, or throw it when
   * `answer.throws`. Called with `undefined` first and last, for the plugin's own default.
   */
  install: (answer: HostAnswer | undefined) => void | Promise<void>
  /** The operation. Resolves if allowed; a refusal throws. */
  attempt: () => Promise<unknown>
  /**
   * Access options only. Which answers may change the outcome. Default `['true']`: only an exact true counts as
   * yes. List `'where'` too when a narrow where is a real way for the host to widen this option.
   */
  mayWiden?: HostAnswerName[]
  /** Puts the instance back after each attempt. */
  restore?: () => Promise<void>
  isRefusal?: (error: unknown) => boolean
}

/**
 * Feeds each kind of host answer into a host-supplied rule and checks the plugin's defaults still hold. The
 * default outcome is measured first (`install(undefined)`). For `access` options, only the answers in `mayWiden`
 * may turn a refusal into an allow; for `veto` options, `true` and a throw must refuse. An error that isn't a
 * recognized refusal (see `isRefusal`) is "not-checked", never a refusal.
 */
export async function runHostRuleCheck(options: HostRuleOption[]): Promise<Finding[]> {
  const out: Finding[] = []
  for (const o of options) {
    const check = 'host-rule-replaces-default'
    const role = 'host'
    const refusal = o.isRefusal ?? isRefusal
    const attempt = async (): Promise<'allowed' | 'refused' | { crash: string }> => {
      try {
        await o.attempt()
        return 'allowed'
      } catch (e) {
        return refusal(e) ? 'refused' : { crash: clip(messageOf(e), 120) }
      } finally {
        await o.restore?.()
      }
    }
    const veto = o.kind === 'veto'
    try {
      await o.install(undefined)
      const baseline = await attempt()
      if (typeof baseline === 'object') {
        out.push(note(check, `${o.id}: the default holds`, role, `The operation failed with an error that isn’t a refusal: ${baseline.crash}`, o.id))
        continue
      }
      if (veto ? baseline !== 'allowed' : baseline !== 'refused') {
        out.push(note(check, `${o.id}: the default holds`, role, veto ? 'The operation was refused with no veto installed, so a veto can’t be tested.' : 'The operation was allowed with no host rule at all, so there is no default restriction to test.', o.id))
        continue
      }
      const widen = new Set<HostAnswerName>(o.mayWiden ?? ['true'])
      for (const answer of HOST_ANSWERS) {
        const title = `${o.id}: a host answer of ${answer.name} ${veto ? 'is handled safely' : 'keeps the default restriction'}`
        const path = `${o.id} · ${answer.name}`
        await o.install(answer)
        const result = await attempt()
        if (typeof result === 'object') {
          out.push(note(check, title, role, `The operation failed with an error that isn’t a refusal: ${result.crash}`, path))
          continue
        }
        let wrong: boolean
        let how: string
        if (veto) {
          const mustRefuse = answer.name === 'true' || answer.name === 'throw'
          wrong = mustRefuse && result === 'allowed'
          how = wrong ? `A veto answer of ${answer.name} didn’t stop the operation.` : mustRefuse ? 'The veto applied.' : `${answer.name} isn’t a veto; the operation was ${result}.`
        } else {
          wrong = result === 'allowed' && !widen.has(answer.name)
          how = wrong ? `A host answer of ${answer.name} switched a default restriction off.` : result === 'allowed' ? `${answer.name} is allowed to widen this option, and did.` : 'The default restriction still applied.'
        }
        out.push({ check, title, severity: 'high', status: wrong ? 'fail' : 'pass', role, path, how, reproduce: wrong ? `Make the host's ${o.id} option answer ${answer.name === 'throw' ? 'by throwing' : answer.name} and repeat the operation.` : undefined })
      }
    } catch (e) {
      out.push(note(check, `${o.id}: the default holds`, role, `The probe could not run: ${clip(messageOf(e), 120)}`, o.id))
    } finally {
      await o.install(undefined)
    }
  }
  return out
}
