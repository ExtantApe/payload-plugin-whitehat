import { APIError, Forbidden, isolateObjectProperty, type CollectionConfig, type Config, type Payload, type Plugin } from 'payload'

/** A made-up database fault shaped like the driver's: carries the code, codeName and label, and no HTTP status. */
const driverFault = () => Object.assign(new Error('transaction aborted'), { name: 'MongoServerError', code: 251, codeName: 'NoSuchTransaction', errorLabels: ['TransientTransactionError'] })

/**
 * A tiny made-up plugin with switches for deliberately broken variants. The switches are read at run time, so
 * one Payload instance can play every variant; tests flip them and put them back. Nothing here is a real plugin.
 */
export const state = {
  /** A refusal's message differs for the vetoed and the not-allowed identity. */
  leakyMessage: false,
  /** Only vetoed attempts leave an event row behind. */
  leakyEvents: false,
  /** Host answers count when merely truthy, and a thrown answer counts as yes. */
  truthyHost: false,
  /** Bulk writes skip the lock. */
  bulkHole: false,
  /** The lock lives only in access functions (overrideAccess skips it); no hooks. */
  accessOnly: false,
  /** The lock hook only runs when a transaction exists (disableTransaction skips it). */
  txHole: false,
  /** Updates to a locked row are allowed through access, then quietly put back to the old title by a hook (no error). */
  silentLock: false,
  /** A veto answer counts when merely truthy, and a thrown veto means go ahead. */
  looseVeto: false,
  /** A veto that only refuses on an exact true, and ignores every other answer. */
  trueOnlyVeto: false,
  /** Every guarded write dies with a database error, as a transaction failure would. */
  crash: false,
  /** Host hooks. */
  host: {} as { allowClosed?: (id: string) => unknown; vetoInvite?: (id: string) => unknown },
  /** How the plugin treats transactions being off: do nothing, refuse at start-up, or refuse writes. */
  transactions: 'ignored' as 'ignored' | 'startup' | 'write',
  /** After a note changes, log an event with a skip flag in context: not at all, on the shared req, or on an isolated one. */
  contextLeak: 'off' as 'off' | 'leaky' | 'isolated',
}

const owner = (user: unknown) => String((user as { id?: unknown } | null)?.id ?? '')

const notes: CollectionConfig = {
  slug: 'notes',
  fields: [
    { name: 'title', type: 'text' },
    { name: 'owner', type: 'text' },
    { name: 'locked', type: 'checkbox' },
  ],
  access: {
    read: () => true,
    create: ({ req, data }) => Boolean(req.user) && !(state.accessOnly && (data as { title?: string } | undefined)?.title === 'forbidden'),
    update: ({ req, id }) => {
      if (!req.user) return false
      const mine = { owner: { equals: owner(req.user) } }
      if (state.txHole || state.silentLock) return mine
      const unlocked = { and: [mine, { locked: { not_equals: true } }] }
      return state.bulkHole && !id ? mine : unlocked
    },
    delete: ({ req, id }) => {
      if (!req.user) return false
      const mine = { owner: { equals: owner(req.user) } }
      if (state.txHole) return mine
      const unlocked = { and: [mine, { locked: { not_equals: true } }] }
      return state.bulkHole && !id ? mine : unlocked
    },
  },
  hooks: {
    beforeChange: [
      async ({ data, originalDoc, req, operation }) => {
        if (state.crash) throw driverFault()
        if (state.transactions === 'write' && (await req.transactionID) == null) throw new APIError('This change needs a transaction, so it wasn’t made.', 403, { refusal: 'transactions-required' })
        if (state.accessOnly || (state.txHole && !req.transactionID)) return data
        if (operation === 'create') {
          if ((data as { title?: string } | undefined)?.title === 'forbidden') throw new Forbidden(req.t)
          return data
        }
        if (state.bulkHole || operation !== 'update') return data
        if (state.silentLock) return (originalDoc as { locked?: boolean } | undefined)?.locked ? { ...data, title: (originalDoc as { title?: string }).title } : data
        if ((originalDoc as { locked?: boolean } | undefined)?.locked) throw new Forbidden(req.t)
        return data
      },
    ],
    afterChange: [
      async ({ req }) => {
        if (state.contextLeak === 'off') return
        await req.payload.create({ collection: 'invite-events', data: { kind: 'note-changed' }, overrideAccess: true, context: { skipNoteLock: true }, req: state.contextLeak === 'leaky' ? req : isolateObjectProperty(req, ['context']) })
      },
    ],
    beforeDelete: [
      async ({ req, id }) => {
        if (state.crash) throw driverFault()
        if (state.accessOnly || state.bulkHole) return
        if (state.txHole && !req.transactionID) return
        const doc = (await req.payload.findByID({ collection: 'notes', id, depth: 0, overrideAccess: true, disableErrors: true })) as { locked?: boolean } | null
        if (doc?.locked) throw new Forbidden(req.t)
      },
    ],
  },
}

const events: CollectionConfig = { slug: 'invite-events', fields: [{ name: 'kind', type: 'text' }], access: { read: () => true, create: () => false, update: () => false, delete: () => false } }

/** Invites to closed accounts are refused by default; the host may open them with an exact true, or veto any invite. */
const invites: CollectionConfig = {
  slug: 'invites',
  fields: [{ name: 'target', type: 'text', required: true }],
  access: { read: () => true, create: ({ req }) => Boolean(req.user), update: () => false, delete: () => false },
  hooks: {
    beforeValidate: [
      async ({ data, req }) => {
        if (state.crash) throw driverFault()
        const target = String((data as { target?: unknown } | undefined)?.target ?? '')
        const log = (kind: string) => req.payload.create({ collection: 'invite-events', data: { kind }, overrideAccess: true })
        let vetoed = false
        try {
          const answer = await state.host.vetoInvite?.(target)
          vetoed = state.looseVeto ? Boolean(answer) : state.trueOnlyVeto ? answer === true : answer !== undefined && answer !== null
        } catch {
          vetoed = !state.looseVeto
        }
        if (vetoed) {
          if (state.leakyEvents) await log('vetoed')
          throw new APIError(state.leakyMessage ? 'This person is a minor and cannot be invited.' : 'This person cannot be invited.', 403)
        }
        const person = (await req.payload.findByID({ collection: 'users', id: target, depth: 0, overrideAccess: true, disableErrors: true })) as { closed?: boolean } | null
        if (person?.closed) {
          let widened = false
          try {
            const answer = await state.host.allowClosed?.(target)
            widened = state.truthyHost ? Boolean(answer) : answer === true
          } catch {
            widened = state.truthyHost
          }
          if (!widened) throw new APIError('This person cannot be invited.', 403)
        }
        return data
      },
    ],
  },
}

export const fixturePlugin =
  (): Plugin =>
  (config: Config): Config => ({
    ...config,
    collections: [...(config.collections ?? []), notes, events, invites],
    onInit: async (payload: Payload) => {
      await config.onInit?.(payload)
      if (state.transactions === 'startup' && (await (payload.db as { beginTransaction: () => Promise<unknown> }).beginTransaction()) == null) throw new APIError('This change needs a transaction, so it wasn’t made.', 403, { refusal: 'transactions-required' })
    },
  })
