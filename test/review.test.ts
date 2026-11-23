import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { HOST_ANSWERS, runHostRuleCheck, runResponseDifferenceProbe, runServerBackDoorCheck, runTransactionCheck, type Finding, type HostAnswer, type Viewer } from '../src/index.js'
import { fixturePlugin, state } from './fixtures/fixturePlugin.js'

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
const boot = async (key: string, transactions: boolean) => {
  const p = await getPayload({ config: await config(key, transactions), key })
  booted.push(p)
  return p
}
const reset = () => {
  state.leakyMessage = state.leakyEvents = state.truthyHost = state.bulkHole = state.accessOnly = state.txHole = false
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
  for (const p of booted) await p.destroy()
  await mongo?.stop()
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
    state.host.vetoInvite = async (id) => id === minor.id
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
        { id: 'status', title: 's', run: bySide(err(403), err(400)) },
        { id: 'shape', title: 'h', run: bySide({ id: 'x', docs: [] }, { id: 'x' }) },
        { id: 'allowed', title: 'a', run: bySide({ ok: true }, err(403)) },
        { id: 'same', title: 'same', run: bySide(err(403), err(403)) },
        { id: 'ids-only', title: 'ids', run: bySide({ id: '507f1f77bcf86cd799439011' }, { id: '507f1f77bcf86cd799439012' }) },
      ],
    })
    expect(got.map((f) => [f.path, f.status])).toEqual([['status', 'fail'], ['shape', 'fail'], ['allowed', 'fail'], ['same', 'pass'], ['ids-only', 'pass']])
  })
  it('reports not-checked for two server errors, and for identities that are the same role', async () => {
    const boom = async () => { throw Object.assign(new Error('db down'), { status: 500 }) }
    expect((await runResponseDifferenceProbe({ identities: [minor, closed], operations: [{ id: 'x', title: 'x', run: boom }] }))[0]!.status).toBe('not-checked')
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
  const target = (holdsForServerCode: boolean) => [{ slug: 'notes', identity: owner, protectedWhere: { locked: { equals: true } }, data: { title: 'changed' }, holdsForServerCode, seed }]
  const ids = (fs: Finding[]) => fs.filter((f) => f.status === 'fail').map((f) => f.path!.split(' · ')[1])
  afterAll(async () => void (await payload.delete({ collection: 'notes' as never, where: { id: { exists: true } } as never, overrideAccess: true })))

  it('stays quiet when the lock is in access and in hooks', async () => {
    const out = await runServerBackDoorCheck(payload, target(true))
    expect(out).toHaveLength(6)
    expect(bad(out)).toEqual([])
  })
  it('fires on bulk update and delete when bulk skips the lock', async () => {
    state.bulkHole = true
    expect(ids(await runServerBackDoorCheck(payload, target(false)))).toEqual(['bulk-update', 'bulk-delete'])
  })
  it('fires on overrideAccess when the lock is only an access function, but only if the rule is meant to hold for server code', async () => {
    state.accessOnly = true
    expect(ids(await runServerBackDoorCheck(payload, target(true)))).toEqual(['update-override-access', 'delete-override-access'])
    expect(ids(await runServerBackDoorCheck(payload, target(false)))).toEqual([])
  })
  it('fires on disableTransaction when the hook needs a transaction to run', async () => {
    state.txHole = true
    expect(ids(await runServerBackDoorCheck(payload, target(false)))).toEqual(['update-no-transaction', 'delete-no-transaction'])
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

  it('stays quiet when only an exact true can open the default', async () => {
    const out = await runHostRuleCheck([option()])
    expect(out).toHaveLength(HOST_ANSWERS.length)
    expect(bad(out)).toEqual([])
    expect(out.find((f) => f.path!.endsWith('true'))!.how).toMatch(/allowed to widen/)
  })
  it('fires on every junk answer that a truthy test reads as yes, and on a throw read as yes', async () => {
    state.truthyHost = true
    const failed = (await runHostRuleCheck([option()])).filter((f) => f.status === 'fail').map((f) => f.path!.split(' · ')[1])
    expect(failed).toEqual(['empty-object', 'throw', 'where'])
  })
  it('lets the option say a narrow where may widen', async () => {
    state.truthyHost = true
    const failed = (await runHostRuleCheck([option({ mayWiden: ['true', 'where'] })])).filter((f) => f.status === 'fail').map((f) => f.path!.split(' · ')[1])
    expect(failed).toEqual(['empty-object', 'throw'])
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
