import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { MongoClient } from 'mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { BasePayload, buildConfig, type Payload } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { HOST_ANSWERS, isDatabaseError, isRefusal, isTransactionError, isValidationError, runHostRuleCheck, runResponseDifferenceProbe, runServerBackDoorCheck, runTransactionCheck, type Finding, type HostAnswer, type Viewer } from '../src/index.js'
import { fixturePlugin, state } from './fixtures/fixturePlugin.js'
import { closeAll } from './helpers/mongo.js'

/** Real Payload 3.x on in-memory MongoDB, a made-up plugin, made-up users. Every instance and the database are removed at the end. */
let mongo: MongoMemoryReplSet
let payload: Payload
const booted: Payload[] = []
const config = async (db: string, transactions: boolean) =>
  buildConfig({
    secret: 'test-secret-not-for-production',
    telemetry: false,
    typescript: { autoGenerate: false },
    db: mongooseAdapter({ url: mongo.getUri(db), ensureIndexes: true, ...(transactions ? {} : { transactionOptions: false as const }) }),
    collections: [{ slug: 'users', auth: true, fields: [{ name: 'closed', type: 'checkbox' }, { name: 'minor', type: 'checkbox' }] }],
    plugins: [fixturePlugin()],
  })
/** Boots an instance. One whose start-up throws is closed before the error goes on, so no connection is left open. */
const boot = async (key: string, transactions: boolean) => {
  const p = new BasePayload()
  try {
    await p.init({ config: await config(key, transactions) })
  } catch (e) {
    await p.destroy().catch(() => undefined)
    throw e
  }
  booted.push(p)
  return p
}
const reset = () => {
  state.leakyMessage = state.leakyEvents = state.truthyHost = state.bulkHole = state.accessOnly = state.txHole = state.looseVeto = state.trueOnlyVeto = state.silentLock = state.crash = false
  state.host = {}
  state.transactions = 'ignored'
}
const user = async (email: string, extra: Record<string, unknown> = {}): Promise<Viewer & { id: string }> => {
  const u = (await payload.create({ collection: 'users', data: { email: `${email}@example.invalid`, password: 'correct-horse-battery', ...extra } as never })) as unknown as { id: string }
  return { role: email, user: { ...u, collection: 'users' }, id: u.id }
}
const bad = (fs: Finding[]) => fs.filter((f) => f.status !== 'pass').map((f) => `${f.status}:${f.path}`)

let actor: Viewer & { id: string }
let minor: Viewer & { id: string }
let closed: Viewer & { id: string }
let owner: Viewer & { id: string }

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  payload = await boot('main', true)
  actor = await user('actor')
  minor = await user('minor', { minor: true })
  closed = await user('closed', { closed: true })
  owner = await user('owner')
})
afterAll(async () => {
  expect(await closeAll(booted, mongo)).toEqual([])
})
beforeEach(reset)

describe('1. response-difference probe', () => {
  const ops = () => [
    {
      id: 'invite',
      title: 'Inviting someone',
      run: (who: Viewer) => payload.create({ collection: 'invites' as never, data: { target: (who.user as { id: string }).id } as never, user: actor.user as never, overrideAccess: false }),
      observe: async () => (await payload.count({ collection: 'invite-events' as never, overrideAccess: true })).totalDocs,
    },
  ]
  // The first identity is refused by the host's veto, the second simply isn't allowed.
  const run = () => runResponseDifferenceProbe({ identities: [minor, closed], operations: ops() })
  const withVeto = () => {
    state.host.vetoInvite = async (id) => (id === minor.id ? true : null)
  }

  it('stays quiet when both identities get the same refusal and leave the same trace', async () => {
    withVeto()
    const out = await run()
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ status: 'pass', check: 'response-difference' })
  })
  it('fires on a refusal message that says why', async () => {
    withVeto()
    state.leakyMessage = true
    const [f] = await run()
    expect(f).toMatchObject({ status: 'fail', severity: 'high' })
    expect(f!.how).toMatch(/message/)
  })
  it('fires on an event row only one of them leaves behind', async () => {
    withVeto()
    state.leakyEvents = true
    const [f] = await run()
    expect(f).toMatchObject({ status: 'fail' })
    expect(f!.how).toMatch(/read afterwards/)
  })
  it('fires on a different status, a different shape, and one allowed while the other is refused (plain answers)', async () => {
    const bySide = (a: unknown, b: unknown) => async (who: Viewer) => {
      const r = who.role === 'minor' ? a : b
      if (r instanceof Error) throw r
      return r
    }
    const err = (status: number, message = 'No.') => Object.assign(new Error(message), { status })
    const got = await runResponseDifferenceProbe({
      identities: [minor, closed],
      operations: [
        { id: 'status', title: 's', run: bySide(err(403), err(401)) },
        { id: 'shape', title: 'h', run: bySide({ id: 'x', docs: [] }, { id: 'x' }) },
        { id: 'allowed', title: 'a', run: bySide({ ok: true }, err(403)) },
        { id: 'same', title: 'same', run: bySide(err(403), err(403)) },
        { id: 'ids-only', title: 'ids', run: bySide({ id: '507f1f77bcf86cd799439011' }, { id: '507f1f77bcf86cd799439012' }) },
      ],
    })
    expect(got.map((f) => [f.path, f.status])).toEqual([['status', 'fail'], ['shape', 'fail'], ['allowed', 'fail'], ['same', 'pass'], ['ids-only', 'pass']])
  })
  it('fires on a value-only difference: the same shape with 1 against 0, or true against false', async () => {
    const bySide = (a: unknown, b: unknown) => async (who: Viewer) => (who.role === 'minor' ? a : b)
    const got = await runResponseDifferenceProbe({
      identities: [minor, closed],
      operations: [
        { id: 'count', title: 'c', run: bySide({ totalDocs: 1, docs: [] }, { totalDocs: 0, docs: [] }) },
        { id: 'flag', title: 'f', run: bySide({ minor: true }, { minor: false }) },
        { id: 'plain-number', title: 'n', run: bySide(1, 0) },
        { id: 'same-values', title: 's', run: bySide({ totalDocs: 2 }, { totalDocs: 2 }) },
      ],
    })
    expect(got.map((f) => [f.path, f.status])).toEqual([['count', 'fail'], ['flag', 'fail'], ['plain-number', 'fail'], ['same-values', 'pass']])
    expect(got[0]!.how).toMatch(/values differ/)
  })
  it('fires when only what the caller can read afterwards differs by a count', async () => {
    let n = 0
    const [f] = await runResponseDifferenceProbe({ identities: [minor, closed], operations: [{ id: 'o', title: 'o', run: async (who) => void (who.role === 'minor' && n++), observe: async () => n }] })
    expect(f).toMatchObject({ status: 'fail' })
    expect(f!.how).toMatch(/Δ1 vs Δ0/)
  })
  it('reports not-checked when an answer is an error that isn’t a refusal, even the same crash for both', async () => {
    const boom = async () => { throw Object.assign(new Error('db down'), { status: 500 }) }
    expect((await runResponseDifferenceProbe({ identities: [minor, closed], operations: [{ id: 'x', title: 'x', run: boom }] }))[0]!.status).toBe('not-checked')
    const plain = async () => { throw new Error('NoSuchTransaction') }
    expect((await runResponseDifferenceProbe({ identities: [minor, closed], operations: [{ id: 'x', title: 'x', run: plain }] }))[0]!.status).toBe('not-checked')
    const half = async (who: Viewer) => { if (who.role === 'minor') throw new Error('crash'); throw Object.assign(new Error('No'), { status: 403 }) }
    expect((await runResponseDifferenceProbe({ identities: [minor, closed], operations: [{ id: 'x', title: 'x', run: half }] }))[0]!.status).toBe('not-checked')
    expect((await runResponseDifferenceProbe({ identities: [minor, closed], operations: [{ id: 'x', title: 'x', run: plain }], isRefusal: () => true }))[0]!.status).toBe('pass')
    expect((await runResponseDifferenceProbe({ identities: [minor, minor], operations: ops() }))[0]!.status).toBe('not-checked')
  })
})

describe('2. transactions that look on but are off', () => {
  const makeCheck = async (mode: 'ignored' | 'startup' | 'write') => {
    state.transactions = mode
    const key = `no-tx-${mode}`
    return runTransactionCheck({
      start: async () => {
        const p = await boot(key, false)
        return { payload: p }
      },
      write: async (p) => {
        const created = (await p.create({ collection: 'notes' as never, data: { title: 'made up' } as never, overrideAccess: true })) as { id: string }
        await p.delete({ collection: 'notes' as never, id: created.id, overrideAccess: true })
      },
    })
  }
  it('fires when the plugin ignores that transactions are off and a write still succeeds', async () => {
    const [f] = await makeCheck('ignored')
    expect(f).toMatchObject({ status: 'fail', severity: 'high', check: 'transactions-required' })
  })
  it('stays quiet when the plugin refuses to start', async () => {
    expect((await makeCheck('startup'))[0]).toMatchObject({ status: 'pass', path: 'start-up' })
  })
  it('stays quiet when the plugin refuses the write', async () => {
    expect((await makeCheck('write'))[0]).toMatchObject({ status: 'pass', path: 'write' })
  })
  it('is not-checked when transactions are on, so it learned nothing', async () => {
    const [f] = await runTransactionCheck({ start: async () => ({ payload }), write: async () => undefined })
    expect(f!.status).toBe('not-checked')
  })
  it('after start-up: fires when beginTransaction answers null and the plugin only checked at start-up, or never', async () => {
    const run = (mode: 'startup' | 'ignored' | 'write') => {
      state.transactions = mode
      return runTransactionCheck({ mode: 'null-after-start', start: async () => ({ payload }), write: async (p) => void (await p.delete({ collection: 'notes' as never, id: ((await p.create({ collection: 'notes' as never, data: { title: 'made up' } as never, overrideAccess: true })) as { id: string }).id, overrideAccess: true })) })
    }
    expect((await run('startup'))[0]).toMatchObject({ status: 'fail' })
    expect((await run('ignored'))[0]).toMatchObject({ status: 'fail' })
    expect((await run('write'))[0]).toMatchObject({ status: 'pass', path: 'write' })
    const id = await payload.db.beginTransaction()
    expect(id).toBeTruthy()
    await payload.db.rollbackTransaction(id as never)
  })
  it('is not-checked when Mongo’s own transaction error is the only complaint, or beginTransaction throws', async () => {
    for (const said of ['Transaction numbers are only allowed on a replica set member or mongos', 'NoSuchTransaction: transaction 1 aborted']) {
      const [f] = await runTransactionCheck({ start: async () => ({ payload: await boot('no-tx-mongo', false) }), write: async () => { throw new Error(said) } })
      expect(f!.status).toBe('not-checked')
    }
    const fake = { db: { beginTransaction: async () => { throw new Error('boom') } } } as unknown as Payload
    const stops: string[] = []
    const out = await runTransactionCheck({ start: async () => ({ payload: fake, stop: async () => void stops.push('stopped') }), write: async () => undefined })
    expect(out[0]).toMatchObject({ status: 'not-checked' })
    expect(stops).toEqual(['stopped'])
  })
  it('is not-checked when the refusal is for another reason', async () => {
    const [f] = await runTransactionCheck({ start: async () => ({ payload: await boot('no-tx-other', false) }), write: async () => { throw new Error('field is invalid') } })
    expect(f!.status).toBe('not-checked')
  })
})

describe('3. server-code back doors', () => {
  const seed = async () => {
    await payload.delete({ collection: 'notes' as never, where: { id: { exists: true } } as never, overrideAccess: true })
    await payload.create({ collection: 'notes' as never, data: { title: 'kept', owner: owner.id, locked: true } as never, overrideAccess: true })
  }
  /** Seeds with the made-up database error switched off, and switches it back on for the probe. */
  const seedThenCrash = async () => {
    state.crash = false
    await seed()
    state.crash = true
  }
  const target = (holdsForServerCode: boolean) => [{ slug: 'notes', identity: owner, protectedWhere: { locked: { equals: true } }, data: { title: 'changed' }, create: { title: 'forbidden', owner: owner.id }, holdsForServerCode, seed }]
  const ids = (fs: Finding[]) => fs.filter((f) => f.status === 'fail').map((f) => f.path!.split(' · ')[1])
  afterAll(async () => void (await payload.delete({ collection: 'notes' as never, where: { id: { exists: true } } as never, overrideAccess: true })))

  it('stays quiet when the lock is in access and in hooks', async () => {
    const out = await runServerBackDoorCheck(payload, target(true))
    expect(out).toHaveLength(10)
    expect(bad(out)).toEqual([])
  })
  it('fires on bulk update and delete when bulk skips the lock', async () => {
    state.bulkHole = true
    expect(ids(await runServerBackDoorCheck(payload, target(false)))).toEqual(['bulk-update', 'bulk-delete'])
  })
  it('fires on overrideAccess, a create, and bulk server code when the lock is only an access function, but only if the rule is meant to hold for server code', async () => {
    state.accessOnly = true
    expect(ids(await runServerBackDoorCheck(payload, target(true)))).toEqual(['update-override-access', 'delete-override-access', 'create-override-access', 'bulk-update-server-code', 'bulk-delete-server-code'])
    expect(ids(await runServerBackDoorCheck(payload, target(false)))).toEqual([])
  })
  it('fires on disableTransaction, create included, when the hook needs a transaction to run', async () => {
    state.txHole = true
    expect(ids(await runServerBackDoorCheck(payload, target(false)))).toEqual(['update-no-transaction', 'delete-no-transaction', 'create-no-transaction'])
  })
  it('is not-checked, never passed, when a probe dies with a database error', async () => {
    state.crash = true
    const out = await runServerBackDoorCheck(payload, [{ ...target(true)[0]!, seed: seedThenCrash }])
    expect(out).toHaveLength(10)
    // The probes that reach the guarded hooks crash; the ones the access rule already stops never get that far.
    const reached = out.filter((f) => /create|override|server-code/.test(f.path!))
    expect(reached).toHaveLength(6)
    expect(reached.filter((f) => f.status !== 'not-checked')).toEqual([])
  })
  it('is not-checked for a wrong collection slug, and passes a custom refusal', async () => {
    const [f] = await runServerBackDoorCheck(payload, [{ ...target(false)[0]!, slug: 'no-such-collection' }])
    expect(f!.status).toBe('not-checked')
    state.crash = true
    const out = await runServerBackDoorCheck(payload, [{ ...target(false)[0]!, seed: seedThenCrash }], { isRefusal: (e) => isRefusal(e) || /NoSuchTransaction/.test(String((e as Error).message)) })
    expect(out.filter((x) => x.path!.includes('-no-transaction')).map((x) => x.status)).toEqual(['pass', 'pass', 'pass'])
  })
  it('is not-checked when nothing matches the protected rows', async () => {
    const [f] = await runServerBackDoorCheck(payload, [{ ...target(false)[0]!, protectedWhere: { title: { equals: 'nothing like this' } } }])
    expect(f!.status).toBe('not-checked')
  })
})

describe('4. host rules that replace defaults', () => {
  const install = (answer: HostAnswer | undefined) => {
    state.host.allowClosed = answer ? async () => { if (answer.throws) throw answer.value; return answer.value } : undefined
  }
  const option = (extra: object = {}) => ({
    id: 'allowClosed',
    install,
    attempt: () => payload.create({ collection: 'invites' as never, data: { target: closed.id } as never, user: actor.user as never, overrideAccess: false }),
    restore: async () => void (await payload.delete({ collection: 'invites' as never, where: { id: { exists: true } } as never, overrideAccess: true })),
    ...extra,
  })

  const names = (fs: Finding[]) => fs.filter((f) => f.status === 'fail').map((f) => f.path!.split(' · ')[1])
  it('stays quiet when only an exact true can open the default', async () => {
    const out = await runHostRuleCheck([option()])
    expect(out).toHaveLength(HOST_ANSWERS.length)
    expect(HOST_ANSWERS.map((a) => a.name)).toEqual(expect.arrayContaining(['one', 'yes-string', 'empty-array', 'false', 'undefined', 'function']))
    expect(bad(out)).toEqual([])
    expect(out.find((f) => f.path!.endsWith('true'))!.how).toMatch(/allowed to widen/)
  })
  it('fires on every junk answer that a truthy test reads as yes, and on a throw read as yes', async () => {
    state.truthyHost = true
    expect(names(await runHostRuleCheck([option()]))).toEqual(['empty-object', 'throw', 'where', 'one', 'yes-string', 'empty-array', 'function'])
  })
  it('lets the option say a narrow where may widen', async () => {
    state.truthyHost = true
    expect(names(await runHostRuleCheck([option({ mayWiden: ['true', 'where'] })]))).not.toContain('where')
  })
  it('is not-checked, never a refusal, when the attempt dies with a database error', async () => {
    state.crash = true
    const out = await runHostRuleCheck([option()])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ status: 'not-checked' })
    expect(out[0]!.how).toMatch(/isn’t a refusal/)
    state.crash = false
    state.host.allowClosed = undefined
    const inMiddle = await runHostRuleCheck([option({ attempt: async () => { if (state.host.allowClosed) throw new Error('NoSuchTransaction') ; throw Object.assign(new Error('No'), { status: 403 }) } })])
    expect(inMiddle.filter((f) => f.status === 'pass')).toEqual([])
  })
  describe('veto mode', () => {
    const veto = () => ({
      id: 'vetoInvite',
      kind: 'veto' as const,
      install: (answer: HostAnswer | undefined) => {
        state.host.vetoInvite = answer ? async () => { if (answer.throws) throw answer.value; return answer.value } : undefined
      },
      attempt: () => payload.create({ collection: 'invites' as never, data: { target: owner.id } as never, user: actor.user as never, overrideAccess: false }),
      restore: async () => void (await payload.delete({ collection: 'invites' as never, where: { id: { exists: true } } as never, overrideAccess: true })),
    })
    it('stays quiet when only null and undefined go ahead and every other answer vetoes', async () => {
      const out = await runHostRuleCheck([veto()])
      expect(out).toHaveLength(HOST_ANSWERS.length)
      expect(bad(out)).toEqual([])
      expect(out.find((f) => f.path!.endsWith('null'))!.how).toMatch(/go ahead/)
      expect(out.find((f) => f.path!.endsWith('false'))!.how).toMatch(/veto applied/)
    })
    it('fires for each answer a veto lets through, one test per answer', async () => {
      state.trueOnlyVeto = true
      // Only an exact true vetoes in this variant, so every other answer that must refuse is a finding. A throw vetoes here.
      const expected = ['empty-object', 'zero', 'empty-string', 'where', 'one', 'yes-string', 'empty-array', 'false', 'function']
      expect(names(await runHostRuleCheck([veto()]))).toEqual(expected)
    })
    it('fires when a falsy answer or a thrown veto lets the operation through', async () => {
      state.looseVeto = true
      expect(names(await runHostRuleCheck([veto()]))).toEqual(['zero', 'empty-string', 'throw', 'false'])
    })
    it('lets a plugin that documents another go-ahead answer say so, and says it', async () => {
      state.looseVeto = true
      const out = await runHostRuleCheck([{ ...veto(), goAhead: ['null', 'undefined', 'false', 'zero', 'empty-string'] }])
      expect(names(out)).toEqual(['throw'])
      expect(out.find((f) => f.path!.endsWith('false'))!.how).toMatch(/documented as go ahead/)
    })
  })
  it('is not-checked when the default doesn’t restrict anything, and puts the host option back', async () => {
    state.host.allowClosed = async () => true
    const [f] = await runHostRuleCheck([option({ install: () => undefined })])
    expect(f!.status).toBe('not-checked')
    state.host = {}
    await runHostRuleCheck([option()])
    expect(state.host.allowClosed).toBeUndefined()
  })
})

describe('review round 2', () => {
  const fakeBulk = (errors: { message: string }[], docs: unknown[] = []) =>
    ({
      find: async () => ({ docs: [{ id: 'row1' }] }),
      findByID: async () => ({ id: 'row1' }),
      update: async (a: { where?: unknown }) => (a.where ? { docs, errors } : Object.assign(Promise.reject(Object.assign(new Error('No'), { status: 403 })))),
      delete: async (a: { where?: unknown }) => (a.where ? { docs, errors } : Promise.reject(Object.assign(new Error('No'), { status: 403 }))),
      create: async () => Promise.reject(Object.assign(new Error('No'), { status: 403 })),
    }) as unknown as Payload
  const col = [{ slug: 'notes', identity: { role: 'owner', user: { id: 'u1' } } as unknown as Viewer, protectedWhere: {}, data: {}, holdsForServerCode: true, seed: async () => undefined }]
  const bulkOf = (fs: Finding[]) => fs.filter((f) => f.path!.includes('bulk')).map((f) => f.status)

  it('A: a TypeError in a bulk errors list is not-checked, and a real refusal there passes', async () => {
    expect(bulkOf(await runServerBackDoorCheck(fakeBulk([{ message: "Cannot read properties of undefined (reading 'id')" }]), col))).toEqual(['not-checked', 'not-checked', 'not-checked', 'not-checked'])
    expect(bulkOf(await runServerBackDoorCheck(fakeBulk([{ message: 'You are not allowed to perform this action.' }]), col))).toEqual(['pass', 'pass', 'pass', 'pass'])
  })
  it('B: a veto that refuses only on true fails for a reason string', async () => {
    const calls: string[] = []
    let answer: HostAnswer | undefined
    const out = await runHostRuleCheck([
      {
        id: 'v',
        kind: 'veto',
        install: (a) => void (answer = a),
        attempt: async () => {
          calls.push('x')
          if (answer?.value === true) throw Object.assign(new Error('No'), { status: 403 })
        },
      },
    ])
    expect(out.filter((f) => f.status === 'fail').map((f) => f.path)).toEqual(['v · empty-object', 'v · zero', 'v · empty-string', 'v · throw', 'v · where', 'v · one', 'v · yes-string', 'v · empty-array', 'v · false', 'v · function'])
  })
  it('C: the plugin’s own “Use a replica set” advice is a refusal, Mongo’s own message is not', async () => {
    const run = (said: string) => runTransactionCheck({ start: async () => { throw new Error(said) }, write: async () => undefined })
    expect((await run('This plugin needs transactions. Use a replica set.'))[0]).toMatchObject({ status: 'pass' })
    expect((await run('Transaction numbers are only allowed on a replica set member or mongos'))[0]).toMatchObject({ status: 'not-checked' })
  })
  it('F: one identity allowed and the other got a 500 is a finding', async () => {
    const [f] = await runResponseDifferenceProbe({
      identities: [minor, closed],
      operations: [{ id: 'five', title: 'f', run: async (who: Viewer) => { if (who.role === 'minor') return { ok: true }; throw Object.assign(new Error('boom'), { status: 500 }) } }],
    })
    expect(f).toMatchObject({ status: 'fail' })
    const [g] = await runResponseDifferenceProbe({
      identities: [minor, closed],
      operations: [{ id: 'both', title: 'f', run: async () => { throw Object.assign(new Error('boom'), { status: 500 }) } }],
    })
    expect(g).toMatchObject({ status: 'not-checked' })
  })
  it('low: short ids are masked, reordered keys are equal, and a null data does not append null', async () => {
    const mk = (id: string): Viewer => ({ role: id === '1' ? 'minor' : 'closed', user: { id } as never }) as Viewer
    const [short] = await runResponseDifferenceProbe({ identities: [mk('1'), mk('2')], operations: [{ id: 's', title: 's', run: async (w: Viewer) => ({ who: (w.user as { id: string }).id }) }] })
    expect(short).toMatchObject({ status: 'pass' })
    const [order] = await runResponseDifferenceProbe({ identities: [minor, closed], operations: [{ id: 'o', title: 'o', run: async (w: Viewer) => (w.role === 'minor' ? { a: 1, b: { c: 2, d: 3 } } : { b: { d: 3, c: 2 }, a: 1 }) }] })
    expect(order).toMatchObject({ status: 'pass' })
    const [nul] = await runResponseDifferenceProbe({ identities: [minor, closed], operations: [{ id: 'n', title: 'n', run: async (w: Viewer) => { throw Object.assign(new Error('Nope'), { status: 403, data: w.role === 'minor' ? null : undefined }) } }] })
    expect(nul).toMatchObject({ status: 'pass' })
  })
})

describe('review round 3', () => {
  /** Shaped like the driver's own errors: the transaction name is in codeName, code and errorLabels, and the message is plain text. */
  const driverError = (codeName: string, code: number, labels: string[], message: string) => Object.assign(new Error(message), { name: 'MongoServerError', code, codeName, errorLabels: labels })
  const realShaped = [
    driverError('NoSuchTransaction', 251, ['TransientTransactionError'], 'Given transaction number 3 does not match any in-progress transactions. The active transaction number is 2'),
    driverError('WriteConflict', 112, ['TransientTransactionError'], 'Caused by :: Write conflict during plan execution and yielding is disabled. :: Please retry your operation or multi-document transaction.'),
    driverError('TransactionTooOld', 225, ['TransientTransactionError'], 'Transaction 1 has been aborted.'),
    // Only the label names it, and only a cause carries the driver error.
    Object.assign(new Error('write failed'), { name: 'MongoServerError', errorLabels: ['TransientTransactionError'] }),
    Object.assign(new Error('Could not save'), { cause: driverError('WriteConflict', 112, [], 'Please retry your operation or multi-document transaction.') }),
    Object.assign(new Error('Could not save'), { status: 403, cause: Object.assign(new Error('x'), { errorLabels: ['TransientTransactionError'] }) }),
  ]
  it('reads real-shaped transaction errors as database errors, never as refusals', () => {
    for (const e of realShaped) {
      expect(isTransactionError(e) || isDatabaseError(e)).toBe(true)
      expect(isRefusal(e)).toBe(false)
    }
    expect(isTransactionError(realShaped[0])).toBe(true)
    expect(isTransactionError(realShaped[3])).toBe(true)
    expect(isTransactionError(realShaped[4])).toBe(true)
    expect(isRefusal(Object.assign(new Error('No'), { status: 403 }))).toBe(true)
  })
  it('1: the transactions check is not-checked for real-shaped errors, at start-up and at the write', async () => {
    for (const e of realShaped) {
      expect((await runTransactionCheck({ start: async () => { throw e }, write: async () => undefined }))[0]!.status).toBe('not-checked')
      const [f] = await runTransactionCheck({ start: async () => ({ payload: await boot('no-tx-shaped', false) }), write: async () => { throw e } })
      expect(f!.status).toBe('not-checked')
      // Even a custom pattern that matches the message can't turn a database error into a refusal.
      const [g] = await runTransactionCheck({ start: async () => ({ payload: await boot('no-tx-shaped', false) }), write: async () => { throw e }, refusal: /./ })
      expect(g!.status).toBe('not-checked')
    }
  })
  it('1: a real WriteConflict from the in-memory replica set is not a refusal', async () => {
    const client = new MongoClient(mongo.getUri('conflict'))
    const s1 = client.startSession()
    const s2 = client.startSession()
    let caught: unknown
    try {
      await client.connect()
      const coll = client.db('conflict').collection('rows')
      await coll.insertOne({ _id: 1 as never, n: 0 })
      s1.startTransaction()
      s2.startTransaction()
      await coll.updateOne({ _id: 1 as never }, { $set: { n: 1 } }, { session: s1 })
      await coll.updateOne({ _id: 1 as never }, { $set: { n: 2 } }, { session: s2 }).catch((e) => void (caught = e))
    } finally {
      await s1.abortTransaction().catch(() => undefined)
      await s2.abortTransaction().catch(() => undefined)
      await s1.endSession()
      await s2.endSession()
      await client.db('conflict').dropDatabase().catch(() => undefined)
      await client.close()
    }
    expect(caught).toBeTruthy()
    expect((caught as { codeName?: string }).codeName).toBe('WriteConflict')
    expect(isTransactionError(caught)).toBe(true)
    expect(isRefusal(caught)).toBe(false)
    const [f] = await runTransactionCheck({ start: async () => ({ payload: await boot('no-tx-conflict', false) }), write: async () => { throw caught } })
    expect(f!.status).toBe('not-checked')
  })
  it('2: a validation error is not a refusal anywhere', async () => {
    const validation = [Object.assign(new Error('The following field is invalid: title'), { name: 'ValidationError', status: 400 }), Object.assign(new Error('bad'), { status: 422 }), Object.assign(new Error('bad'), { status: 400 })]
    for (const e of validation) {
      expect(isValidationError(e)).toBe(true)
      expect(isRefusal(e)).toBe(false)
    }
    const boom = (e: unknown) => async () => { throw e }
    expect((await runResponseDifferenceProbe({ identities: [minor, closed], operations: [{ id: 'v', title: 'v', run: boom(validation[0]) }] }))[0]!.status).toBe('not-checked')
    const half = async (who: Viewer) => { if (who.role === 'minor') throw validation[0]; return { ok: true } }
    expect((await runResponseDifferenceProbe({ identities: [minor, closed], operations: [{ id: 'v', title: 'v', run: half }] }))[0]!.status).toBe('fail')
    const [t] = await runTransactionCheck({ start: async () => ({ payload: await boot('no-tx-validation', false) }), write: boom(Object.assign(new Error('transaction field is invalid'), { name: 'ValidationError', status: 400 })) })
    expect(t!.status).toBe('not-checked')
    const [h] = await runHostRuleCheck([{ id: 'h', install: () => undefined, attempt: boom(validation[0]) }])
    expect(h!.status).toBe('not-checked')
    // A probe with a typo in its data: validation fails for every identity and probe, so nothing passes.
    const fake = { find: async () => ({ docs: [{ id: 'r' }] }), update: async () => { throw validation[0] }, delete: async () => { throw validation[0] }, create: async () => { throw validation[0] } } as unknown as Payload
    const typo = await runServerBackDoorCheck(fake, [{ slug: 'notes', identity: owner, protectedWhere: {}, data: { tittle: 'x' }, create: { x: 1 }, holdsForServerCode: true, seed: async () => undefined }])
    expect(typo).toHaveLength(10)
    expect(typo.filter((f) => f.status !== 'not-checked')).toEqual([])
  })
  it('4: a silent field lock passes, a typo in data or an unchanged value is not-checked, and an open update still fires', async () => {
    // Straight through the adapter: the plugin's own delete hook refuses to remove a locked row.
    const wipe = () => payload.db.deleteMany({ collection: 'notes' as never, where: {}, req: {} as never })
    const seedRow = async () => {
      await wipe()
      await payload.create({ collection: 'notes' as never, data: { title: 'kept', owner: owner.id, locked: true } as never, overrideAccess: true })
    }
    const col = (data: Record<string, unknown>) => [{ slug: 'notes', identity: owner, protectedWhere: { locked: { equals: true } }, data, seed: seedRow }]
    const updates = (fs: Finding[]) => fs.filter((f) => /update/.test(f.path!))
    state.silentLock = true
    const silent = updates(await runServerBackDoorCheck(payload, col({ title: 'changed' })))
    expect(silent.map((f) => f.status)).toEqual(['pass', 'pass'])
    expect(silent[0]!.how).toMatch(/silent lock/)
    expect(updates(await runServerBackDoorCheck(payload, col({ tittle: 'changed' }))).map((f) => f.status)).toEqual(['not-checked', 'not-checked'])
    expect(updates(await runServerBackDoorCheck(payload, col({ title: 'kept' }))).map((f) => f.status)).toEqual(['not-checked', 'not-checked'])
    // The same data on a plugin with no lock at all is a hole.
    state.silentLock = false
    state.txHole = true
    expect(updates(await runServerBackDoorCheck(payload, col({ title: 'changed' }))).map((f) => f.status)).toEqual(['pass', 'fail'])
    await wipe()
  })
  it('4: a delete or create that answers but leaves nothing changed passes', async () => {
    const calls: string[] = []
    const rows = [{ id: 'r1', title: 'kept' }]
    const fake = {
      find: async () => ({ docs: rows }),
      findByID: async ({ id }: { id: string }) => (id === 'ghost' ? null : rows[0]),
      update: async () => ({ docs: [], errors: [] }),
      delete: async () => (calls.push('d'), { id: 'r1' }),
      create: async () => ({ id: 'ghost' }),
    } as unknown as Payload
    const out = await runServerBackDoorCheck(fake, [{ slug: 'notes', identity: owner, protectedWhere: {}, data: { title: 'x' }, create: { title: 'y' }, seed: async () => undefined }])
    const by = Object.fromEntries(out.map((f) => [f.path!.split(' · ')[1], f]))
    expect(by['delete-no-transaction']).toMatchObject({ status: 'pass' })
    expect(by['delete-no-transaction']!.how).toMatch(/still there/)
    expect(by['create-no-transaction']!.how).toMatch(/no new row/)
  })
  it('5: a bulk refusal passes only when it carries a recognized refusal or the standard message', async () => {
    const fake = (errors: object[]) => ({
      find: async () => ({ docs: [{ id: 'row1', title: 'kept' }] }),
      findByID: async () => ({ id: 'row1', title: 'kept' }),
      update: async (a: { where?: unknown }) => (a.where ? { docs: [], errors } : Promise.reject(Object.assign(new Error('No'), { status: 403 }))),
      delete: async (a: { where?: unknown }) => (a.where ? { docs: [], errors } : Promise.reject(Object.assign(new Error('No'), { status: 403 }))),
      create: async () => Promise.reject(Object.assign(new Error('No'), { status: 403 })),
    }) as unknown as Payload
    const col = [{ slug: 'notes', identity: owner, protectedWhere: {}, data: { title: 'x' }, holdsForServerCode: true, seed: async () => undefined }]
    const bulk = (fs: Finding[]) => fs.filter((f) => f.path!.includes('bulk')).map((f) => f.status)
    expect(bulk(await runServerBackDoorCheck(fake([{ message: 'You are not allowed to perform this action.' }]), col))).toEqual(['pass', 'pass', 'pass', 'pass'])
    expect(bulk(await runServerBackDoorCheck(fake([{ message: 'Members only.', status: 403 }]), col))).toEqual(['pass', 'pass', 'pass', 'pass'])
    expect(bulk(await runServerBackDoorCheck(fake([{ message: 'Members only.' }]), col))).toEqual(['not-checked', 'not-checked', 'not-checked', 'not-checked'])
    expect(bulk(await runServerBackDoorCheck(fake([{ message: 'The following field is invalid: title', status: 400 }]), col))).toEqual(['not-checked', 'not-checked', 'not-checked', 'not-checked'])
    expect(bulk(await runServerBackDoorCheck(fake([{ message: 'Members only.' }]), col, { isRefusal: (e) => /Members only/.test(String((e as Error).message)) }))).toEqual(['pass', 'pass', 'pass', 'pass'])
  })
})
