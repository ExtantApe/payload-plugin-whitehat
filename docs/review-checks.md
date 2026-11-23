# Review-finding checks

Five checks for classes of bug that human security review keeps finding in Payload plugins. They are plain functions a plugin repo runs in its own Vitest suite or CI against a Payload instance. Like the rest of Whitehat they only look: nothing is fixed, findings carry a severity, and anything that couldn't be judged is `not-checked`, never `pass`. They use made-up users and records. Probes write on purpose, so run them on a throwaway database (the in-memory MongoDB the plugin's own tests use is the usual choice).

```ts
import { runHostRuleCheck, runResponseDifferenceProbe, runServerBackDoorCheck, runTransactionCheck, lintDirectory, formatReport } from '@extantape/payload-plugin-whitehat'
```

Turn findings into a test failure with `expect(findings.filter((f) => f.status !== 'pass')).toEqual([])`, and print `formatReport(findings)` to see them. `not-checked` should fail the suite too: a probe that couldn't run proves nothing.

## 1. `runResponseDifferenceProbe`

Runs each operation as two identities that differ in one property, for example one refused by a host veto hook and one that simply isn't allowed. Flags any difference the caller can see: the refusal's message, the status, the returned shape, or what changed in the state `observe` reads (rows created, history, events). If the two answers differ, the answer is an oracle.

```ts
await runResponseDifferenceProbe({
  identities: [vetoed, notAllowed], // { role, user } each, with different roles
  operations: [{
    id: 'invite',
    title: 'Inviting someone',
    run: (who) => payload.create({ collection: 'invites', data: { target: who.user.id }, user: actor, overrideAccess: false }),
    observe: async () => (await payload.count({ collection: 'invite-events', overrideAccess: true })).totalDocs,
  }],
})
```

Each identity's own user id, other ids, dates and long numbers are masked before comparing. Pass `mask` for anything else that is meant to differ. Run it for writes (create, update, invite-style) and for reads.

## 2. `runTransactionCheck`

`start` boots the instance with transactions off (the Mongo adapter with `transactionOptions: false`, so `beginTransaction` answers null). The plugin must refuse to start, or `write` (a write the plugin protects with a transaction) must be refused. A write that goes through is the finding. A refusal means an error mentioning transactions, or whatever `refusal` matches. Any other error, or transactions that turn out to be on, is `not-checked`.

## 3. `runServerBackDoorCheck`

For each protected collection (`slug`, the `identity` that must be refused, a `protectedWhere` that matches only protected rows, a guarded `data` change, and a `seed` that puts the rows back) it tries bulk update and bulk delete with a `where`, update and delete by id with `disableTransaction: true`, and, with `holdsForServerCode: true`, `overrideAccess: true`. Bulk operations answer with `{ docs, errors }` rather than throwing, so a rule that guards only single writes lets them through. Set `holdsForServerCode` only for rules meant to hold in hooks even when server code skips access.

## 4. `runHostRuleCheck`

For each host access or veto option: `install(answer)` sets the host's answer (`HOST_ANSWERS` are `true`, `{}`, null, 0, an empty string, a throw and a narrow where), and `attempt` does something the plugin's default refuses. With no host answer the attempt must be refused (otherwise `not-checked`). After that only answers in `mayWiden` (default `['true']`) may turn it into an allow. Everything else must keep the default. `install(undefined)` runs first and last, so the option is put back.

## 5. `lintDirectory` and `lintSource`

A heuristic read of source text (never an edit). It flags a host hook's answer used as a truth value instead of `=== true`, and a paginated `payload.find` passing `req` in a file with hooks and no `pagination: false`. Each hit names `file:line`. A hit says look here; a clean run isn't proof.

```ts
it('has no known review-finding patterns', () => {
  expect(lintDirectory(new URL('../src', import.meta.url).pathname).filter((f) => f.status === 'fail')).toEqual([])
})
```

## Running them in a plugin PR

1. Add `@extantape/payload-plugin-whitehat` as a dev dependency of the plugin.
2. Put the checks in a `test/review.test.ts` that boots the plugin on Payload with in-memory MongoDB, as its other tests do. This repo's `test/review.test.ts` and `test/fixtures/fixturePlugin.ts` are a worked example, including a deliberately broken and a fixed variant of each check.
3. CI already runs `npm test`, so nothing else is needed. The checks fail the run when they find something.
4. A new finding class goes into `CHECKLIST.md` and gets a broken and a fixed fixture, the same way.
