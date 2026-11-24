# Review-finding checks

Five checks for classes of bug that human security review keeps finding in Payload plugins. They are plain functions a plugin repo runs in its own Vitest suite or CI against a Payload instance. Like the rest of Whitehat they report and never fix, and findings carry a severity. The probes do write: they try to create, change and delete rows in the collections you name, and a probe that gets through leaves its change behind, so run them on a throwaway database with made-up users and records (the in-memory MongoDB the plugin's own tests use is the usual choice) and give them a `seed`.

A probe counts something as refused only when it sees a recognized refusal: HTTP 400, 401, 403, 404 or 422, or Payload's Forbidden, UnauthorizedError, ValidationError or NotFound (`isRefusal`). Any other error, such as NoSuchTransaction, a database error or a wrong collection slug, is `not-checked`, and a check that cannot judge never reports a pass. Pass your own `isRefusal` where a site refuses some other way.

```ts
import { runHostRuleCheck, runResponseDifferenceProbe, runServerBackDoorCheck, runTransactionCheck, lintDirectory, formatReport } from '@extantape/payload-plugin-whitehat'
```

Turn findings into a test failure with `expect(findings.filter((f) => f.status !== 'pass')).toEqual([])`, and print `formatReport(findings)` to see them. `not-checked` should fail the suite too: a probe that couldn't run proves nothing.

## 1. `runResponseDifferenceProbe`

Runs each operation as two identities that differ in one property, for example one refused by a host veto hook and one that simply isn't allowed. Only a recognized refusal (401, 403, 404, Forbidden, UnauthorizedError, NotFound) counts as refused: a validation error (400, 422, ValidationError), a database error and any other crash are `not-checked`, so a typo in a probe's data can't turn a hole into a pass. Flags any difference the caller can see: whether it was allowed, the refusal's message, the status, the shape and the values of what came back (a count of 1 against 0, a flag true against false), or what changed in the state `observe` reads (rows created, history, events). If the two answers differ, the answer is an oracle.

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

**Start-up guards in a host plugin.** In the default mode the check treats an error as a refusal only when it looks like one: a status of 401, 403 or 404 (an integer; a Payload `APIError` counts the same way), or the name Forbidden, UnauthorizedError or NotFound, with a message that mentions transactions and says no on purpose (needs, requires, must, refuses, cannot, without, off, replica set). Any message nested inside it (`cause`, `errors`, a Map or Set of errors, `reason`, `response` and so on) must read the same way. Anything else is not-checked, because driver and wrapper faults are plain text too. So a guard that throws a plain Error, an `APIError` left at its default 500, or a 403 that wraps an unrelated cause will be not-checked. Give the guard a 403, make its messages say what is refused, or pass `refusal` with your own pattern.

A refusal is an error with a refusal status (401, 403, 404), a Forbidden, UnauthorizedError or NotFound name, or a Payload `APIError` with a status of 401, 403 or 404 (no other status counts: not 400 or 422, which are validation errors, not 408, 409, 429 or 499, and not Payload's default 500 or no status), that mentions transactions and says no on purpose (needs, requires, must, refuses, cannot, without, off, replica set; "Transaction failed" is not one). A plain Error with only a message is not-checked by default; pass a `refusal` pattern for that. Or it is whatever `refusal` matches (a pattern, or a function of the message and the error). A database error is never a refusal, whatever `refusal` matches, even `/transaction|session/`: driver text (txnNumber, lsid, ":: caused by ::", abortTransaction, commitTransaction, withTransaction, ClientSession, aborted or committed transactions, lifetime limits, ended sessions) is checked first and wins. `cause`, `originalError`, `errorResponse`, `errors`, `writeErrors`, `writeConcernError`, `errInfo`, `extensions`, `result` and `err` are all read, each object once, to 6 levels deep. A walk that cannot finish (a chain deeper than that, or a property that throws when read) is never a refusal: the answer is `not-checked`, because a driver error may be hiding past the limit. Driver wording also covers txnId, "Operation exceeded time limit", and sessions that were ended or whose id has expired; "Your session has expired" is still the plugin's own words. Real driver errors (NoSuchTransaction, WriteConflict, "Transaction numbers are only allowed on a replica set member") are recognized by their `codeName`, `code` and `errorLabels` (such as `TransientTransactionError`), on the error or on its `cause`, because their message is plain text. A validation error is not a refusal by default. The plugin's own advice, such as "Use a replica set", is. Any other error, transactions that turn out to be on, or a `beginTransaction` that throws, is `not-checked`.

**What counts as a refusal, round 11.** A status counts only when it is a real integer number: the string `'403'`, `403n`, `[403]` and an object with a `valueOf` are not one. The whole message must read as a refusal, sentence by sentence: "This change needs a transaction, so it wasn't made." followed by driver text is not-checked. Driver wording now also covers E11000 and duplicate keys, closed or reset connections, "Unable to acquire server session", sockets, "not primary", server selection, a destroyed topology, cursor and executor errors, `writeConcern`, system collections, and anything "within a multi-statement transaction". Anything nested under a refusal must be readable, or the answer is not-checked: an error with no string message (an object, an empty one, only a `code`, text only in `stack`), a Proxy, a class instance that is not an Error, an Error from another realm, and an object with Symbol or non-enumerable keys. Two cases that used to pass are therefore not-checked now, and both fail closed: a nested "session expired" (it could be the driver's), and a GraphQL `FORBIDDEN` refusal whose only nested part is `extensions: { code: 'FORBIDDEN' }` with no message. Give the nested error a message, or pass your own `refusal`. `isRefusal`, used by the back-door, host-rule and response-difference checks, follows the same nesting rule: a 403 that wraps a database error, or something unreadable, is not a refusal. A container is opened once (a self-referential array ends at once) and at most 10,000 entries are read in all; a bigger one is unknown, so not a refusal.

## 3. `runServerBackDoorCheck`

For each protected collection (`slug`, the `identity` that must be refused, a `protectedWhere` that matches only protected rows, a guarded `data` change, and a `seed` that puts the rows back) it tries bulk update and bulk delete with a `where`, update and delete by id with `disableTransaction: true`, and, if you give a `create` that must be refused, that create with `disableTransaction: true`. With `holdsForServerCode: true` it adds the same by id and create with `overrideAccess: true`, and bulk update and delete as server code (`overrideAccess: true`, no user), which catch a rule that commits one document at a time. Bulk operations answer with `{ docs, errors }` rather than throwing, so a rule that guards only single writes lets them through. Set `holdsForServerCode` only for rules meant to hold in hooks even when server code skips access. 

After each probe the rows are read again, so an answer without an error is not taken as "allowed": an update counts as let through only if a field in `data` changed, a delete only if the row is gone, a create only if the new row exists. A hook that quietly puts the old value back passes (the report says silent lock). When an update changes nothing and wasn't refused, the check writes `data` straight through the database adapter to prove `data` can change the row; if a key isn't a field or can't be written, the probe is `not-checked`, since a typo would otherwise read as a lock. `seed` puts the rows back afterwards.

Bulk operations report refusals in an `errors` list whose entries have only a message (and an id). An entry counts as a refusal when `isRefusal` accepts it (it has a `status` or `name` that says so) or its message is Payload's standard "You are not allowed to perform this action" or says forbidden. Any other wording, such as a custom message from the plugin, is `not-checked` until you pass an `isRefusal` that recognizes it. A bulk error that names the database or a validation problem is never a refusal.

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
