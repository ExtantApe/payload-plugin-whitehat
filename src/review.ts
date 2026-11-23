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

/** Statuses and error names that mean "the system said no": sign-in, forbidden and not found. Validation is not one. */
const REFUSAL_STATUSES = [401, 403, 404]
const REFUSAL_NAMES = ['Forbidden', 'UnauthorizedError', 'NotFound']
const TX_CODE_NAMES = ['NoSuchTransaction', 'WriteConflict', 'TransactionTooOld', 'TransactionAborted', 'TransactionCommitted', 'OperationNotSupportedInTransaction', 'TransactionExceededLifetimeLimitSeconds']
const TX_CODES = [112, 225, 244, 251, 256, 263, 290]
const TX_LABELS = ['TransientTransactionError', 'UnknownTransactionCommitResult']

const causesOf = (e: unknown): unknown[] => {
  const x = e as { cause?: unknown; errors?: unknown } | null
  const list: unknown[] = []
  if (x?.cause !== undefined && x.cause !== null) list.push(x.cause)
  if (Array.isArray(x?.errors)) list.push(...x.errors)
  return list
}
const labelsOf = (e: unknown): string[] => {
  const l = (e as { errorLabels?: unknown } | null)?.errorLabels
  return Array.isArray(l) ? l.map(String) : l instanceof Set ? [...l].map(String) : []
}

/**
 * Whether an error is the database's own transaction trouble: a driver error with a transaction `codeName`
 * (NoSuchTransaction, WriteConflict ...), code, or `errorLabels` entry (TransientTransactionError), on the error
 * or on anything in its `cause` chain. Real driver errors carry the name only in those fields; their message
 * is plain text.
 */
export function isTransactionError(error: unknown, depth = 0): boolean {
  if (error === null || typeof error !== 'object' || depth > 6) return false
  const e = error as { codeName?: unknown; code?: unknown; name?: unknown }
  if (TX_CODE_NAMES.includes(String(e.codeName)) || TX_CODE_NAMES.includes(String(e.name))) return true
  if (typeof e.code === 'number' && TX_CODES.includes(e.code) && (typeof e.codeName === 'string' || /^Mongo/.test(String(e.name)))) return true
  if (labelsOf(error).some((l) => TX_LABELS.includes(l))) return true
  return causesOf(error).some((c) => isTransactionError(c, depth + 1))
}

/** Whether an error comes from the database driver (Mongo's own errors, transaction or not): never the plugin saying no. */
export function isDatabaseError(error: unknown, depth = 0): boolean {
  if (error === null || typeof error !== 'object' || depth > 6) return false
  const e = error as { codeName?: unknown; name?: unknown }
  if (isTransactionError(error) || /^Mongo/.test(String(e.name)) || (typeof e.codeName === 'string' && e.codeName !== '') || labelsOf(error).length > 0) return true
  return causesOf(error).some((c) => isDatabaseError(c, depth + 1))
}

/** A validation error: status 400 or 422, or the name ValidationError. A typo in a probe's data looks like this, so it says nothing about access. */
export function isValidationError(error: unknown): boolean {
  const e = error as { name?: unknown } | null
  return [400, 422].includes(statusOf(error)) || String(e?.name) === 'ValidationError'
}

/**
 * Whether an error is a proper refusal: HTTP 401, 403 or 404, or Payload's Forbidden, UnauthorizedError and
 * NotFound. Not a refusal: a validation error (400, 422, ValidationError), a database or transaction error
 * (checked on the error and its `cause`, by name, `codeName` and `errorLabels`), a plain Error, a 5xx.
 * Callers can pass their own `isRefusal` where the site refuses some other way.
 */
export function isRefusal(error: unknown): boolean {
  if (isDatabaseError(error) || isValidationError(error)) return false
  return REFUSAL_STATUSES.includes(statusOf(error)) || REFUSAL_NAMES.includes(String((error as { name?: unknown })?.name))
}
const clip = (s: string, n = 100) => (s.length > n ? `${s.slice(0, n)}…` : s)
const messageOf = (e: unknown): string => {
  const base = String((e as { message?: unknown })?.message ?? e)
  let data = ''
  try {
    const d = (e as { data?: unknown })?.data
    data = d === undefined || d === null ? '' : JSON.stringify(d)
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

/** Key order carries no meaning, so objects are written with their keys sorted. */
const sortKeys = (v: unknown, depth = 0): unknown => {
  if (depth > 20 || v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map((x) => sortKeys(x, depth + 1))
  const o = v as Record<string, unknown>
  const toJSON = (o as { toJSON?: unknown }).toJSON
  if (typeof toJSON === 'function') return v
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, sortKeys(o[k], depth + 1)]))
}
const json = (v: unknown): string => {
  try {
    return JSON.stringify(sortKeys(v)) ?? 'undefined'
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
    // A short id would also match inside other words and numbers, so it only counts as a whole token.
    if (id.length > 0 && id.length < 3) t = t.replace(new RegExp(`(?<![\\w-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'g'), '<id>')
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
    const other = crashed === x ? y : x
    if (crashed && !other.threw) {
      out.push({
        check: 'response-difference',
        title,
        severity,
        status: 'fail',
        role: pair,
        path: op.id,
        how: `One identity was allowed and the other got an error that isn’t a refusal (${clip(crashed.message, 80)}). A caller can see that difference.`,
        reproduce: op.reproduce ?? 'Run the operation once as each identity and compare the two answers.',
      })
      continue
    }
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
const MONGO_TX_WORDS = /NoSuchTransaction|Transaction numbers are only allowed on a replica set|Transactions are not supported|does not support (?:retryable writes|sessions|transactions)|TransientTransactionError|WriteConflict|write conflict|in-progress transaction|has been aborted|multi-document transaction|retry your operation|Given transaction number/i
const DEFAULT_TX_REFUSAL = (said: string, error?: unknown) => /transaction/i.test(said) && !MONGO_TX_WORDS.test(said) && !isValidationError(error)

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
 * one of the database's own. Real driver errors (NoSuchTransaction, WriteConflict, "Transaction numbers are only
 * allowed on a replica set member") are recognized by `codeName`, `code`, `errorLabels` and `cause`, never by
 * the message alone, and a database error is never a refusal, whatever `refusal` matches. A validation error is
 * not one by default. Any other error is "not checked".
 */
export async function runTransactionCheck(input: {
  start: () => Promise<{ payload: Payload; stop?: () => Promise<void> }>
  /** A write the plugin protects with a transaction, made on the instance `start` returned. */
  write: (payload: Payload) => Promise<unknown>
  mode?: 'off-at-start' | 'null-after-start'
  refusal?: RegExp | ((said: string, error: unknown) => boolean)
  severity?: Severity
}): Promise<Finding[]> {
  const sev = input.severity ?? 'high'
  const mode = input.mode ?? 'off-at-start'
  const check = 'transactions-required'
  const title = mode === 'off-at-start' ? 'A plugin that needs transactions refuses to run without them' : 'A plugin that needs transactions refuses a write when beginTransaction answers null'
  const refuses = (said: string, error: unknown) => !isDatabaseError(error) && (input.refusal instanceof RegExp ? input.refusal.test(said) : (input.refusal ?? DEFAULT_TX_REFUSAL)(said, error))
  const role = 'server'
  let started: Awaited<ReturnType<typeof input.start>> | undefined
  let restore: (() => void) | undefined
  try {
    try {
      started = await input.start()
    } catch (e) {
      const said = messageOf(e)
      if (mode === 'off-at-start' && refuses(said, e)) return [{ check, title, severity: sev, status: 'pass', role, path: 'start-up', how: 'It refused to start without transactions.' }]
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
      return refuses(said, e)
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

/**
 * For each protected collection: bulk update and bulk delete with a `where`, update, delete and (with `create`)
 * create with `disableTransaction: true`, and, when `holdsForServerCode`, the same with `overrideAccess: true`
 * plus bulk update and delete as server code (`overrideAccess: true`, no user). Bulk operations answer with
 * `{ docs, errors }` instead of throwing, so a rule that only guards single writes, or that commits one document
 * at a time, lets them through.
 *
 * An answer is never taken at its word: after each probe the rows are read again. An update counts as let through
 * only if a field in `data` changed, a delete only if the row is gone, a create only if the new row exists. A
 * rule that quietly puts the old value back, or quietly keeps the row, answers without an error and is a pass.
 * When an update changes nothing and wasn't refused, the check writes `data` straight through the database
 * adapter (no hooks, no access) to prove `data` can change the row at all; if it can't, the probe is not-checked,
 * since a typo in `data` would otherwise read as a lock. That control write is undone by `seed`.
 *
 * Only a recognized refusal passes as a refusal (see `isRefusal`). Any other error, and any bulk error entry
 * that isn't one, are "not-checked". A bulk `errors` entry only has a message, so it counts as refused only
 * when `isRefusal` accepts it (a `status` or `name` on the entry) or its message is Payload's standard "not
 * allowed to perform this action" or says forbidden. Pass your own `isRefusal` for any other wording.
 */
export async function runServerBackDoorCheck(payload: Payload, collections: ProtectedCollection[], options: { isRefusal?: (error: unknown) => boolean } = {}): Promise<Finding[]> {
  const out: Finding[] = []
  const refusal = options.isRefusal ?? isRefusal
  type Result = { docs?: unknown[]; errors?: { message?: string }[] }
  type Ran = { refused?: boolean; createdId?: string | number }
  for (const c of collections) {
    const role = c.identity.role
    const base = { collection: c.slug as never, user: c.identity.user as never }
    const server = { collection: c.slug as never, overrideAccess: true as const }
    // A bulk answer: errors that aren't a recognized refusal are not-checked; recognized refusals mean refused.
    const bulk = (r: unknown): Ran => {
      const res = r as Result
      const errors = res.errors ?? []
      const other = errors.find((e) => !refusal(e) && !/not allowed to perform|forbidden/i.test(String(e?.message)))
      if (other) throw Object.assign(new Error(`bulk operation error: ${clip(messageOf(other), 80)}`), { crash: true })
      return { refused: (res.docs?.length ?? 0) === 0 && errors.length > 0 }
    }
    const created = (doc: unknown): Ran => ({ createdId: (doc as { id?: string | number } | null)?.id })
    type Probe = { id: string; title: string; kind: 'update' | 'delete' | 'create'; run: (id: string | number) => Promise<Ran> }
    const probes: Probe[] = [
      { id: 'bulk-update', kind: 'update', title: 'Bulk update with a where', run: async () => bulk(await payload.update({ ...base, where: c.protectedWhere as never, data: c.data as never, overrideAccess: false })) },
      { id: 'bulk-delete', kind: 'delete', title: 'Bulk delete with a where', run: async () => bulk(await payload.delete({ ...base, where: c.protectedWhere as never, overrideAccess: false })) },
      { id: 'update-no-transaction', kind: 'update', title: 'Update by id with disableTransaction', run: async (id) => (await payload.update({ ...base, id, data: c.data as never, overrideAccess: false, disableTransaction: true }), {}) },
      { id: 'delete-no-transaction', kind: 'delete', title: 'Delete by id with disableTransaction', run: async (id) => (await payload.delete({ ...base, id, overrideAccess: false, disableTransaction: true }), {}) },
    ]
    if (c.create) probes.push({ id: 'create-no-transaction', kind: 'create', title: 'Create with disableTransaction', run: async () => created(await payload.create({ ...base, data: c.create as never, overrideAccess: false, disableTransaction: true })) })
    if (c.holdsForServerCode) {
      probes.push(
        { id: 'update-override-access', kind: 'update', title: 'Update by id with overrideAccess', run: async (id) => (await payload.update({ ...base, id, data: c.data as never, overrideAccess: true }), {}) },
        { id: 'delete-override-access', kind: 'delete', title: 'Delete by id with overrideAccess', run: async (id) => (await payload.delete({ ...base, id, overrideAccess: true }), {}) },
      )
      if (c.create) probes.push({ id: 'create-override-access', kind: 'create', title: 'Create with overrideAccess', run: async () => created(await payload.create({ ...base, data: c.create as never, overrideAccess: true })) })
      probes.push(
        { id: 'bulk-update-server-code', kind: 'update', title: 'Bulk update from server code (no user, overrideAccess)', run: async () => bulk(await payload.update({ ...server, where: c.protectedWhere as never, data: c.data as never })) },
        { id: 'bulk-delete-server-code', kind: 'delete', title: 'Bulk delete from server code (no user, overrideAccess)', run: async () => bulk(await payload.delete({ ...server, where: c.protectedWhere as never })) },
      )
    }
    const dataKeys = Object.keys(c.data)
    const fieldNames = (slug: string): Set<string> | null => {
      const cfg = (payload as unknown as { collections?: Record<string, { config?: { flattenedFields?: { name?: string }[]; fields?: { name?: string }[] } }> }).collections?.[slug]?.config
      const list = cfg?.flattenedFields ?? cfg?.fields
      return list ? new Set(['id', 'createdAt', 'updatedAt', ...list.map((f) => String(f.name))]) : null
    }
    const pick = (doc: unknown) => Object.fromEntries(dataKeys.map((k) => [k, (doc as Record<string, unknown> | null)?.[k]]))
    const readAll = async () => ((await payload.find({ collection: c.slug as never, where: c.protectedWhere as never, limit: 100, depth: 0, pagination: false, overrideAccess: true })).docs as { id: string | number }[])
    const readOne = async (id: string | number) => (await payload.findByID({ collection: c.slug as never, id, depth: 0, overrideAccess: true, disableErrors: true })) as { id: string | number } | null
    for (const p of probes) {
      const check = 'server-code-back-door'
      const title = `${c.slug}: ${p.title} is refused`
      const path = `${c.slug} · ${p.id}`
      try {
        await c.seed()
        const before = await readAll()
        const row = before[0]?.id
        if (row === undefined) {
          out.push(note(check, title, role, 'After seeding, no row matched protectedWhere, so there was nothing to try.', path))
          continue
        }
        let ran: Ran
        let refused = false
        try {
          ran = await p.run(row)
          refused = Boolean(ran.refused)
        } catch (e) {
          if ((e as { crash?: boolean }).crash || !refusal(e)) {
            out.push(note(check, title, role, `The probe failed with an error that isn’t a refusal: ${clip(messageOf(e), 120)}`, path))
            continue
          }
          ran = {}
          refused = true
        }
        // Read the rows again: an answer without an error doesn't say anything changed.
        let allowed = false
        let how = refused ? 'Refused.' : ''
        if (p.kind === 'create') {
          allowed = ran.createdId !== undefined && (await readOne(ran.createdId)) !== null
          if (!refused) how = allowed ? '' : 'The create answered without an error, but no new row exists.'
        } else if (p.kind === 'delete') {
          const gone = (await Promise.all(before.map((d) => readOne(d.id)))).some((d) => d === null)
          allowed = gone
          if (!refused && !gone) how = 'The delete answered without an error, but the row is still there.'
        } else {
          const now = await Promise.all(before.map((d) => readOne(d.id)))
          allowed = before.some((d, i) => json(pick(d)) !== json(pick(now[i])))
          if (!allowed && !refused) {
            // Nothing changed and nothing was refused. Is that a lock, or can `data` not change the row at all?
            if (before.every((d) => json(pick(d)) === json(c.data))) {
              out.push(note(check, title, role, 'The fields in data already hold those values, so a change couldn’t show. Use values that differ from the seeded row.', path))
              continue
            }
            const known = fieldNames(c.slug)
            const unknown = known ? dataKeys.filter((k) => !known.has(k)) : []
            if (unknown.length) {
              out.push(note(check, title, role, `The update changed nothing, and ${unknown.join(', ')} ${unknown.length === 1 ? 'isn’t a field' : 'aren’t fields'} of ${c.slug}, so data may have a typo. Nothing was learned.`, path))
              continue
            }
            await c.seed()
            const fresh = await readAll()
            const target = fresh[0]
            let writable = false
            if (target) {
              await payload.db.updateOne({ collection: c.slug as never, id: target.id, data: c.data as never, req: {} as never, returning: false } as never)
              writable = json(pick(await readOne(target.id))) === json(Object.fromEntries(dataKeys.map((k) => [k, c.data[k]])))
            }
            await c.seed()
            if (!writable) {
              out.push(note(check, title, role, 'The update changed nothing, and writing data straight through the database didn’t change the row either, so data may not be writable. Nothing was learned.', path))
              continue
            }
            how = 'The update answered without an error, but the field kept its old value (a silent lock).'
          }
        }
        out.push({
          check,
          title,
          severity: 'high',
          status: allowed ? 'fail' : 'pass',
          role,
          path,
          how: allowed ? `The rule was skipped: ${p.title.toLowerCase()} got through.` : how || 'Refused.',
          reproduce: allowed ? `From server code, call payload.${p.kind} on ${c.slug} (${p.id}).` : undefined,
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
   * Strict answers: only the answers in `goAhead` (default `null` and `undefined`) may leave the operation
   * allowed. Every other answer must refuse it: `true`, a reason string, `{}`, `[]`, 1, 0, an empty string,
   * false, a function, a narrow where, and a throw (a broken veto fails closed). If a plugin documents another
   * answer as "go ahead", say so in `goAhead`; the report then says that answer was allowed by contract.
   */
  kind?: 'access' | 'veto'
  /** Veto options only. Answers that mean "no veto". Default `['null', 'undefined']`. */
  goAhead?: HostAnswerName[]
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
 * may turn a refusal into an allow; for `veto` options, `true`, a reason string and a throw must refuse. An error that isn't a
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
      const goAhead = new Set<HostAnswerName>(o.goAhead ?? ['null', 'undefined'])
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
          const mustRefuse = !goAhead.has(answer.name)
          wrong = mustRefuse && result === 'allowed'
          how = wrong ? `A veto answer of ${answer.name} didn’t stop the operation.` : mustRefuse ? 'The veto applied.' : `${answer.name} is documented as go ahead; the operation was ${result}.`
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
