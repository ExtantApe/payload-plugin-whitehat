import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { MongoClient } from 'mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { APIError, AuthenticationError, BasePayload, buildConfig, Forbidden, LockedAuth, NotFound, UnverifiedEmail, ValidationError, type Payload } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { HOST_ANSWERS, TRANSACTIONS_REQUIRED, isDatabaseError, isRefusal, isTransactionError, isValidationError, runHostRuleCheck, runResponseDifferenceProbe, runServerBackDoorCheck, runTransactionCheck, type Finding, type HostAnswer, type Viewer } from '../src/index.js'
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
    const plain = async () => { throw Object.assign(new Error('transaction aborted'), { codeName: 'NoSuchTransaction', errorLabels: ['TransientTransactionError'] }) }
    expect((await runResponseDifferenceProbe({ identities: [minor, closed], operations: [{ id: 'x', title: 'x', run: plain }] }))[0]!.status).toBe('not-checked')
    const half = async (who: Viewer) => { if (who.role === 'minor') throw new Error('crash'); throw Object.assign(new Error('No'), { status: 403 }) }
    expect((await runResponseDifferenceProbe({ identities: [minor, closed], operations: [{ id: 'x', title: 'x', run: half }] }))[0]!.status).toBe('not-checked')
    expect((await runResponseDifferenceProbe({ identities: [minor, closed], operations: [{ id: 'x', title: 'x', run: plain }], isRefusal: () => true }))[0]!.status).toBe('not-checked')
    const plainRefusal = async () => { throw new Error('Members only') } // a caller's own predicate is trusted for text
    expect((await runResponseDifferenceProbe({ identities: [minor, closed], operations: [{ id: 'x', title: 'x', run: plainRefusal }], isRefusal: () => true }))[0]!.status).toBe('pass')
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
    // Payload's own bulk entries carry only text, so they are not-checked until the plugin adds a status or the marker.
    expect(bad(out)).toEqual(['not-checked:notes · bulk-update-server-code', 'not-checked:notes · bulk-delete-server-code'])
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
  it('is not-checked for a wrong collection slug, and a custom refusal can’t rescue a database error', async () => {
    const [f] = await runServerBackDoorCheck(payload, [{ ...target(false)[0]!, slug: 'no-such-collection' }])
    expect(f!.status).toBe('not-checked')
    state.crash = true
    const out = await runServerBackDoorCheck(payload, [{ ...target(false)[0]!, seed: seedThenCrash }], { isRefusal: (e) => isRefusal(e) || /NoSuchTransaction/.test(String((e as Error).message)) })
    // The access rule refuses update and delete; the create reaches the hook, which dies with NoSuchTransaction. A custom pattern can't make that a refusal.
    expect(out.filter((x) => x.path!.includes('-no-transaction')).map((x) => x.status)).toEqual(['pass', 'pass', 'not-checked'])
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
    it('throws a config error for a goAhead that would turn the veto check off', async () => {
      for (const bad of [['true'], ['throw'], ['null', 'empty-object'], ['zero'], ['where'], ['function'], [0], [''], ['null', 0], ['undefined', '']]) {
        await expect(runHostRuleCheck([{ ...veto(), goAhead: bad as never }])).rejects.toThrow(/config error.*only null, undefined and false/)
      }
      await expect(runHostRuleCheck([{ ...veto(), goAhead: 'true' as never }])).rejects.toThrow(/config error/)
      await expect(runHostRuleCheck([{ ...veto(), goAhead: true as never }])).rejects.toThrow(/config error/)
      // Nothing ran before the error: no operation was tried and the option was not installed.
      expect(state.host.vetoInvite).toBeUndefined()
    })
    it('accepts the three allowed goAhead answers, and an empty list', async () => {
      await expect(runHostRuleCheck([{ ...veto(), goAhead: ['null', 'undefined', 'false'] }])).resolves.toBeTruthy()
      await expect(runHostRuleCheck([{ ...veto(), goAhead: [] }])).resolves.toBeTruthy()
    })
    it('fires when a falsy answer or a thrown veto lets the operation through', async () => {
      state.looseVeto = true
      expect(names(await runHostRuleCheck([veto()]))).toEqual(['zero', 'empty-string', 'throw', 'false'])
    })
    it('lets a plugin that documents another go-ahead answer say so, and says it', async () => {
      state.looseVeto = true
      const out = await runHostRuleCheck([{ ...veto(), goAhead: ['null', 'undefined', 'false'] }])
      expect(names(out)).toEqual(['zero', 'empty-string', 'throw'])
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
  const fakeBulk = (errors: { message: string; status?: number }[], docs: unknown[] = []) =>
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
    expect(bulkOf(await runServerBackDoorCheck(fakeBulk([{ message: 'You are not allowed to perform this action.' }]), col))).toEqual(['not-checked', 'not-checked', 'not-checked', 'not-checked'])
    expect(bulkOf(await runServerBackDoorCheck(fakeBulk([{ message: 'No', status: 403 }]), col))).toEqual(['pass', 'pass', 'pass', 'pass'])
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
      const [g] = await runTransactionCheck({ start: async () => ({ payload: await boot('no-tx-shaped', false) }), write: async () => { throw e }, refusal: () => true })
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
    expect(updates(await runServerBackDoorCheck(payload, col({ title: 'changed' }))).map((f) => f.status)).toEqual(['not-checked', 'fail'])
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
    expect(bulk(await runServerBackDoorCheck(fake([{ message: 'You are not allowed to perform this action.' }]), col))).toEqual(['not-checked', 'not-checked', 'not-checked', 'not-checked'])
    expect(bulk(await runServerBackDoorCheck(fake([{ message: 'Members only.', status: 403 }]), col))).toEqual(['pass', 'pass', 'pass', 'pass'])
    expect(bulk(await runServerBackDoorCheck(fake([{ message: 'Members only.' }]), col))).toEqual(['not-checked', 'not-checked', 'not-checked', 'not-checked'])
    expect(bulk(await runServerBackDoorCheck(fake([{ message: 'The following field is invalid: title', status: 400 }]), col))).toEqual(['not-checked', 'not-checked', 'not-checked', 'not-checked'])
    expect(bulk(await runServerBackDoorCheck(fake([{ message: 'Members only.' }]), col, { isRefusal: (e) => /Members only/.test(String((e as Error).message)) }))).toEqual(['pass', 'pass', 'pass', 'pass'])
  })
})

describe('interface strings', () => {
  it('no button label ends with a period (an ellipsis is fine)', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../src/client/RetestSelected.tsx', import.meta.url), 'utf8')
    const labels = [...src.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].flatMap((m) => [...m[1]!.matchAll(/'([^']*)'|`([^`]*)`/g)].map((s) => s[1] ?? s[2]!))
    expect(labels.length).toBeGreaterThan(0)
    for (const l of labels) expect(/\.\s*$/.test(l.replace(/\$\{[^}]*\}/g, 'x')) && !/…\s*$/.test(l), l).toBe(false)
  })
})

const marker = (message = 'This change needs a transaction, so it wasn’t made.', extra: Record<string, unknown> = {}) => Object.assign(new APIError(message, 403, { refusal: 'transactions-required' }), extra)

describe('round 12: a refusal is the marker or a bare 401, 403 or 404, and nothing else', () => {
  // Fixture texts in the spirit of the round 8 to 11 probes: generic public driver wording, made up, never read by the rule.
  const REFUSAL = 'This change needs a transaction, so it wasn’t made.'
  const DRIVER_TEXTS = [
    'Cannot call abortTransaction twice',
    'No transaction started',
    'Transaction already in progress',
    'Transaction numbers are only allowed on storage engines that support document-level locking',
    'Cannot create namespace test.notes in multi-document transaction.',
    'writeConcern is not allowed within a multi-statement transaction',
    'The transaction cannot be committed: the primary stepped down',
    'E11000 duplicate key error collection: test.notes index: _id_ dup key: { _id: 1 }',
    'connection 3 to 127.0.0.1:27017 closed',
    'Server selection timed out after 30000 ms',
    'not primary',
    'Use of expired sessions is not permitted',
    REFUSAL,
    'This plugin needs transactions. Use a replica set.',
    'You are not allowed to perform this action.',
    `${REFUSAL} E11000 duplicate key error`,
  ]

  it('the marker a plugin throws itself, with Payload’s APIError, is a refusal', () => {
    const e = marker()
    expect(e).toBeInstanceOf(Error)
    expect(e.data).toEqual({ refusal: 'transactions-required' })
    expect(isRefusal(e)).toBe(true)
    expect(isRefusal(marker('Anything else the plugin wants to say.'))).toBe(true)
    expect(isRefusal(marker(REFUSAL, { isPublic: false }))).toBe(true)
    // A plain object copy of the same shape counts too, since the shape is what is trusted.
    expect(isRefusal(Object.assign(new Error('x'), { status: 403, data: { refusal: TRANSACTIONS_REQUIRED } }))).toBe(true)
    expect(isRefusal(Object.assign(new Error('x'), { status: 403, data: { refusal: 'something-else' } }))).toBe(false)
  })
  it('the marker needs status 403 as a plain own number', () => {
    const data = { refusal: TRANSACTIONS_REQUIRED }
    for (const status of [undefined, 500, '403', 403.5, 403n, [403], 401, 404, 400, NaN]) {
      const e = status === undefined ? Object.assign(new Error('x'), { data }) : Object.assign(new Error('x'), { status, data })
      // 401 and 404 with a data that claims `refusal` are not refusals either (claimsRefusal), but the loop only asserts the other statuses.
      if (status !== 401 && status !== 404) expect(isRefusal(e), String(status)).toBe(false)
    }
    expect(isRefusal(Object.assign(new Error('x'), { statusCode: 403, data: { refusal: TRANSACTIONS_REQUIRED } }))).toBe(false) // the marker needs `status`, and a bare statusCode may not claim the marker in data
    const getter = Object.defineProperty(new Error('x'), 'status', { get: () => 403, enumerable: true })
    expect(isRefusal(Object.assign(getter, { data: { refusal: TRANSACTIONS_REQUIRED } }))).toBe(false)
    const flip = Object.defineProperty(new Error('x'), 'status', { get: () => 403 })
    expect(isRefusal(flip)).toBe(false)
    // The marker's status cannot come from the prototype either.
    const inherited = Object.assign(Object.create({ status: 403 }) as Error, { message: 'x', data: { refusal: TRANSACTIONS_REQUIRED } })
    expect(isRefusal(inherited)).toBe(false)
  })
  it('the marker needs data to be exactly a plain { refusal: "transactions-required" }', () => {
    class D { refusal = TRANSACTIONS_REQUIRED }
    const inheritedRefusal = Object.create({ refusal: TRANSACTIONS_REQUIRED }) as object
    const nullProto = Object.assign(Object.create(null) as object, { refusal: TRANSACTIONS_REQUIRED })
    const withSymbol = { refusal: TRANSACTIONS_REQUIRED, [Symbol('k')]: 1 }
    const getterData = Object.defineProperty({}, 'refusal', { get: () => TRANSACTIONS_REQUIRED, enumerable: true })
    const bad: unknown[] = [
      new D(), new Proxy({ refusal: TRANSACTIONS_REQUIRED }, {}), [TRANSACTIONS_REQUIRED], Object.assign([], { refusal: TRANSACTIONS_REQUIRED }), nullProto,
      { refusal: TRANSACTIONS_REQUIRED, extra: 1 }, { refusal: TRANSACTIONS_REQUIRED, errors: [] }, inheritedRefusal, withSymbol, getterData,
      { refusal: 'Transactions-Required' }, { refusal: ['transactions-required'] }, null, undefined, 'transactions-required', TRANSACTIONS_REQUIRED,
      new Map([['refusal', TRANSACTIONS_REQUIRED]]),
    ]
    // Null, undefined and a string are skipped: a bare 403 with no data is a refusal on its own. Everything else must fail.
    for (const [i, data] of bad.entries()) {
      if (data === null || data === undefined || typeof data === 'string') continue
      expect(isRefusal(Object.assign(new Error('x'), { status: 403, data })), `data ${i}`).toBe(false)
    }
  })
  it('the marker with a nested error beside it (cause, errors, others) is not a refusal', () => {
    const data = { refusal: TRANSACTIONS_REQUIRED }
    const withKey = (extra: Record<string, unknown>) => Object.assign(marker(), extra)
    expect(isRefusal(marker())).toBe(true) // cause === data, as Payload sets it
    expect(isRefusal(withKey({ cause: new Error('E11000 duplicate key') }))).toBe(false)
    expect(isRefusal(withKey({ cause: { ...data } }))).toBe(false)
    expect(isRefusal(withKey({ cause: undefined }))).toBe(false)
    expect(isRefusal(withKey({ errors: [] }))).toBe(false)
    expect(isRefusal(withKey({ errors: [{ message: 'x' }] }))).toBe(false)
    for (const k of ['originalError', 'errorResponse', 'writeErrors', 'extra', 'code', 'details']) expect(isRefusal(withKey({ [k]: 1 })), k).toBe(false)
    expect(isRefusal(withKey({ [Symbol('s')]: 1 }))).toBe(false)
    const inheritedErrors = Object.assign(Object.create({ errors: [new Error('x')] }) as Error, { message: 'x', status: 403, data })
    expect(isRefusal(inheritedErrors)).toBe(false)
    expect(isRefusal(new Proxy(marker(), {}))).toBe(false)
  })
  it('the marker on a validation error or a Mongo error is not a refusal', () => {
    const data = { refusal: TRANSACTIONS_REQUIRED }
    expect(isRefusal(Object.assign(marker(), { name: 'ValidationError' }))).toBe(false)
    expect(isRefusal(Object.assign(new ValidationError({ collection: 'notes', errors: [{ message: 'x', path: 'title' }] }), { status: 403, data }))).toBe(false)
    expect(isRefusal(Object.assign(marker(), { name: 'MongoServerError' }))).toBe(false)
    expect(isRefusal(Object.assign(marker(), { code: 251, codeName: 'NoSuchTransaction' }))).toBe(false)
    expect(isRefusal(Object.assign(marker(), { errorLabels: ['TransientTransactionError'] }))).toBe(false)
    expect(isRefusal(Object.assign(marker(), { name: 'NoSuchTransaction' }))).toBe(false)
    expect(isRefusal(Object.assign(new Error('x'), { name: 'MongoServerError', code: 251, codeName: 'NoSuchTransaction', status: 403, data }))).toBe(false)
  })
  it('a bare 401, 403 or 404 with an unlisted key, a Map or Set subclass, a Proxy array or a symbol is not a refusal', () => {
    class LyingMap extends Map<unknown, unknown> { override get size() { return 0 } override values() { return [][Symbol.iterator]() as never } override [Symbol.iterator]() { return [][Symbol.iterator]() as never } }
    class LyingSet extends Set<unknown> { override get size() { return 0 } override [Symbol.iterator]() { return [][Symbol.iterator]() as never } override values() { return [][Symbol.iterator]() as never } }
    const lyingMap = new LyingMap([['a', new Error('E11000')]])
    const lyingSet = new LyingSet([new Error('E11000')])
    const proxyArray = new Proxy([new Error('E11000 duplicate key')], {})
    const lyingArray = new Proxy([], { get: (t, k) => (k === 'length' ? 0 : Reflect.get(t, k)) })
    const bare = (extra: Record<PropertyKey, unknown>, status = 403) => Object.assign(new Error('No'), { status }, extra)
    for (const status of [401, 403, 404]) {
      expect(isRefusal(bare({}, status))).toBe(true)
      for (const [name, extra] of Object.entries({ lyingMap: { nested: lyingMap }, lyingSet: { nested: lyingSet }, proxyArray: { inner: proxyArray }, lyingArray: { inner: lyingArray }, deep: { a: { b: { c: new Error('x') } } }, details2: { whatever: [new Error('x')] }, fn: { fn: () => 1 } })) {
        expect(isRefusal(bare(extra, status)), `${status} ${name}`).toBe(false)
      }
      expect(isRefusal(bare({ [Symbol('s')]: new Error('x') }, status))).toBe(false)
    }
    expect(isRefusal(new Proxy(bare({}), {}))).toBe(false)
    expect(isRefusal(Object.assign(new Proxy({}, {}), { status: 403 }))).toBe(false)
  })
  it('own-key values are type-checked: a driver error inside data, isOperational, isPublic, stack, statusCode, message or name is not a refusal', () => {
    const driver = Object.assign(new Error('E11000 duplicate key'), { name: 'MongoNetworkError', codeName: 'HostUnreachable' })
    const pg = Object.assign(new Error('connection terminated'), { code: '57P01', severity: 'FATAL' })
    for (const bad of [driver, pg]) {
      for (const status of [401, 403, 404]) {
        // bare path: the driver error sits in a listed key
        for (const key of ['isOperational', 'isPublic', 'stack', 'statusCode', 'message', 'name']) {
          expect(isRefusal(Object.assign(new Error('No'), { status, [key]: bad })), `${status} ${key}`).toBe(false)
        }
        expect(isRefusal(Object.assign(new Error('No'), { status, data: bad })), `${status} data`).toBe(false)
        expect(isRefusal(Object.assign(new Error('No'), { status, data: { errors: [bad] } })), `${status} data.errors`).toBe(false)
        expect(isRefusal(Object.assign(new Error('No'), { status, data: { inner: bad } })), `${status} data.inner`).toBe(false)
      }
      // marker path
      for (const key of ['isOperational', 'isPublic', 'stack', 'statusCode', 'message', 'name']) {
        expect(isRefusal(Object.assign(marker(), { [key]: bad })), `marker ${key}`).toBe(false)
      }
    }
    // wrong primitive types too
    for (const [key, v] of Object.entries({ isOperational: 'true', isPublic: 1, stack: 5, message: 7, name: {}, statusCode: '403' })) {
      expect(isRefusal(Object.assign(marker(), { [key]: v })), `marker ${key}`).toBe(false)
      expect(isRefusal(Object.assign(new Error('No'), { status: 403, [key]: v })), `bare ${key}`).toBe(false)
    }
    // plain values are fine, and data may be absent or a plain object of plain values
    expect(isRefusal(marker(REFUSAL, { isOperational: true, isPublic: false }))).toBe(true)
    expect(isRefusal(Object.assign(new Error('No'), { status: 403, isOperational: true, isPublic: false, data: { reason: 'x' } }))).toBe(true)
    expect(isRefusal(Object.assign(new Error('No'), { status: 404 }))).toBe(true)
  })
  it('two status fields that disagree, or a status getter, read as unknown', () => {
    expect(isRefusal(Object.assign(new Error('x'), { status: 403, statusCode: 500 }))).toBe(false)
    expect(isRefusal(Object.assign(new Error('x'), { status: 500, statusCode: 403 }))).toBe(false)
    expect(isRefusal(Object.assign(new Error('x'), { status: 403, statusCode: 404 }))).toBe(false)
    expect(isRefusal(Object.assign(marker(), { statusCode: 500 }))).toBe(false)
    expect(isRefusal(Object.assign(new Error('x'), { status: 403, statusCode: 403 }))).toBe(true)
    const getter500 = Object.defineProperty(Object.assign(new Error('x'), { statusCode: 403 }), 'status', { get: () => 500, enumerable: true })
    expect(isRefusal(getter500)).toBe(false)
    const getter403 = Object.defineProperty(Object.assign(new Error('x'), { status: 403 }), 'statusCode', { get: () => 500, enumerable: true })
    expect(isRefusal(getter403)).toBe(false)
  })
  it('round 15 A: an inherited status or statusCode makes the error unknown, on both paths', () => {
    const inh = (key: string, val: unknown, own: object) => Object.assign(Object.create(Object.assign(Object.create(Error.prototype), { [key]: val })), { message: 'x' }, own)
    expect(isRefusal(inh('status', 500, { statusCode: 403 }))).toBe(false)
    expect(isRefusal(inh('status', 403, { statusCode: 403 }))).toBe(false)
    expect(isRefusal(inh('statusCode', 500, { status: 403 }))).toBe(false)
    class E extends Error { get status() { return 500 } }
    expect(isRefusal(Object.assign(new E('x'), { statusCode: 403 }))).toBe(false)
    expect(isRefusal(Object.assign(new E('x'), { statusCode: 403, data: { refusal: TRANSACTIONS_REQUIRED } }))).toBe(false)
    expect(isRefusal(Object.assign(Object.create(Object.assign(Object.create(Error.prototype), { status: 403 })), { data: { refusal: TRANSACTIONS_REQUIRED } }))).toBe(false)
  })
  it('round 15 B: an inherited data, cause, errors or nested key, or a non-text message or name, is unknown', () => {
    const mongo = Object.assign(new Error('x'), { name: 'MongoNetworkError' })
    for (const key of ['data', 'cause', 'errors', 'originalError', 'errorResponse', 'writeErrors', 'result']) {
      const proto = Object.assign(Object.create(Error.prototype), { [key]: key === 'errors' ? [mongo] : { errors: [mongo] } })
      const e = Object.assign(Object.create(proto), { message: 'x', status: 403 })
      expect(isRefusal(e), key).toBe(false)
      if (key !== 'data') expect(isRefusal(Object.assign(Object.create(proto), { message: 'x', status: 403, data: { refusal: TRANSACTIONS_REQUIRED } })), key).toBe(false)
    }
    const msgGetter = Object.assign(Object.create(Object.defineProperty(Object.create(Error.prototype), 'message', { get: () => 'MongoNetworkError' })), { status: 403 })
    expect(isRefusal(msgGetter)).toBe(false)
    const nameObj = Object.assign(Object.create(Object.assign(Object.create(Error.prototype), { name: { toString: () => 'x' } })), { message: 'x', status: 403 })
    expect(isRefusal(nameObj)).toBe(false)
    const proxied = Object.assign(Object.create(new Proxy(Error.prototype, {})), { message: 'x', status: 403 })
    expect(isRefusal(proxied)).toBe(false)
  })
  it('round 15: plain inheritance (subclass, inherited text name or message) still passes', () => {
    class Plain extends Error { constructor(m: string) { super(m); this.name = 'Plain' } }
    expect(isRefusal(Object.assign(new Plain('No'), { status: 403 }))).toBe(true)
    const proto = Object.assign(Object.create(Error.prototype), { name: 'Custom', message: 'No' })
    expect(isRefusal(Object.assign(Object.create(proto), { status: 404 }))).toBe(true)
  })
  it('round 15 C: a stack accessor that gives text is accepted, one that gives a non-text value is not', () => {
    const ok = Object.defineProperty(Object.assign(new Error('x'), { status: 403 }), 'stack', { get: () => 'text', enumerable: false, configurable: true })
    expect(isRefusal(ok)).toBe(true)
    const bad = Object.defineProperty(Object.assign(new Error('x'), { status: 403 }), 'stack', { get: () => ({}), enumerable: false, configurable: true })
    expect(isRefusal(bad)).toBe(false)
  })
  it('round 16: a stack getter that adds originalError (own key or through setPrototypeOf) makes the error unknown, marker and bare', () => {
    const mongo = Object.assign(new Error('x'), { name: 'MongoNetworkError' })
    const viaOwn = (e: Error) => Object.defineProperty(e, 'stack', { get() { Object.defineProperty(e, 'originalError', { value: mongo, enumerable: true, configurable: true }); return 'text' }, enumerable: false, configurable: true })
    const viaProto = (e: Error) => Object.defineProperty(e, 'stack', { get() { Object.setPrototypeOf(e, Object.assign(Object.create(Error.prototype), { originalError: mongo })); return 'text' }, enumerable: false, configurable: true })
    for (const [name, hook] of Object.entries({ own: viaOwn, proto: viaProto })) {
      expect(isRefusal(hook(new APIError('No', 403, { refusal: 'transactions-required' }))), `marker ${name}`).toBe(false)
      expect(isRefusal(hook(Object.assign(new Error('No'), { status: 403 }))), `bare ${name}`).toBe(false)
    }
  })
  it('round 17: an inherited getter on code, codeName, errmsg or errorLabels is never run, and the error reads as unknown, marker and bare', () => {
    const mongo = Object.assign(new Error('x'), { name: 'MongoNetworkError' })
    const effects: Record<string, (e: Error) => void> = {
      status500: (e) => Object.defineProperty(e, 'status', { value: 500, enumerable: true, configurable: true, writable: true }),
      swapData: (e) => Object.defineProperty(e, 'data', { value: { refusal: 'other' }, enumerable: true, configurable: true, writable: true }),
      originalError: (e) => Object.defineProperty(e, 'originalError', { value: mongo, enumerable: true, configurable: true }),
    }
    for (const field of ['code', 'codeName', 'errmsg', 'errorLabels']) {
      for (const [effect, run] of Object.entries(effects)) {
        for (const kind of ['marker', 'bare']) {
          const e = kind === 'marker' ? new APIError('No', 403, { refusal: 'transactions-required' }) : Object.assign(new Error('No'), { status: 403 })
          let calls = 0
          const proto = Object.create(Object.getPrototypeOf(e))
          Object.defineProperty(proto, field, { get() { calls++; run(e); return undefined }, configurable: true })
          Object.setPrototypeOf(e, proto)
          expect(isRefusal(e), `${field} ${effect} ${kind}`).toBe(false)
          expect(calls, `${field} ${effect} ${kind} getter ran`).toBe(0)
        }
      }
    }
  })
  it('round 17: no String() on an object: a label or codeName whose toString is host code is never called', () => {
    let calls = 0
    const hostile = { toString() { calls++; return 'x' } }
    const a = Object.assign(new Error('No'), { status: 403, errorLabels: [hostile] })
    const b = Object.assign(new Error('No'), { status: 403, codeName: hostile })
    expect(isRefusal(a)).toBe(false)
    expect(isRefusal(b)).toBe(false)
    expect(isDatabaseError(a)).toBe(true)
    expect(calls).toBe(0)
  })
  it('a refusal option of the wrong type is a config error, not a quiet not-checked', async () => {
    for (const bad of [/403/, 'forbidden', 42, null, {}]) {
      await expect(runTransactionCheck({ start: async () => { throw marker() }, write: async () => undefined, refusal: bad as never })).rejects.toThrow(/config error.*"refusal"/)
    }
    await expect(runTransactionCheck({ start: async () => { throw marker() }, write: async () => undefined, refusal: () => true })).resolves.toBeTruthy()
  })
  it('a real APIError is read by its own keys: Forbidden, NotFound and the auth errors are bare refusals', () => {
    const t = (_k: string) => 'x'
    for (const e of [new Forbidden(), new NotFound(t as never), new AuthenticationError(t as never), new LockedAuth(t as never), new UnverifiedEmail({ t: t as never })]) expect(isRefusal(e), e.name).toBe(true)
    expect(isRefusal(new APIError('x', 403, { reason: 'x' }))).toBe(false)
    expect(isRefusal(new APIError('x', 500))).toBe(false)
  })
  it('a bare 401, 403 or 404 is a refusal, by status or statusCode', () => {
    for (const status of [401, 403, 404]) {
      expect(isRefusal(Object.assign(new Error('x'), { status })), String(status)).toBe(true)
      expect(isRefusal(Object.assign(new Error('x'), { statusCode: status }))).toBe(true)
    }
  })
  it('any text message is not a refusal, with no status or with 403, as long as it is not bare', () => {
    for (const t of DRIVER_TEXTS) {
      expect(isRefusal(new Error(t)), t).toBe(false)
      expect(isRefusal(t), t).toBe(false)
      expect(isRefusal({ message: t }), t).toBe(false)
      expect(isRefusal(Object.assign(new Error(REFUSAL), { status: 403, cause: new Error(t) })), t).toBe(false)
      expect(isRefusal(Object.assign(new Error(REFUSAL), { status: 403, cause: t })), t).toBe(false)
      expect(isRefusal(Object.assign(new Error(REFUSAL), { name: 'APIError', status: 403, errors: [{ message: t }] })), t).toBe(false)
    }
  })
  it('names like Forbidden, UnauthorizedError and NotFound at other statuses are not refusals', () => {
    for (const name of ['Forbidden', 'UnauthorizedError', 'NotFound', 'APIError']) {
      expect(isRefusal(Object.assign(new Error('No'), { name })), name).toBe(false)
      for (const status of [400, 402, 405, 408, 409, 422, 429, 499, 500, 503]) expect(isRefusal(Object.assign(new Error('No'), { name, status })), `${name} ${status}`).toBe(false)
    }
  })
  it('only an exact integer 401, 403 or 404 counts', () => {
    for (const status of ['403', 403n, [403], 403.5, NaN, null, undefined, { valueOf: () => 403 }, true, 4030]) expect(isRefusal(Object.assign(new Error('No'), { status })), String(status)).toBe(false)
    expect(isRefusal(Object.assign(new Error('No'), { status: '403', statusCode: 403 }))).toBe(false)
  })
  it('a 401, 403 or 404 that nests anything is not a refusal', () => {
    for (const nest of [{ cause: new Error('x') }, { cause: 'x' }, { errors: [{ message: 'x' }] }, { originalError: new Error('x') }, { errorResponse: { message: 'x' } }, { writeErrors: [{}] }, { cause: {} }]) {
      expect(isRefusal(Object.assign(new Error('No'), { status: 403, ...nest })), JSON.stringify(Object.keys(nest))).toBe(false)
    }
  })
  it('a driver error is never a refusal, whatever status it carries', () => {
    expect(isRefusal(Object.assign(new Error('x'), { status: 403, codeName: 'NoSuchTransaction', errorLabels: ['TransientTransactionError'] }))).toBe(false)
    expect(isRefusal(Object.assign(new Error('x'), { status: 404, name: 'MongoServerError', code: 11000 }))).toBe(false)
  })
  it('a validation error, a 5xx, a plain error and non-errors are not refusals', () => {
    for (const e of [Object.assign(new Error('x'), { status: 400 }), Object.assign(new Error('x'), { status: 422 }), Object.assign(new Error('x'), { name: 'ValidationError' }), Object.assign(new Error('x'), { status: 500 }), new Error('Forbidden'), null, undefined, 403, '403', {}]) {
      expect(isRefusal(e)).toBe(false)
    }
  })
  it('an error whose properties throw is not a refusal and does not crash the rule', () => {
    const hostile = (key: string) => Object.defineProperty(Object.assign(new Error('x'), { status: 403 }), key, { get: () => { throw new Error('getter') } })
    for (const key of ['cause', 'errors', 'name', 'code', 'codeName']) expect(isRefusal(hostile(key)), key).toBe(false)
    expect(isRefusal(Object.defineProperty(new Error('x'), 'status', { get: () => { throw new Error('getter') } }))).toBe(false)
    expect(isRefusal(Object.defineProperty(new Error('x'), 'data', { get: () => { throw new Error('getter') } }))).toBe(false)
    const loop: { status: number; cause?: unknown } = { status: 403 }
    loop.cause = loop
    expect(isRefusal(loop)).toBe(false)
  })
  it('the transactions check passes on the marker and on a bare 403, and is not-checked on any text', async () => {
    const at = (thrown: unknown) => runTransactionCheck({ start: async () => { throw thrown }, write: async () => undefined })
    expect((await at(marker()))[0]).toMatchObject({ status: 'pass', path: 'start-up' })
    expect((await at(Object.assign(new Error('x'), { status: 403 })))[0]).toMatchObject({ status: 'pass' })
    for (const t of DRIVER_TEXTS) {
      expect((await at(new Error(t)))[0]!.status, t).toBe('not-checked')
      expect((await at(Object.assign(new Error(REFUSAL), { status: 500, cause: new Error(t) })))[0]!.status, t).toBe('not-checked')
    }
    // A custom predicate is the caller's own rule, but still never rescues a driver error.
    const own = { refusal: () => true }
    expect((await runTransactionCheck({ start: async () => { throw new Error('anything') }, write: async () => undefined, ...own }))[0]!.status).toBe('pass')
    expect((await runTransactionCheck({ start: async () => { throw Object.assign(new Error('x'), { codeName: 'NoSuchTransaction' }) }, write: async () => undefined, ...own }))[0]!.status).toBe('not-checked')
  })
  it('a probe that throws the marker is a refusal in the difference probe and in the host rule check', async () => {
    const refused = async () => { throw marker() }
    expect((await runResponseDifferenceProbe({ identities: [minor, closed], operations: [{ id: 'm', title: 'm', run: refused }] }))[0]!.status).toBe('pass')
    const texty = async () => { throw new Error(REFUSAL) }
    expect((await runResponseDifferenceProbe({ identities: [minor, closed], operations: [{ id: 't', title: 't', run: texty }] }))[0]!.status).toBe('not-checked')
  })
  it('the removed text rules are gone from the package', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../src/review.ts', import.meta.url), 'utf8')
    for (const gone of ['REFUSAL_CUE', 'REFUSAL_ADVICE', 'everySentenceRefuses', 'DATABASE_MESSAGE', 'isDatabaseErrorMessage', 'databaseMessageIn', 'REFUSAL_NAMES']) expect(src.includes(gone), gone).toBe(false)
    expect(await import('../src/index.js')).not.toHaveProperty('isDatabaseErrorMessage')
  })
})
