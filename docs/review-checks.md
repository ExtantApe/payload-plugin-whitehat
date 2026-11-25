# Review-finding checks

Five checks for classes of bug that human security review keeps finding in Payload plugins. They are plain functions a plugin repo runs in its own Vitest suite or CI against a Payload instance. Like the rest of Whitehat they report and never fix, and findings carry a severity. The probes do write: they try to create, change and delete rows in the collections you name, and a probe that gets through leaves its change behind, so run them on a throwaway database with made-up users and records (the in-memory MongoDB the plugin's own tests use is the usual choice) and give them a `seed`.

A probe counts something as refused only when it sees a refusal (`isRefusal`): the marker (see below), or an error whose `status` is exactly the integer 401, 403 or 404 with nothing nested in it. Everything else is `not-checked`: a message, a name such as Forbidden or NotFound at another status, a validation error (400, 422), a database error, a wrong collection slug. A check that cannot judge never reports a pass. Pass your own `isRefusal` where a site refuses some other way.

```ts
import { runHostRuleCheck, runResponseDifferenceProbe, runServerBackDoorCheck, runTransactionCheck, lintDirectory, formatReport } from '@extantape/payload-plugin-whitehat'
```

Turn findings into a test failure with `expect(findings.filter((f) => f.status !== 'pass')).toEqual([])`, and print `formatReport(findings)` to see them. `not-checked` should fail the suite too: a probe that couldn't run proves nothing.

## 1. `runResponseDifferenceProbe`

Runs each operation as two identities that differ in one property, for example one refused by a host veto hook and one that simply isn't allowed. Only a refusal (the marker, or a bare 401, 403 or 404) counts as refused: a validation error, a database error and any other crash are `not-checked`, so a typo in a probe's data can't turn a hole into a pass. Flags any difference the caller can see: whether it was allowed, the refusal's message, the status, the shape and the values of what came back (a count of 1 against 0, a flag true against false), or what changed in the state `observe` reads (rows created, history, events). If the two answers differ, the answer is an oracle.

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

Each identity's own user id, other ids, dates and long numbers are masked before comparing. Pass `mask` for anything else that is meant to differ. Run it for writes (create, update, invite-style) and for reads. If either identity gets an error that isn't a refusal, even the same crash for both, the operation is `not-checked`.

## 2. `runTransactionCheck`

Two modes. In the default `off-at-start` mode, `start` boots the instance with transactions off (the Mongo adapter with `transactionOptions: false`, so `beginTransaction` answers null). The plugin must refuse to start, or `write` (a write the plugin protects with a transaction) must be refused. A write that goes through is the finding.

A start-up check can't see a per-request guard. With `mode: 'null-after-start'`, `start` boots a normal instance and the check makes `beginTransaction` answer null for the write only (and puts it back afterwards). A plugin that checked once at start-up, or that reads `req.transactionID` without awaiting it, passes start-up and fails here. Run both modes.

**Start-up guards in a host plugin.** Throw the marker from the guard. A plugin throws it itself and never imports whitehat: `new APIError('This change needs a transaction, so it wasn’t made.', 403, { refusal: 'transactions-required' })`. Whitehat trusts that shape and nothing a message says. A bare 401, 403 or 404 also counts. Anything else, a plain Error, an `APIError` left at its default 500, or a 403 that wraps another error, is `not-checked`, because driver and wrapper faults are plain text too.

A refusal is exactly one of two things.

1. **The marker.** `status` is 403 as a plain own number (not a getter). `data` is a plain object whose prototype is `Object.prototype` and whose own keys are exactly `['refusal']`, with `refusal === 'transactions-required'`. `cause` is absent or is `data` itself (Payload 3.92's `APIError` sets `cause: data`). There is no `errors`. The error's own keys are only `message`, `stack`, `name`, `status`, `statusCode`, `data`, `isPublic`, `isOperational`, and `cause` when it is `data`. A class instance, Proxy, array, null-prototype object, extra or inherited key, symbol key or getter in `data` is not the marker, and a 403 whose `data` carries a `refusal` key in any other shape is not a refusal at all. The marker on a validation error or a driver error (a `Mongo...` name, `codeName`, `errorLabels`, a server `errmsg` with a `code`) is not a refusal either.
2. **A bare 401, 403 or 404.** `status` or `statusCode` is an integer 401, 403 or 404 held as a plain own number, and the error's own keys come only from the same list, with the value types above (without `cause` unless it is `data`, and `data` absent, null or a plain object of plain values without a `refusal` key). Any other own key, such as `errors`, `cause` with a value, `originalError`, `details` or a Symbol key, could hide a nested error, so the answer is unknown and not a refusal; a Proxy is not read at all. Nothing is judged by a message or a name. Forbidden, UnauthorizedError and NotFound at any other status are not refusals, and neither is a text that says "needs a transaction". A status counts only as a real integer: the string `'403'`, `403n`, `[403]` and an object with a `valueOf` are not one. An unreadable property or a cycle reads as unknown.

**NotFound and the auth errors count as refusals.** Payload's `NotFound` (404), `AuthenticationError` and `LockedAuth` (401, 403) and `UnverifiedEmail` (403) are bare 401, 403 or 404 errors, so they count like `Forbidden`. A missing target (a wrong id or slug that answers 404) therefore makes the host-rule baseline read as refused, and a probe that points at a record that doesn't exist reads as refused for the same reason. Check that the target exists (a `seed`) before trusting a pass. This has been true since the first rounds and is recorded here so it isn't a surprise.

A custom `refusal` or `isRefusal` function is the caller's own rule, but a database error is tested first and is never rescued by it. It must be a function: any other type (a RegExp, a string) is a config error and throws, instead of turning results into not-checked. Any other error, transactions that turn out to be on, or a `beginTransaction` that throws, is `not-checked`.

**Round 15 (2026-11-24, Simon's review of round 14).** Nothing is read from the prototype chain. If `data`, `cause`, `errors`, `status`, `statusCode` or another nested-error key sits on a prototype, even as a getter, the error is unknown on both paths. An inherited `message` or `name` must be plain text, and a Proxy or a chain deeper than 50 is unknown. Subclasses with ordinary text `name` or `message` on the prototype still pass.

**Round 14 (2026-11-24, Simon's review of round 13).** The allow-list checks values. `message`, `stack` and `name` are text, `status` and `statusCode` are integers and agree with each other, `isPublic` and `isOperational` are booleans, and every key is a plain data property except `stack`, whose accessor is read once and accepted if it gives text (V8's own accessor can't be told apart). On a bare 401, 403 or 404, `data` is absent, null or a plain object of text, numbers, booleans and null, so a driver error inside `data` or any listed key is unknown, not a refusal.

**Round 13 (2026-11-24, Simon's review of round 12).** The marker is settled and stricter. `TransactionsRequired` is no longer exported, since a class with no status counted only through a loose check. The marker needs a 403 `status`, a plain `data` of exactly `{ refusal: 'transactions-required' }` and the own-key list above; the bare 401, 403 and 404 path got the same own-key list, so a nested error under an unlisted key, a Map or Set subclass or a Proxy array can no longer hide beside it. The marker shape is no longer open.

**Round 12 (2026-11-24, the owner's choice in Simon's chat: "Switch to marker (Recommended)").** The earlier text rules are gone: the sentence splitter, the list of Mongo wording, the cue words (needs, requires, must ...) and the name list. Driver and server messages vary too much to list, and each review round found another wording that slipped through. A plugin now says no with one error it throws itself. Organizations, positions and sharing are not changed in this PR: each needs a one-line throw of the marker as a follow-up, and until then their refusals are `not-checked` unless they carry a bare 401, 403 or 404.

## 3. `runServerBackDoorCheck`

For each protected collection (`slug`, the `identity` that must be refused, a `protectedWhere` that matches only protected rows, a guarded `data` change, and a `seed` that puts the rows back) it tries bulk update and bulk delete with a `where`, update and delete by id with `disableTransaction: true`, and, if you give a `create` that must be refused, that create with `disableTransaction: true`. With `holdsForServerCode: true` it adds the same by id and create with `overrideAccess: true`, and bulk update and delete as server code (`overrideAccess: true`, no user), which catch a rule that commits one document at a time. Bulk operations answer with `{ docs, errors }` rather than throwing, so a rule that guards only single writes lets them through. Set `holdsForServerCode` only for rules meant to hold in hooks even when server code skips access. 

After each probe the rows are read again, so an answer without an error is not taken as "allowed": an update counts as let through only if a field in `data` changed, a delete only if the row is gone, a create only if the new row exists. A hook that quietly puts the old value back passes (the report says silent lock). When an update changes nothing and wasn't refused, the check writes `data` straight through the database adapter to prove `data` can change the row; if a key isn't a field or can't be written, the probe is `not-checked`, since a typo would otherwise read as a lock. `seed` puts the rows back afterwards.

Bulk operations report refusals in an `errors` list whose entries have only a message (and an id). An entry counts as a refusal only when `isRefusal` accepts it, which means it is the marker or a bare 401, 403 or 404 `status`. The message is never read, so Payload's standard "You are not allowed to perform this action" entry is `not-checked` until the plugin adds a status or the marker, or you pass an `isRefusal` that recognizes it.

## 4. `runHostRuleCheck`

For each host access or veto option: `install(answer)` sets the host's answer (`HOST_ANSWERS`: `true`, `{}`, null, 0, an empty string, a throw, a narrow where, 1, `'yes'`, `[]`, false, undefined and a function), and `attempt` does something the plugin's default refuses. With no host answer the attempt must be refused (otherwise `not-checked`). After that only answers in `mayWiden` (default `['true']`) may turn it into an allow. Everything else, a function included, must keep the default. A `veto` option follows the strict-answers rule below. `install(undefined)` runs first and last, so the option is put back.

For a veto hook, set `kind: 'veto'`. The rule is different: `attempt` is something the default allows, and only the answers in `goAhead` (default `null` and `undefined`) may leave it allowed. `goAhead` takes only `null`, `undefined` and `false`; any other entry throws a config error before anything runs. Every other answer must refuse it: `true`, a reason string, `{}`, `[]`, 1, 0, an empty string, false, a function, a narrow where and a throw (a broken veto fails closed). If a plugin documents another answer as go ahead, list it in `goAhead`; the report then says that answer was allowed by contract. Put the veto's own moment in `attempt`: if the host veto runs when the holder accepts a grant (as the positions plugin's does), `attempt` must make the holder accept it. A probe that tests the veto when someone grants would see nothing, and a granter could not learn the veto's answer anyway.

## 5. `lintDirectory` and `lintSource`

A heuristic read of source text (never an edit) of every source file, helpers included. It flags a host hook's answer used as a truth value instead of `=== true`, and a paginated `payload.find` passing `req`, without `pagination: false`, as the first query of its function. A find that follows another query in the same function is skipped. Each hit names `file:line`. Limits: it can't see whether a transaction is open or what calls the function, it doesn't follow calls into other functions, and it misses a host hook held under another name. A hit says look here; a clean run isn't proof.

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
