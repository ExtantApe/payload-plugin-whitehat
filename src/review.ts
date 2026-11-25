import { types as utilTypes } from 'node:util'

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

/** A status counts only when it is a real integer number: '403', 403n, [403] and an object with valueOf are not one. */
const intStatus = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) ? v : NaN)
/** The HTTP status of an error, or NaN. Never throws: a getter that throws reads as NaN. */
const statusOf = (e: unknown): number => {
  try {
    const s = snapshot(e)
    return s.unreadable ? NaN : s.status
  } catch {
    return NaN
  }
}

/** Statuses and error names that mean "the system said no": sign-in, forbidden and not found. Validation is not one. */
const REFUSAL_STATUSES = [401, 403, 404]
const TX_CODE_NAMES = ['NoSuchTransaction', 'WriteConflict', 'TransactionTooOld', 'TransactionAborted', 'TransactionCommitted', 'OperationNotSupportedInTransaction', 'TransactionExceededLifetimeLimitSeconds']
const TX_CODES = [72, 112, 117, 225, 244, 251, 256, 263, 290]
const TX_LABELS = ['TransientTransactionError', 'UnknownTransactionCommitResult']

/** Where an error can nest another one: GraphQL, the driver's server reply and bulk write errors, among others. */
const NESTED_KEYS = ['cause', 'originalError', 'errorResponse', 'errors', 'writeErrors', 'writeConcernError', 'errInfo', 'extensions', 'result', 'err', 'reason', 'response', 'exception', 'details'] as const

/** What the walk reads from one error, taken once and safely: a property that throws marks the snapshot unreadable. */
type Snap = { name: unknown; code: unknown; codeName: unknown; errmsg: unknown; errors: unknown; labels: string[]; status: number; text: string; own: string | null; children: unknown[]; unreadable: boolean; opaque: boolean }

const MAX_CONTAINER = 10_000
const isPlainObject = (v: object): boolean => {
  const p = Object.getPrototypeOf(v)
  return p === Object.prototype || p === null
}
/**
 * Pushes what a container holds: an array or nested array, a Map's values, a Set's members, an array-like object
 * (`{ length: 2, 0: e, 1: e }`) or a keyed object (`{ first: e }`). Each container is opened once (a self-referential
 * array ends at once) and at most MAX_CONTAINER entries are read in all. Returns false if it could not read all of it.
 */
function spread(v: unknown, out: unknown[]): boolean {
  const seen = new Set<object>()
  let budget = MAX_CONTAINER
  let ok = true
  const visit = (c: unknown, depth: number): void => {
    if (c === undefined || c === null) return
    if (typeof c !== 'object') {
      out.push(c)
      return
    }
    if (depth > 4) {
      out.push(c)
      return
    }
    if (seen.has(c)) return
    seen.add(c)
    const add = (x: unknown) => {
      if (--budget < 0) {
        ok = false
        return
      }
      if (x !== null && typeof x === 'object' && (Array.isArray(x) || x instanceof Map || x instanceof Set)) visit(x, depth + 1)
      else out.push(x)
    }
    if (Array.isArray(c)) {
      if (c.length > budget) {
        ok = false
        return
      }
      for (let i = 0; i < c.length && ok; i++) add(c[i])
      return
    }
    if (c instanceof Map) {
      for (const [k, x] of c) {
        if (!ok) return
        add(x)
        if (k !== null && typeof k === 'object') add(k)
      }
      return
    }
    if (c instanceof Set) {
      for (const x of c) {
        if (!ok) return
        add(x)
      }
      return
    }
    out.push(c)
    if (isPlainObject(c)) {
      const len = (c as { length?: unknown }).length
      if (typeof len === 'number' && Number.isInteger(len) && len >= 0) {
        if (len > budget) {
          ok = false
          return
        }
        for (let i = 0; i < len && ok; i++) add((c as Record<number, unknown>)[i])
      }
      const keys = Object.keys(c)
      if (keys.length > budget) {
        ok = false
        return
      }
      for (const k of keys) {
        if (!ok) return
        add((c as Record<string, unknown>)[k])
      }
    }
  }
  visit(v, 0)
  return ok
}

/**
 * Whether a node cannot be opened fully by reading its named properties: a Proxy, a class instance that is not an
 * Error (or an Error from another realm), a Symbol key, or a hidden (non-enumerable) key other than the Error basics.
 */
function isOpaque(node: object): boolean {
  try {
    if (utilTypes.isProxy(node)) return true
    if (!isPlainObject(node) && !(node instanceof Error)) return true
    for (const k of Reflect.ownKeys(node)) {
      if (typeof k === 'symbol') return true
      const d = Object.getOwnPropertyDescriptor(node, k)
      if (d && d.enumerable === false && !['stack', 'message', 'cause'].includes(k)) return true
    }
    return false
  } catch {
    return true
  }
}

/** Text for a value only when it is a primitive. An object's own toString is host code, so it reads as empty. */
const prim = (v: unknown): string => (v === null || (typeof v !== 'object' && typeof v !== 'function') ? String(v) : '')

/**
 * Whether `v` can be turned into JSON text without running host code: primitives, arrays and plain objects (up to a
 * few levels) whose values are all plain data properties. A getter, a Proxy or a class instance (it may have toJSON)
 * says no.
 */
function plainJson(v: unknown, depth = 0): boolean {
  if (v === null || typeof v !== 'object') return typeof v !== 'function' && typeof v !== 'symbol'
  if (depth > 4 || utilTypes.isProxy(v)) return false
  const proto = Object.getPrototypeOf(v)
  if (proto !== Object.prototype && proto !== null && !Array.isArray(v)) return false
  if (Array.isArray(v) && proto !== Array.prototype) return false
  for (const k of Reflect.ownKeys(v)) {
    if (typeof k === 'symbol') return false
    const d = Object.getOwnPropertyDescriptor(v, k)
    if (!d || !('value' in d)) return false
    if (!plainJson(d.value, depth + 1)) return false
  }
  return Object.prototype.hasOwnProperty.call(v, 'toJSON') ? false : !('toJSON' in v)
}

/**
 * Takes everything a check needs from one error, once, from property descriptors only (own and inherited, down the
 * prototype chain). No getter ever runs here: a property that is an accessor, or sits behind a Proxy, reads as
 * unknown (`unreadable`), which every caller treats as "not a refusal" or "may be a database error". Nothing is
 * converted with String() unless it is a primitive. Callers judge from the returned Snap and never touch the live
 * error again. (The one getter that runs is V8's `stack`, which `readStack` reads before this is called.)
 */
function snapshot(node: unknown): Snap {
  const snap: Snap = { name: undefined, code: undefined, codeName: undefined, errmsg: undefined, errors: undefined, labels: [], status: NaN, text: '', own: null, children: [], unreadable: false, opaque: false }
  if (typeof node === 'string') {
    snap.text = node
    snap.own = node
    return snap
  }
  if (node === null || (typeof node !== 'object' && typeof node !== 'function')) {
    snap.text = prim(node)
    return snap
  }
  if (utilTypes.isProxy(node)) {
    snap.unreadable = true
    snap.opaque = true
    return snap
  }
  if (Array.isArray(node) || node instanceof Map || node instanceof Set) {
    try {
      if (!spread(node, snap.children)) snap.unreadable = true
    } catch {
      snap.unreadable = true
    }
    return snap
  }
  snap.opaque = isOpaque(node as object)
  const get = (k: string): unknown => {
    try {
      let p: object | null = node as object
      for (let i = 0; p !== null; i++, p = Object.getPrototypeOf(p)) {
        if (i > 50 || utilTypes.isProxy(p)) break
        const d = Object.getOwnPropertyDescriptor(p, k)
        if (d) {
          if ('value' in d) return d.value
          break
        }
        if (Object.getPrototypeOf(p) === null) return undefined
      }
    } catch {
      // fall through to unknown
    }
    snap.unreadable = true
    return undefined
  }
  snap.name = get('name')
  snap.code = get('code')
  snap.codeName = get('codeName')
  snap.errmsg = get('errmsg')
  snap.errors = get('errors')
  const status = get('status') ?? get('statusCode')
  snap.status = intStatus(status)
  try {
    const l = get('errorLabels')
    const items: unknown[] = []
    if (utilTypes.isSet(l)) {
      for (const x of Set.prototype.values.call(l)) items.push(x)
    } else if (Array.isArray(l) && !utilTypes.isProxy(l) && Object.getPrototypeOf(l) === Array.prototype) {
      const len = Object.getOwnPropertyDescriptor(l, 'length')?.value
      if (typeof len !== 'number' || len > MAX_CONTAINER) snap.unreadable = true
      else {
        for (let i = 0; i < len; i++) {
          const d = Object.getOwnPropertyDescriptor(l, String(i))
          if (d && 'value' in d) items.push(d.value)
          else if (d) snap.unreadable = true
        }
      }
    } else if (l !== undefined && l !== null) snap.unreadable = true
    // Only primitives are text. An object in the list is not a label, and its toString is not ours to run.
    for (const x of items) {
      if (x !== null && typeof x === 'object') snap.unreadable = true
      else snap.labels.push(prim(x))
    }
    const message = get('message')
    if (typeof message === 'string') {
      snap.own = message
      snap.text = message
    } else if (message !== undefined && message !== null) snap.text = prim(message)
    else snap.text = '' // no message: never ask the error for its Symbol.toStringTag (that is a getter call)
    const d = get('data')
    if (d !== undefined && d !== null) {
      if (plainJson(d)) {
        try {
          snap.text += JSON.stringify(d) ?? ''
        } catch {
          // an unserializable data object adds nothing to the text
        }
      } else snap.unreadable = true
    }
  } catch {
    snap.unreadable = true
  }
  if (snap.own === null && typeof snap.errmsg === 'string') snap.own = snap.errmsg
  for (const k of NESTED_KEYS) {
    const v = get(k)
    if (v === undefined || v === null) continue
    try {
      if (!spread(v, snap.children)) snap.unreadable = true
    } catch {
      snap.unreadable = true
    }
  }
  return snap
}

const MAX_DEPTH = 6
const walkable = (n: unknown): n is object | string => n !== null && n !== undefined && (typeof n === 'object' || typeof n === 'string')
/**
 * Visits an error and everything nested in it (see `NESTED_KEYS`), breadth first, each object once (a cycle or a node
 * shared by several parents is not walked again), to MAX_DEPTH levels. Stops at the first node `test` accepts.
 * `incomplete` is true when the walk could not finish: the depth limit was reached with nodes still unvisited, or a
 * property on some node threw. Callers that guard against a database error must then treat the answer as unknown.
 */
function walk(error: unknown, test: (snap: Snap, depth: number) => boolean): { hit: boolean; incomplete: boolean } {
  const seen = new WeakSet<object>()
  let level: unknown[] = [error]
  let incomplete = false
  for (let depth = 0; depth <= MAX_DEPTH && level.length > 0; depth++) {
    const next: unknown[] = []
    for (const node of level) {
      if (!walkable(node)) continue
      if (typeof node === 'object') {
        if (seen.has(node)) continue
        seen.add(node)
      }
      const snap = snapshot(node)
      if (snap.unreadable) incomplete = true
      if (test(snap, depth)) return { hit: true, incomplete }
      for (const c of snap.children) next.push(c)
    }
    level = next
  }
  // Anything left over was never looked at, unless it is a node already seen (a cycle).
  if (level.some((n) => walkable(n) && !(typeof n === 'object' && seen.has(n)))) incomplete = true
  return { hit: false, incomplete }
}

const ownTransactionError = (e: Snap): boolean => {
  if (TX_CODE_NAMES.includes(prim(e.codeName)) || TX_CODE_NAMES.includes(prim(e.name))) return true
  if (typeof e.code === 'number' && TX_CODES.includes(e.code) && (typeof e.codeName === 'string' || typeof e.errmsg === 'string' || /^Mongo/.test(prim(e.name)))) return true
  return e.labels.some((l) => TX_LABELS.includes(l))
}
const ownDatabaseError = (e: Snap): boolean =>
  // A server reply (`errmsg` with a numeric `code`) is the database talking, even without a `codeName`.
  ownTransactionError(e) || /^Mongo/.test(prim(e.name)) || (typeof e.codeName === 'string' && e.codeName !== '') || (typeof e.errmsg === 'string' && typeof e.code === 'number') || e.labels.length > 0

/**
 * Whether an error is the database's own transaction trouble: a driver error with a transaction `codeName`
 * (NoSuchTransaction, WriteConflict ...), code, or `errorLabels` entry (TransientTransactionError), on the error,
 * on its `errorResponse`, or on anything nested in it (`cause`, `originalError`, `errors`, `writeErrors`,
 * `writeConcernError`, `errInfo`, `extensions`, `result`). Real driver errors carry the name only in those fields;
 * their message is plain text. Exact: a walk that could not finish says false here, though `isDatabaseError` says true.
 */
export function isTransactionError(error: unknown): boolean {
  return walk(error, ownTransactionError).hit
}

/**
 * Whether an error comes from the database driver (Mongo's own errors, transaction or not): never the plugin saying
 * no. When the walk cannot finish (the chain is deeper than MAX_DEPTH levels, or a property throws) a driver error
 * may be hiding past the limit, so the answer is true: unknown is never a refusal.
 */
export function isDatabaseError(error: unknown): boolean {
  const r = walk(error, ownDatabaseError)
  return r.hit || r.incomplete
}
/**
 * Wraps a caller's own `isRefusal` so a database or transaction error is never a refusal, whatever the caller's
 * predicate says. The database test (error fields) runs first; the predicate only sees
 * errors that pass it.
 */
function guardRefusal(custom: ((error: unknown) => boolean) | undefined): (error: unknown) => boolean {
  if (custom === undefined) return isRefusal
  if (typeof custom !== 'function') throw new Error(`config error: option "isRefusal" must be a function that takes the error, not ${custom === null ? 'null' : typeof custom}.`)
  return (error) => {
    try {
      return !isDatabaseError(error) && custom(error)
    } catch {
      return false
    }
  }
}

/** A validation error: status 400 or 422, or the name ValidationError. A typo in a probe's data looks like this, so it says nothing about access. */
export function isValidationError(error: unknown): boolean {
  try {
    const s = snapshot(error)
    return [400, 422].includes(s.unreadable ? NaN : s.status) || prim(s.name) === 'ValidationError'
  } catch {
    return false
  }
}
/** The fixed value of `data.refusal` on the error a plugin throws when it refuses to run without transactions. */
export const TRANSACTIONS_REQUIRED = 'transactions-required'
/** The only own keys a refusal error may have. `cause` is also allowed, but only when it is the very same value as `data`. */
const REFUSAL_OWN_KEYS = ['message', 'stack', 'name', 'status', 'statusCode', 'data', 'isPublic', 'isOperational']

/** The value of an own data property, or undefined for a getter, a missing key or anything that throws. */
const ownValue = (o: object, key: string): unknown => {
  const d = Object.getOwnPropertyDescriptor(o, key)
  return d && 'value' in d ? d.value : undefined
}
/**
 * The own-key allow-list: no Proxy, no symbol keys, and every own key is one of REFUSAL_OWN_KEYS, or `cause` when it
 * is `data` itself (Payload's APIError sets `cause: data`). Anything else may carry a nested error, so it is unknown.
 */
const INHERITED_BANNED = ['data', 'status', 'statusCode', ...NESTED_KEYS]
/**
 * Nothing the walk or the status reads may come from the prototype chain: no data, status, statusCode or nested-error
 * key beyond what the error owns, and every inherited `message` or `name` is plain text. Fails closed on a Proxy
 * in the chain or a chain longer than 50.
 */
const plainInheritance = (error: object): boolean => {
  for (const k of INHERITED_BANNED) if (k in error && !Object.prototype.hasOwnProperty.call(error, k)) return false
  let p = Object.getPrototypeOf(error)
  for (let i = 0; p !== null; i++, p = Object.getPrototypeOf(p)) {
    if (i > 50 || utilTypes.isProxy(p)) return false
    for (const k of ['message', 'name']) {
      const d = Object.getOwnPropertyDescriptor(p, k)
      if (d && (!('value' in d) || typeof d.value !== 'string')) return false
    }
  }
  return true
}
/**
 * V8 keeps `stack` as an engine accessor, and a hostile getter is host code. This is the only getter ever run on an
 * error, and it runs first and once, before the snapshot, the inheritance check and the key list, so nothing it
 * changes (an own key, setPrototypeOf, an inherited getter) can be missed. False when the stack is not text.
 */
const readStack = (error: object): boolean => {
  if (utilTypes.isProxy(error)) return false
  const stackDesc = Object.getOwnPropertyDescriptor(error, 'stack')
  if (stackDesc && !('value' in stackDesc)) {
    const st = (error as { stack?: unknown }).stack
    if (typeof st !== 'string' && st !== undefined) return false
  }
  return true
}
const plainRefusalKeys = (error: object): boolean => {
  if (utilTypes.isProxy(error)) return false
  if (!plainInheritance(error)) return false
  const keys = Reflect.ownKeys(error)
  const data = ownValue(error, 'data')
  const namesOk = keys.every((k) => typeof k === 'string' && (REFUSAL_OWN_KEYS.includes(k) || (k === 'cause' && 'value' in (Object.getOwnPropertyDescriptor(error, k) ?? {}) && ownValue(error, 'cause') === data)))
  if (!namesOk) return false
  // Every own key is a plain data property (no getter) and its value has the right type, so a driver error can't ride inside one.
  for (const k of keys as string[]) {
    const d = Object.getOwnPropertyDescriptor(error, k)
    // `stack` as an accessor was read and checked above. Every other key must be a plain data property.
    if (k === 'stack' && d && !('value' in d)) continue
    if (!d || !('value' in d)) return false
    const v = d.value
    if (k === 'message' || k === 'stack' || k === 'name') {
      if (typeof v !== 'string' && v !== undefined) return false // Payload's APIError sets stack to undefined
    } else if (k === 'status' || k === 'statusCode') {
      if (!Number.isInteger(v)) return false
    } else if (k === 'isPublic' || k === 'isOperational') {
      if (typeof v !== 'boolean') return false
    }
  }
  // Two status fields that disagree read as unknown.
  const status = ownValue(error, 'status')
  const statusCode = ownValue(error, 'statusCode')
  if (status !== undefined && statusCode !== undefined && status !== statusCode) return false
  return true
}
/** `data` on a bare refusal: absent or null, or a plain object holding only plain values (text, numbers, booleans, null). Anything nested could hide a driver error. */
const plainBareData = (data: unknown): boolean => {
  if (data === undefined || data === null) return true
  if (typeof data !== 'object' || utilTypes.isProxy(data) || Object.getPrototypeOf(data) !== Object.prototype) return false
  return Reflect.ownKeys(data).every((k) => {
    const d = Object.getOwnPropertyDescriptor(data, k)
    return typeof k === 'string' && !!d && 'value' in d && (d.value === null || ['string', 'number', 'boolean'].includes(typeof d.value))
  })
}
/**
 * A `data` that looks like an attempt at the marker but is not exactly it (any `refusal` key, even inherited, a Proxy,
 * or anything that is not a plain object) makes a bare status ambiguous, so it is not a refusal. No data, or a plain
 * object with no `refusal` key, is fine.
 */
const claimsRefusal = (data: unknown): boolean => {
  if (data === undefined || data === null) return false
  if (typeof data !== 'object') return false
  if (utilTypes.isProxy(data) || Object.getPrototypeOf(data) !== Object.prototype) return true
  return 'refusal' in data
}
/**
 * The marker a plugin throws itself, with no import from whitehat:
 * `new APIError('This change needs a transaction, so it wasn’t made.', 403, { refusal: 'transactions-required' })`.
 * It is `status` 403 as a plain own number, a `data` that is a plain object (prototype Object.prototype) whose own
 * keys are exactly ['refusal'] with that value, `cause` absent or `data`, no `errors`, and nothing else on the error.
 */
const hasMarker = (error: object, s: Snap): boolean => {
  try {
    if (!plainRefusalKeys(error)) return false
    if (ownValue(error, 'status') !== 403) return false
    const data = ownValue(error, 'data')
    if (typeof data !== 'object' || data === null || utilTypes.isProxy(data) || Object.getPrototypeOf(data) !== Object.prototype) return false
    const keys = Reflect.ownKeys(data)
    if (keys.length !== 1 || keys[0] !== 'refusal' || ownValue(data, 'refusal') !== TRANSACTIONS_REQUIRED) return false
    if (s.errors !== undefined || 'errors' in error) return false
    // A driver or validation error never counts, whatever it carries.
    return !s.unreadable && !ownDatabaseError(s) && prim(s.name) !== 'ValidationError'
  } catch {
    return false
  }
}
/**
 * Whether an error is a refusal. Only two things count: the marker (see `hasMarker`: a 403 with
 * `data` of exactly `{ refusal: 'transactions-required' }`), or a bare error: an exact integer `status` or
 * `statusCode` of 401, 403 or 404, own keys only from the allow-list (no nested error under any other key, no
 * Proxy) and no database-driver fields. Nothing is judged by its message or name: a 'Forbidden' or 'NotFound' at any
 * other status, a plain Error and every text are not refusals, and neither is a validation error. A NotFound (404),
 * AuthenticationError (401), LockedAuth and UnverifiedEmail (403) count as refusals like any other bare 401, 403 or 404.
 * The error is read once, from property descriptors, into a snapshot (only V8's `stack` getter ever runs); every judgment
 * is made from that snapshot, and any other getter reads as unknown, which is not a refusal.
 * Callers can pass their own `isRefusal` where the site refuses some other way.
 */
export function isRefusal(error: unknown): boolean {
  try {
    if (typeof error !== 'object' || error === null || !readStack(error)) return false
    const s = snapshot(error)
    if (hasMarker(error, s)) return true
    if (!plainRefusalKeys(error)) return false
    // The status is a plain own number here too, and `data` may not claim to be a refusal.
    const status = ownValue(error, 'status') ?? ownValue(error, 'statusCode')
    if (!REFUSAL_STATUSES.includes(intStatus(status)) || claimsRefusal(ownValue(error, 'data')) || !plainBareData(ownValue(error, 'data'))) return false
    // Anything nested (even a cycle back to itself), anything unreadable, or a driver's own fields means "unknown".
    return !s.unreadable && s.children.length === 0 && !ownDatabaseError(s)
  } catch {
    return false
  }
}
const clip = (s: string, n = 100) => (s.length > n ? `${s.slice(0, n)}…` : s)
/** The message and `data` of an error as text. Never throws: an error whose properties throw reads as "(unreadable error)". */
const messageOf = (e: unknown): string => {
  try {
    const snap = snapshot(e ?? String(e))
    return snap.unreadable && snap.text === '' ? '(unreadable error)' : snap.text
  } catch {
    return '(unreadable error)'
  }
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
  // Each property is read once, guarded: a getter that throws or changes its answer cannot crash or skew the probe.
  const read = <T,>(f: () => T): T | undefined => {
    try {
      return f()
    } catch {
      return undefined
    }
  }
  const roleA = read(() => a?.role)
  const roleB = read(() => b?.role)
  const pair = `${roleA} vs ${roleB}`
  if (!a || !b || roleA === undefined || roleB === undefined || roleA === roleB) return [note('response-difference', 'Responses don’t depend on who is asking', pair, 'Two identities with different roles are needed to compare answers.')]
  const refusal = guardRefusal(input.isRefusal)
  const ids = new Map<Viewer, string>([[a, read(() => String((a.user as { id?: unknown } | null)?.id ?? '')) ?? ''], [b, read(() => String((b.user as { id?: unknown } | null)?.id ?? '')) ?? '']])
  const maskFor = (v: Viewer) => (text: string) => {
    let t = text
    const id = ids.get(v) ?? ''
    if (id.length >= 3) t = t.split(id).join('<id>')
    t = t.replace(IDS, '<x>')
    // A short id would also match inside other words and numbers, so it only counts as a whole token.
    if (id.length > 0 && id.length < 3) t = t.replace(new RegExp(`(?<![\\w-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'g'), '<id>')
    return input.mask ? input.mask(t) : t
  }
  for (const op of input.operations) {
    const opId = read(() => op.id) as string
    const opTitle = read(() => op.title)
    const severity = read(() => op.severity) ?? 'high'
    const opReproduce = read(() => op.reproduce)
    const opObserve = read(() => op.observe)
    const opRun = read(() => op.run)
    const title = `${opTitle}: both identities get the same answer`
    const outcomes: Outcome[] = []
    let broken: string | null = null
    for (const who of [a, b]) {
      const mask = maskFor(who)
      let before: unknown
      let after: unknown
      try {
        before = opObserve ? await opObserve.call(op, who) : undefined
      } catch (e) {
        broken = `observe failed: ${clip(messageOf(e), 80)}`
        break
      }
      let o: Outcome
      try {
        const res = await opRun!.call(op, who)
        o = { threw: false, refused: false, status: null, message: '', shape: mask(shapeOf(res)), value: mask(json(res)), observed: '' }
      } catch (e) {
        const status = statusOf(e)
        o = { threw: true, refused: refusal(e), status: Number.isFinite(status) ? status : null, message: mask(messageOf(e)), shape: '', value: '', observed: '' }
      }
      try {
        after = opObserve ? await opObserve.call(op, who) : undefined
      } catch (e) {
        broken = `observe failed: ${clip(messageOf(e), 80)}`
        break
      }
      o.observed = opObserve ? mask(delta(before, after)) : ''
      outcomes.push(o)
    }
    if (broken || outcomes.length < 2) {
      out.push(note('response-difference', title, pair, broken ?? 'The probe could not run.', opId, severity))
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
        path: opId,
        how: `One identity was allowed and the other got an error that isn’t a refusal (${clip(crashed.message, 80)}). A caller can see that difference.`,
        reproduce: opReproduce ?? 'Run the operation once as each identity and compare the two answers.',
      })
      continue
    }
    if (crashed) {
      out.push(note('response-difference', title, pair, `An answer was an error that isn’t a refusal (${clip(crashed.message, 80)}), so it says nothing about access.`, opId, severity))
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
      path: opId,
      how: diffs.length ? `The answer depends on the identity: ${diffs.join('; ')}.` : 'Both identities got the same status, message, shape, values and readable result.',
      reproduce: diffs.length ? (opReproduce ?? 'Run the operation once as each identity and compare the two answers.') : undefined,
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
 * Two modes:
 * - `off-at-start` (default). `start` boots the instance with transactions disabled. Either it refuses (throws),
 *   or a write that relies on a transaction must refuse. A write that goes through is the finding.
 * - `null-after-start`. `start` boots a normal instance; the check then makes `beginTransaction` answer null
 *   for the writes only. A guard that checks transactions once at start-up passes start-up and is caught here,
 *   as is a guard that reads `req.transactionID` without awaiting it.
 *
 * `refusal` replaces `isRefusal` where the site refuses some other way: it gets the error, and a database error is never a
 * refusal whatever it says. By default only the marker or a bare 401, 403 or 404 counts (see
 * `isRefusal`). Any other error, text included, is "not-checked". A `refusal` that is not a function is a config error.
 */
export async function runTransactionCheck(input: {
  start: () => Promise<{ payload: Payload; stop?: () => Promise<void> }>
  /** A write the plugin protects with a transaction, made on the instance `start` returned. */
  write: (payload: Payload) => Promise<unknown>
  mode?: 'off-at-start' | 'null-after-start'
  refusal?: (error: unknown) => boolean
  severity?: Severity
}): Promise<Finding[]> {
  if (input.refusal !== undefined && typeof input.refusal !== 'function') throw new Error(`runTransactionCheck config error: option "refusal" must be a function that takes the error, not ${input.refusal === null ? 'null' : typeof input.refusal === 'object' ? Object.prototype.toString.call(input.refusal) : typeof input.refusal}.`)
  const sev = input.severity ?? 'high'
  const mode = input.mode ?? 'off-at-start'
  const check = 'transactions-required'
  const title = mode === 'off-at-start' ? 'A plugin that needs transactions refuses to run without them' : 'A plugin that needs transactions refuses a write when beginTransaction answers null'
  const refuses = (error: unknown): boolean => {
    try {
      return refusesUnsafe(error)
    } catch {
      return false // a property or the caller’s function threw: nothing was learned
    }
  }
  const refusesUnsafe = (error: unknown) => !isDatabaseError(error) && (input.refusal ?? isRefusal)(error)
  const role = 'server'
  let started: Awaited<ReturnType<typeof input.start>> | undefined
  let restore: (() => void) | undefined
  try {
    try {
      started = await input.start()
    } catch (e) {
      const said = messageOf(e)
      if (mode === 'off-at-start' && refuses(e)) return [{ check, title, severity: sev, status: 'pass', role, path: 'start-up', how: 'It refused to start without transactions.' }]
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
      return refuses(e)
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
 * that isn't one, are "not-checked". A bulk `errors` entry counts as refused only when `isRefusal` accepts it (the
 * marker, or a bare 401, 403 or 404 on the entry). Its message is never read: Payload's own bulk entries carry only
 * text, so they are "not-checked" until the plugin adds a status or the marker. Pass your own `isRefusal` for any other
 * shape. A database error is never a refusal whatever you pass: it is tested first, by `codeName`, `code`, `errorLabels` and `cause`.
 */
export async function runServerBackDoorCheck(payload: Payload, collections: ProtectedCollection[], options: { isRefusal?: (error: unknown) => boolean } = {}): Promise<Finding[]> {
  const out: Finding[] = []
  const refusal = guardRefusal(options.isRefusal)
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
      const other = errors.find((e) => !refusal(e))
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
/** The only answers a plugin may document as "go ahead" for a veto. */
export type GoAheadName = 'null' | 'undefined' | 'false'
const GO_AHEAD_NAMES: readonly string[] = ['null', 'undefined', 'false']
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
  /**
   * Veto options only. Answers that mean "no veto". Default `['null', 'undefined']`. Only `null`, `undefined` and
   * `false` may be listed; anything else (`true`, `throw`, `{}` ...) is a config error, since it would turn the
   * strict veto check off.
   */
  goAhead?: GoAheadName[]
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
 * may turn a refusal into an allow. For `veto` options, every answer except those in `goAhead` (default null and
 * undefined) must refuse: `true`, a reason string, `{}`, `[]`, 1, 0, an empty string, false, a function, a narrow
 * where and a throw. `goAhead` takes only `null`, `undefined` and `false`; anything else throws a config error
 * before any option runs. An error that isn't a recognized refusal (see `isRefusal`) is "not-checked", never a
 * refusal, and a database error is never one whatever `isRefusal` says.
 */
export async function runHostRuleCheck(options: HostRuleOption[]): Promise<Finding[]> {
  for (const o of options) {
    if (o.goAhead === undefined) continue
    const bad = Array.isArray(o.goAhead) ? o.goAhead.filter((n) => !GO_AHEAD_NAMES.includes(n as string)).map(String) : [String(o.goAhead)]
    if (bad.length > 0) throw new Error(`runHostRuleCheck config error: option "${o.id}" has goAhead ${Array.isArray(o.goAhead) ? `with ${bad.join(', ')}` : 'that is not a list'}; only null, undefined and false are allowed, because any other answer would turn the strict veto check off.`)
  }
  const out: Finding[] = []
  for (const o of options) {
    const check = 'host-rule-replaces-default'
    const role = 'host'
    const refusal = guardRefusal(o.isRefusal)
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
