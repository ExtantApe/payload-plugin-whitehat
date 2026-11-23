# Test audit

Newest first.

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
