# Test audit

Newest first.

## 2026-11-27 (K891): a floor no host answer may widen

Suite: 129 plus 5 new tests (134, `npx vitest run`).

- **Covered.** With `mayWiden: []`, a fixture floor that holds against every host answer passes (`true`, `{}` and null checked by name). Broken variants that open on an exact true, on a truthy answer and on null each fail. The default `mayWiden` passes the exact-true variant, which is why a floor needs the empty list. Two temporary breaks were tried and undone: a checker that always lets `true` widen failed two of the new tests, and a fixed fixture that opens on `true` failed the passing one.
- **Gaps.** No real plugin's floor is probed here; each plugin repo does that in its own tests. The copyable lint test in `docs/review-checks.md` was run once by hand against a folder with findings, an empty folder and a clean folder; it isn't part of this suite.
- **Skipped.** The other host answers against each broken variant, since the all-answers pass test and the three failing variants cover them.

## 2026-11-24 (round 18): no toStringTag read

Suite: 123 plus 1 new test (124, `npx vitest run`). The new test fails on 6a46540.

- **Covered.** An own or inherited `Symbol.toStringTag` getter on an error with no message, on a nested cause and on an array never runs through `isRefusal`, `isValidationError`, `isDatabaseError` and `isTransactionError`; the `{ status: 500 }` probe is not a refusal.
- **Gaps.** Real driver errors on a live server and the three host plugins' own throws belong elsewhere.
- **Skipped.** `statusOf` and the other callers go through these four, so they are not tested separately.

## 2026-11-24 (round 17): one descriptor-only snapshot

Suite: 121 plus 2 new tests (123, `npx vitest run`). Both fail on 31f1b8f.

- **Covered.** For each of `code`, `codeName`, `errmsg` and `errorLabels`, an inherited getter that sets status 500, swaps `data` or adds `originalError` is never run and the error is unknown, on the marker and the bare path. A label or `codeName` object with its own `toString` is never converted.
- **Gaps.** Real driver errors on a live server and the three host plugins' own throws belong elsewhere.
- **Skipped.** The default `guardRefusal` and the host-rule, back-door and difference-probe checks all call `isRefusal`, so they are not tested separately.

## 2026-11-24 (round 16): stack read first

Suite: round 15's 120 plus 1 new test (121). Added late; the round 16 entry was missing.

- **Covered.** A `stack` getter that adds `originalError` (own key or `setPrototypeOf`) makes the marker and the bare error unknown. A `stack` accessor that gives text is accepted, one that gives anything else is not.
- **Gaps found by review.** Inherited getters on `code`, `codeName`, `errmsg` and `errorLabels` still ran after the checks. Closed in round 17.
- **Skipped.** Nothing new.

## 2026-11-24 (round 15): nothing from the prototype chain

Suite: round 14's 116 plus 4 new tests (`npx vitest run`).

- **Covered.** An inherited `status` or `statusCode` (data property or class getter) beside an own 403 is unknown on the bare and marker paths. An inherited `data`, `cause`, `errors`, `originalError`, `errorResponse`, `writeErrors` or `result` holding a driver error is unknown. An inherited `message` getter, a non-text inherited `name` and a Proxy prototype are unknown. A subclass and an inherited text name and message still pass. A `stack` accessor that gives text passes and one that gives an object does not.
- **Gaps.** The three host plugins' own throws belong in those repos.
- **Skipped.** Nothing new.

## 2026-11-24 (round 14): values in the allow-list, conflicting statuses

Suite: 116 tests after (`npx vitest run`). Round 12 and 13 entries below stay as written; round 13's `TransactionsRequired` class tests were removed in round 13.

- **Covered.** A driver error (a Mongo-shaped and a pg-shaped one) inside `isOperational`, `isPublic`, `stack`, `statusCode`, `message` or `name` is not a refusal on the bare path at 401, 403 and 404 and on the marker path; so is one in `data`, `data.errors` or `data.inner` on the bare path. Wrong primitive types in each of those keys are not refusals. Plain values and a `data` of plain values still pass. `status` beside a different `statusCode` (both orders, and on the marker) and a `status` or `statusCode` getter are unknown. A test comment that said 401 and 404 are refusals whatever `data` says was corrected.
- **Gaps.** The three host plugins' own throws belong in those repos.
- **Skipped.** Nothing new.

## 2026-11-24 (round 13): the settled marker, the own-key allow-list, the option type

Suite: 114 tests after (`npx vitest run`; real Payload 3.92 and in-memory MongoDB). The fixture now throws the marker through Payload's `APIError`, so the transactions checks run it end to end.

- **Covered.** The marker is a refusal only as a 403 `status` held as a plain own number: no status, 500, '403', 403.5, 403n, [403], NaN, a getter and an inherited status are not. `data` must be a plain `{ refusal: 'transactions-required' }`: a class, Proxy, array, null-prototype object, Map, extra key, `errors` key, inherited `refusal`, symbol key, getter and a wrong value or case are not. A cause or errors beside the marker, any other own key, a symbol key, an inherited `errors` and a Proxy of the error are not. The marker on a ValidationError (by name and by Payload's class) and on Mongo-shaped errors (name, code with codeName, labels, a transaction name) is not. The bare 401, 403 and 404 path fails on an unlisted nested key, a lying Map or Set subclass, a Proxy array, a deep nested error, a function and a symbol key, at each of the three statuses. Real Forbidden, NotFound, AuthenticationError, LockedAuth and UnverifiedEmail are bare refusals (documented). A wrong-typed `refusal` option is a config error.
- **Gaps.** The three host plugins' own throws belong in those repos.
- **Skipped.** The `TransactionsRequired` class tests went with the class.

## 2026-11-24 (round 12): the marker, bare statuses, and no text rules

Suite: 107 tests after (`npx vitest run`; real Payload 3.92 and in-memory MongoDB). The round 4 to 11 tests that probed text wording were removed with the rules they tested (the sentence splitter, cue words, driver deny-list and name list).

- **Covered.** The `TransactionsRequired` marker passes, with any message and also as a copy carrying `data.refusal`; a wrong `data.refusal` does not. A bare 401, 403 and 404 pass by `status` and `statusCode`. Sixteen made-up driver and refusal texts (as a plain Error, a string, a bare object, under a 403 as `cause`, as a string cause and in an `errors` list, and a refusal sentence followed by driver text) are not refusals. Forbidden, UnauthorizedError, NotFound and APIError at ten other statuses are not refusals. Non-integer statuses ('403', 403n, [403], 403.5, NaN, a `valueOf` object) are not. A 403 with a nested `cause`, `originalError`, `errorResponse` or `writeErrors` is not. A driver error with a 403 is not. Throwing getters on `cause`, `errors`, `name`, `code`, `codeName`, `status` and `data`, and a cycle, read as not a refusal and do not crash. The transactions check passes on the marker and on a bare 403, is not-checked on every text, and a custom `refusal` never rescues a driver error. Bulk entries with only a message are not-checked, and with a status they pass.
- **Gaps.** The organizations, positions and sharing plugins need their own one-line throw; their tests belong in those repos.
- **Skipped.** Real driver messages on a live server: the rule no longer reads text, so wording has nothing left to test. The one real WriteConflict test still runs.

## 2026-11-24 (round 10): driver text under a refusal, containers, APIError band, hostile status

Suite: 128 tests before, 132 after (`npx vitest run`; real Payload 3.92 and in-memory MongoDB).

- **Covered.** Twelve made-up driver texts nested under a 403 or an `APIError` 403 (in `cause`, `originalError`, `reason`, `errors`) are not-checked; a nested refusal message still passes. Driver errors inside a Map (value and key), Set, keyed object, array-like, nested arrays, `reason`, `response`, `extensions.exception` and `errInfo.details` are found, and a cycle through a Map ends. APIError at 402, 408, 409, 410, 429, 451, 499 and 403.5 is not-checked; 401, 403 and 404 pass. A throwing `status` getter and a throwing `role` do not crash the difference probe, and role, user id, operation id and title are each read once. All four new cases fail on the old code.
- **Skipped.** Real driver errors on a live server: shaped made-up errors cover the walk, and the live WriteConflict case from earlier rounds still runs.

## 2026-11-23 (round 9): walk limits, APIError status, more driver text, hostile properties

Suite: 123 tests before, 128 after (`npx vitest run`, run twice; real Payload 3.92 and in-memory MongoDB).

- **Covered.** A driver error just past the depth limit under a 403 is not-checked (7, 8, 9 and 30 links), a cycle still ends and passes a plain refusal. APIError at 500, 200, 503, 400 and with no status is not-checked; 401, 403, 404, 409 and 429 pass. Eleven driver texts are database messages, also under a broad pattern; "has transactions off" with a 403 still passes. Driver errors hidden in writeErrors, writeConcernError, errInfo, errorResponse, extensions, result and err are found. Throwing getters (message, status, cause, a nested code, a hostile proxy) give not-checked. All five new cases and the two updated ones fail on the old code; in case 3, "Cannot call abortTransaction twice", the read preference text and "Given transaction number" were already caught, the rest fail there.
- **Skipped.** A node cap: the walk is linear with a visited set, and the existing 250,000 entry test keeps passing.

## 2026-11-23 (refusal rule): bare messages, structural driver text, nested errors

Suite: 116 tests before, 123 after (`npx vitest run`, run twice; real Payload 3.92 and in-memory MongoDB).

- **Covered.** A long made-up TransactionTooOld text (lsid, txnNumber), "Cannot call abortTransaction twice", the primary read preference text, the timeoutMS withTransaction text, ClientSession, committed, lifetime and ended-session wording are never a refusal by default or under `/transaction|session/`, with or without a 403, in both modes. Codes 72 and 117 (with and without a `codeName`, and as an `errmsg` reply) are database errors. A bare plain-Error message is not-checked by default; a 403, an APIError or the caller's own pattern make "has transactions off" a refusal. `originalError` is walked. An `errors` array of 250,000 entries finishes and a database entry at its end is found. All seven new cases fail on the old code.
- **Updated.** The fixture plugin and two older tests now refuse with a 403, since a bare message no longer counts.
- **Skipped.** Real driver errors for codes 72, 117 and 225 on a live server (not triggerable on demand).

## 2026-11-23 (round 6): driver wording, strict default refusal, cycles

Suite: 109 tests before, 116 after (`npx vitest run`, run twice; real Payload 3.92 and in-memory MongoDB).

- **Covered.** TransactionTooOld wording, "No transaction started", "Transaction already in progress" and the commit/abort order errors are database messages; code 225 and TransactionTooOld in `errorResponse` count; the default refusal in both modes no longer passes those or "Transaction failed"; plugin refusals ("needs database transactions, and they are off", "Use a replica set", 403 "Unknown status.") still pass; a self-referential `errors` array (and a shared-node graph) finishes fast and a database error behind a cycle is still found; `errorResponse` `codeName` and `errorLabels` are read; the button label has no trailing period. Five of the seven new cases fail on the old code (the cycle case does not finish there); the other two guard ordinary refusals and the label.
- **Skipped.** A real double commit or old transaction on a live server (not triggerable on demand).

## 2026-11-23 (round 5): one list of driver words, and nested messages

Suite: 103 tests before, 109 after (`npx vitest run`, run twice; real Payload 3.92 and in-memory MongoDB).

- **Covered.** Real driver message text (in-progress transactions, expired sessions, multi-document transaction) as a plain Error with only a message: never a refusal under a custom `isRefusal` in the server back-door check (bulk and single), the response-difference probe and the host-rule check; the transactions check with `/./` and a predicate, in both modes and at start-up. A driver message in a nested `cause`, `errorResponse` or `errors` entry is a database error on every path. A nested ordinary refusal still passes and a 50-deep chain terminates. `goAhead` also rejects raw 0 and '' alone and mixed with allowed names. Five of the six new cases fail on the old code; the sixth guards ordinary refusals.
- **Updated.** The two word lists merged into one; the `goAhead` rejection test gained raw values.
- **Skipped.** A real expired session on a live server (not triggerable on demand).

## 2026-11-23 (round 4): custom refusal predicates and the veto go-ahead list

Suite: 93 tests before, 103 after (`npx vitest run`, run twice; real Payload 3.92 and in-memory MongoDB).

- **Covered.** A custom `isRefusal` (a regex on "transaction", a predicate that accepts everything) never makes a database error a refusal: killed-session, aborted-transaction, interrupted-operation, write-conflict and NoSuchTransaction wording in bulk update and delete entries and in single-document errors; driver-shaped errors with fields; the response-difference probe, the host-rule check and the transactions check with the same message-only error; standard "not allowed" text next to a database phrase is not-checked; ordinary refusal text ("Members only", "Use a replica set") still passes under a custom predicate; the message words do not match unrelated text. `goAhead` rejects `true`, `throw`, `{}`, 0, where, function, a non-list and a mix, before any option runs; null, undefined, false and an empty list are accepted; a documented `false` is allowed by contract and says so. Eight of the ten new cases fail on the old code.
- **Updated.** Two older tests expected a custom predicate to turn a NoSuchTransaction message into a pass; they now expect not-checked. The old `goAhead` test used `zero` and `empty-string`, which are no longer allowed.
- **Skipped.** A real killed session mid-update on a live server (hard to trigger on demand; the bulk and single-document cases use payloads that answer with the driver's message text, and the real WriteConflict test from round 3 covers the fields).

## 2026-11-23 (round 3): fail-closed fixes

Suite: 84 tests before, 93 after (`npx vitest run`, run twice; real Payload 3.92 and in-memory MongoDB).

- **Covered.** Errors shaped like the driver's (codeName, code, errorLabels, plain message, and a `cause`) are never refusals, at start-up and at the write, even with a custom pattern that matches the message; a real WriteConflict raised by two overlapping transactions on the in-memory replica set; validation errors (400, 422, ValidationError) are not-checked in all four checks; veto mode for every answer (strict default, a loose variant that fails on 0, an empty string, false and a throw, a true-only variant that fails on nine answers, and `goAhead`); a silent field lock passes, a typo in `data` or a value equal to the seeded one is not-checked, a plugin with no lock fails; a delete that leaves the row and a create that leaves no row pass; bulk refusal wording (standard message, status on the entry, custom message, validation entry, custom `isRefusal`); symbolic links skipped by the lint.
- **Cleanup.** `closeAll` destroys every instance, then stops Mongo with cleanup and force even when a destroy throws, and the test fails if either step reports a problem. Checked after a run under a private temp folder: no `mongo-mem` folder, no mongod process, no new Docker volume.
- **Skipped.** A silent lock on delete (the fixture can't make a delete quietly do nothing); NoSuchTransaction from a live server (hard to trigger on demand; the shaped objects and the real WriteConflict share the same fields); a grant-time veto probe has no counterpart in this repo, since the veto check takes the caller's own `attempt`.

## 2026-11-23: review-finding checks

Suite: 38 tests before, 74 after (`npx vitest run`; `review.test.ts` on real Payload 3.92 and in-memory MongoDB, `lint.test.ts` on text).

- **Promise and test.** Each check has a quiet case on a fixed variant and a firing case on a broken one. Response difference: same refusal passes; a message that says why, an event row only one identity leaves, a different status, shape or allowed-versus-refused each fire; ids and dates are masked; two server errors and equal roles are not checked. Transactions: ignored fires, refusing at start-up or at the write passes, transactions on or an unrelated error is not checked (uses an instance booted with `transactionOptions: false`). Back doors: bulk hole, access-only rule under `overrideAccess`, and a hook that needs a transaction each fire only their own probes; `holdsForServerCode` off skips the override probes. Host rules: truthy test fires on `{}`, a throw and a narrow where; `mayWiden` changes the result; the option is put back. Lint: truthy use, stored answer, negation, ternary, paginated find; quiet on `=== true`, `pagination: false`, `findByID`, comments and files without hooks; folder walk skips tests and node_modules.
- **Added after review (same day).** Value-only differences (1 against 0, true against false, a count read afterwards); crashed probes in every check (a plain error for one or both identities, NoSuchTransaction in a hook, a wrong slug, Mongo's own transaction messages, a throwing `beginTransaction`) are not-checked and never pass; server-code bulk commits, a create with `disableTransaction` and `overrideAccess` fire on the matching broken variants; `null-after-start` fires for a start-up-only guard and passes for a per-request guard; veto mode (true and a throw must refuse); the extra host answers; lint of helper files and of a find after another query.
- **Skipped.** REST and GraphQL variants of the probes (callers can pass their own `run`); Payload internals; the formatting of `how` text beyond the parts a test matches.
- **Clean-up.** Every Payload instance is destroyed and the Mongo server stopped in `afterAll`; the folder test removes its own temp folder.

## 2026-11-11: only an exact `true` from `access`

Suite: 36 tests before, 38 after (`npx vitest run`; `alerts.test.ts` on real Payload 3.92 and in-memory MongoDB with made-up alerts and users).

- **The change.** `hasAccess` in `src/alerts.ts`: signed in, and `access(req)` answered exactly `true`; a throw or rejection is `false`. The alerts collection's read and update and the retest endpoint use it, so the site's answer never reaches Payload as access.
- **Tests.** "refuses reads, snoozes and retests with 403 for anything but true…": `1`, `'yes'`, `{}`, a query-shaped object, a throw and a rejection each get 403 on find, findByID, a snooze and the retest endpoint, no suite runs and the alert is unchanged. "lets an exact true read every alert, and refuses someone not signed in even then".
- **Mutation checks.** 5, each a Python string replace restored byte for byte (SHA-256 checked); all 5 fail the suite: truthy passing; errors rethrown; the sign-in check dropped; the old pass-through in the collection's access; the old truthy check in the retest endpoint.
- **Skipped.** No default to test: `access` is required and there's no fallback, so the "member of a second auth collection under the default" case doesn't apply; the site's own rule decides who that is. The "Retest selected" button only calls the endpoint and has no access decision of its own.

## 2026-11-10: 0.2.0

28 tests: `access.test.ts` (5), `credentials.test.ts` (4), `checks.test.ts` (10), `alerts.test.ts` (9, real Payload 3.92 and in-memory MongoDB).

| Promise | Test |
| --- | --- |
| Headers, cookie flags, CORS, open redirects, GraphQL introspection, admin indexing: pass and fail cases | checks: one test each |
| A check whose request fails is "not checked", never passed | checks: "a check whose request fails…" |
| Secrets in bundles and scripts in user text are found without copying them | checks: "client secrets…", "user-written content…" |
| SVG and unrestricted uploads flagged | checks: "uploads…" |
| One alert per finding; updated on re-run; resolved on pass; plain passes not stored | alerts: "opens one alert per finding…" |
| A throwing suite is recorded "not checked" | alerts: "a suite that throws…" |
| Critical alerts reported once | alerts: "tells someone about a new critical alert once…" |
| Bulk snooze over a selection holds through later runs; reason, future end and 90-day limit enforced | alerts: "bulk snooze" (2) |
| No access, no alerts; edits change only the snooze | alerts: "people without access…" |
| Retest runs only the selected alerts' suites; endpoint refuses without access or a selection | alerts: "retest a selection" (2) |

Checked outside the tests: the admin list, Retest selected (with its result kept across the reload) and a bulk snooze sent the way bulk Edit sends it, in a real Payload admin on a local copy of a site with made-up findings. This also found that Payload hid the snooze refusals ("Something went wrong"); they now show the reason. axe on the list found issues only in Payload's own list markup.

Gaps: dependency advisories (planned); GraphQL depth and complexity (planned); the admin's bulk Edit drawer was opened but driven by the request, not by clicks.

## 2026-11-09: first audit (0.1.0)

| Promise | Tests (`test/access.test.ts`) |
| --- | --- |
| Catches a private related record's id in a public read (regression) | "catches the private-parent read leak…" |
| Catches a refusal that reveals what it protects (regression) | "catches the loop answer in a refusal…" |
| Fails writes that should be refused | "fails a write that should have been refused" |
| Never reports an unchecked path as passed | "never reports something it couldn’t check…" |
| Ranks failures by severity; plain report with reproduction steps | "puts failures first, worst first…" |
| Untrusted credentials: a gate that trusts a cookie's presence is caught (regression: the maintenance gate, medium); a verifying gate passes; a forged role cookie revealing data is high; forged tokens look real; failures are "not checked" | `test/credentials.test.ts` |

- Gaps skipped: `payloadReadPaths` against a real Payload (it only calls the Local API with the viewer's access; covered when a site runs it in its own tests).
- Planned checks in `CHECKLIST.md` get tests as they're automated.

## 2026-11-25 (K768)

- Covered: `runContextLeakCheck` fails on a leaky afterChange hook in a 2-note bulk update and names the key (not the probe), passes when the hook isolates `req` or is off, honors `ignore`, reports a removed key, and is not-checked when the operation throws (`test/review.test.ts` section 6). Lint rule `context-on-shared-req`: seven cases, flagged and quiet (`test/lint.test.ts`).
- Gaps skipped: nested context objects changed in place below the first level (the check compares one level deep, and says so in the docs).
