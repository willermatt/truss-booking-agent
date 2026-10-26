# Truss booking agent

Books Truss Home Inspections appointments through Spectora's public online scheduler, with mandatory
safety controls enforced in PostgreSQL. **Live submissions are disabled.** To set it up, see
[DEPLOY.md](DEPLOY.md). Tests use a mocked scheduler,
a fake read-only Spectora API, and real Chromium against a local stand-in for the scheduler page
(`test/helpers/fixtureScheduler.ts`); nothing in the test suite can reach Spectora.

## Fixed limits

| Limit | Value | Counted |
| --- | --- | --- |
| New booking jobs | 15 per Arizona calendar day | At admission: before the Spectora API check and the first page load. Jobs that later fail, block or dry-run all count. Invalid requests and refused admissions do not. |
| Final submission attempts | 5 per Arizona calendar day | At reservation, immediately before the submit action, whatever happens next |
| Final submission attempts | 2 per rolling 60 minutes | Same, counted over 61 min 30 s (inclusive): a counted request leaves within 20 s and may take up to 60 s more to arrive, so the moments the requests reach Spectora are also never 3 in 60 minutes; attempts dated in the future count |
| Count-to-submit gap | 10 s to verify, 20 s to send | The reservation must be verified within 10 s of being counted, and the create request can leave only within 20 s of being counted (a send-by deadline from the database, at most 20 s, anchored when verification is sent, checked on the wall clock and the monotonic clock). A database clock that moved back since the reservation stops it. No reservation in the last 90 s of an Arizona day |
| Uncertain outcomes | 0 outstanding | While any booking is UNKNOWN, no booking job is admitted or reserved (dry runs still run) |
| Active browser sessions | 1, globally | From admission until the browser is confirmed closed |
| Circuit breaker | Opens at 3 consecutive booking errors | Failed, uncertain and pre-submit errors and dead workers count; a REQUESTED result resets the streak |
| Browser session length | 10 minutes | Enforced at renewal, the duplicate-check record, reservation and verification |

The numbers appear only in `db/migrations/001_safety.sql`. No table column, function argument, setting
or command can change them; only a new, reviewed migration can.

## How a booking runs

```
validate request, map services, parse address                    (nothing stored on failure)
ADMIT        app_admit_job: under the global lock, expire lapsed sessions, check kill switch, breaker,
             1 browser session, 15 jobs/day, 5/day and 2/hour; record the job; open the browser session
             (2-minute lease renewed every 20 s, 10-minute hard cap)
DUPLICATES   read-only Spectora API: exact match → BLOCKED; possible match → BLOCKED, manual booking
CHECKPOINT   the session is renewed before the browser starts and before every step; a lost session stops
BROWSER      Steps 1–3 and the Review step (a dry run answers Step 3's text notification in the browser)
REVIEW       services, property (same address, unit and ZIP), date with its year and the one start time
             must match. The price is Spectora's: recorded with the result (spectoraShown), never checked
             (a dry run stops here)
RESERVE      app_reserve_submission: under the global lock, re-check everything, refuse local duplicates
             and possible matches, record the attempt
VERIFY       app_verify_reservation on a brand-new connection: attempt committed, session live, kill
             switch still on; returns the send-by deadline (20 s from the counted attempt)
SUBMIT       exactly once, before the send-by deadline; no retry. The create request is sent once from
             Node, not by the browser (Chromium silently re-sends a POST when a connection drops), and a
             redirect is never followed
CLOSE        browser confirmed closed, then the outcome is recorded and the session ended. A browser that
             will not close: the slot stays held in the database until you release it, and the worker
             process refuses all further work and exits
```

A successful submit is **REQUESTED** (Spectora's Require Confirmation stays on). It becomes CONFIRMED only
when Spectora shows it confirmed, or when you record that you confirmed it. A network error, timeout or
lost response is **UNKNOWN**: never retried, only looked up read-only, and otherwise left for you to
reconcile.

## Where each control is enforced

| Control | Mechanism |
| --- | --- |
| Atomic, global limits | Every writing function locks the singleton control row first (`SELECT … FOR UPDATE`); the clock is read after the lock. Lock order everywhere: control → session → job → attempt |
| No stale snapshots | `_require_read_committed()` is the first statement of every `app_*` and `owner_*` function; calls at REPEATABLE READ or SERIALIZABLE are refused, including when a role changes its own default |
| One browser session | Admission check plus unique partial index `browser_sessions_single_active` |
| One submission in flight | Reservation check plus unique partial index `attempts_single_in_flight` |
| One attempt per job | `attempts.job_id UNIQUE` |
| Stale workers | A lapsed lease is final: the worker can no longer renew, record or reserve. The next admission (or `app_expire_stale_sessions`) ends it: an in-flight attempt becomes UNKNOWN, an unfinished job FAILED, and both count toward the breaker. A worker whose renewals stop succeeding (a database that stops answering) closes its own browser after 80 s, before the 2-minute lease can lapse; its database calls time out |
| Every worker call commits | Each writing `app_*` function refuses to run inside a transaction that has already written (so an admission cannot be rolled back after the browser opened: the renewal before the browser starts is refused) or with `synchronous_commit` off. A `SET LOCAL synchronous_commit = off` after a call can still make that one commit asynchronous; the next worker call (the renewal before the browser, the verification before the submit) commits synchronously and so flushes it first |
| Live workers keep their slot | Only a lapsed lease can be expired |
| A browser that will not close | The session is marked unconfirmed and is never expired automatically; `release-session` frees it once the worker has exited. The process refuses all further work (`worker_must_exit`) |
| The browser itself | A network guard in front of the page denies every request that is not a GET by default. It lets through, on the scheduler's own host only: the price calculation; the "Schedule In Progress" notification once, when a booking leaves Step 3 (a dry run answers it in the browser, so it never reaches Spectora); and the create request once, inside `submit()`, before the send-by deadline, and only if its body matches the job: the customer's name, email and phone, the square footage and year built (the request's, or Spectora's own lookup values when the request has none), ZIP and unit must be in it, nothing in it may name another person, refer to an existing client or agent record (an id), or state other property facts; SMS opt-ins (any key spelling, any value but an explicit no) only with recorded consent; and a body that is not JSON is refused. The live body's exact shape is first seen at the designated test booking. Every typed field is also re-read before leaving each step and before Schedule. SharedWorker, WebRTC and WebTransport are removed from every frame and QUIC is off (the guard cannot see those channels); service workers are blocked and WebSockets closed. Each allowed request is sent from Node with no retry and no redirect |
| Only the job's worker can act on it | Random session token, stored as a SHA-256 hash; held in a module-private map behind a private-field brand |
| Counted rows cannot be erased | Triggers forbid DELETE and TRUNCATE on jobs, sessions, attempts, events and control, and forbid changing identity, admission or attempt timestamps; outcomes are write-once |
| Duplicates | Spectora API check before the browser opens, and the database's own check at reservation (±14 days, against SUBMITTING, REQUESTED, CONFIRMED and UNKNOWN jobs) |
| Fail closed | Any Spectora API error, pagination without a total or with a count mismatch, missing API key, missing control row or unreadable state blocks |
| AI cannot change controls | AI clients get only a bearer token for the booking API (below), never a database credential. The API has two operations (submit, status); a possible duplicate is reported only as `{ "kind": … }`, never another inspection's id, time, address or customer. The worker's `truss_app` role can execute 13 `app_*` functions and nothing else |
| Kill switch | Its own table, `safety.kill_switch`, which no `app_*` function ever writes or locks: an owner disable takes effect immediately even while a worker holds the global lock, and verification reads it fresh |
| Live gate | Booking mode against Spectora needs `TRUSS_LIVE_SUBMISSIONS=enabled` on the worker host *and* the database kill switch enabled with a Spectora approval reference. The only URLs accepted are the official scheduler and a localhost test server, and a localhost server can book only in the test suite |
| Price | Spectora sets it. The amount labelled "Total" and each line are recorded with the job (`spectoraShown`, also in the API status); nothing is computed or checked |
| Require Confirmation | If Spectora's answer (or the lookup after an uncertain submit) shows a new booking already confirmed, the database records a report, append-only, and counts submissions as off until you check the setting and enable them again. Workers never write the kill switch itself |
| SMS consent | A consent value may be true only with recorded evidence (how and when the customer agreed). Boxes are re-checked after Step 3 and in the create request itself |

## Duplicate matching

Addresses are parsed into number, street name, directional, street type, unit and ZIP. The full USPS
street-type table (also inside names: "Mountain View", "Highway 60"), directionals (including "N W" and
"N.W."), Saint/Mount/Fort, unit words and leading zeros, ordinals ("Eleventh", "Twenty-First", a bare
"7"), accents, case and punctuation are normalized.

Property:

| Comparison | Result |
| --- | --- |
| `1700 W. Washington St.` vs `1700 West Washington Street`; `W St John Rd` vs `W Saint John Rd` | same property |
| `1700 E Washington St` vs `1700 W Washington St` | different property |
| different unit, street type or ZIP when both sides give one | different property |
| same number and ZIP, different street name (`1700 W Washington St` / `1700 W Jefferson St`, 85007) | possible match |
| a house number that cannot be read (`Unit 4, 1700 W …`, `1700-4 W …`, `1700W …`) in the same ZIP | possible match |
| the same number with a letter on one side or different letters (`12A` / `12`) | possible match |
| singular / plural street type (`Trail` / `Trails`, `Court` / `Courts`); a unit of another kind (`Bldg 4` / `Apt 4` / `Lot 4`) | possible match |
| `Saint Rd` / `Street Rd` | not the same (a possible match at most, by the ZIP rule) |
| one side has no directional, street type, unit or ZIP | possible match |
| one side's street words appear inside the other's (`E Mountain View` / `E Mountain View Rd`) | possible match |
| units that differ only in separators (`4-B` / `4B`, `1-2` / `12`) | possible match |
| text the parser cannot place (parentheses, intersections) | possible match at most |

Booking:

| Existing inspection (±14 days) | Result |
| --- | --- |
| same property, any customer | duplicate → BLOCKED |
| possible match on the property | BLOCKED, manual booking |
| another property, same customer (email/phone) or same name, **same appointment time** | possible match → BLOCKED, manual booking |
| another property, same customer, another time | allowed: a customer may book several properties |
| another property, another customer | allowed |

The same rules exist in TypeScript (`src/booking/address.ts`, `src/spectora/duplicateCheck.ts`) and SQL
(`safety._property_relation`, `safety._local_conflict`); the tests check they agree.

## Price and property details

Spectora is the only authority on price. The agent accepts what the Review shows and records it with the
job (`spectoraShown`: total, lines, and the square footage and year built that were entered). Square
footage and year built are optional in a request: when given they are typed over Spectora's property
lookup; when left out, Spectora's lookup values are used as Spectora fills them (never invented). If
Spectora then refuses Step 1, the job is NEEDS_INPUT and says what to send. The pricing research from
2026-10-25 is kept in `docs/pricing-research/` for reference; it is not used.

## Booking API

A small HTTP server for an AI assistant (`src/api/server.ts`). It adds no policy: every request goes
through the same validation, runner and database functions as the worker command.

| Route | |
| --- | --- |
| `GET /v1/health` | liveness, no authentication |
| `GET /v1/schema` | the request's JSON Schema, bookable services and add-ons, what each state means, the rules |
| `POST /v1/bookings` | start a booking. `Idempotency-Key` header, JSON body. 422 + issues if invalid (nothing counted), 503 while live submissions are off, 409 if a booking is running, else 202 |
| `GET /v1/bookings/{key}` | status: `running`, the recorded job (state, reason, Spectora id, appointment), or the refusal |

`Authorization: Bearer <token>`; the server holds only SHA-256 hashes of valid tokens and compares in
constant time. Each token sees only the bookings it started (the stored key carries the token's id). 60
requests and 6 booking starts per minute per token, 32 KB bodies, 15 s per request, 64 connections, one
booking at a time.
There is no route that changes limits, the breaker, the kill switch or reconciliation.

```
npm run api -- new-token     # prints a token (give it to the assistant) and its hash
APP_DATABASE_URL=… SPECTORA_API_KEY=… TRUSS_API_TOKEN_SHA256=<hash> npm run api   # 127.0.0.1:8787
```

Bind it to localhost (the default) and put a TLS proxy in front if the assistant runs elsewhere. Without
`TRUSS_LIVE_SUBMISSIONS=enabled` it validates requests and serves status, and answers POST with 503.

## Database roles

Run `db/roles.sql` once as an admin, then set each password in your provider's console.

| Role | Used by | Credential lives |
| --- | --- | --- |
| `truss_migrator` | `npm run migrate` on deploy | Deploy pipeline only |
| `truss_app` | The booking worker and the booking API | Worker host only (`APP_DATABASE_URL`). Never an AI client: anyone with it can record outcomes, so AI clients get an API token instead |
| `truss_owner` | `npm run owner` | Your machine only (`OWNER_DATABASE_URL`) |

`truss_migrator` owns the schema and can change anything; that is what a deploy is. Never give it to the
worker or to any AI client. `001_safety.sql` has not been applied to a real database; once it has, it is
frozen and later changes go in `002_*.sql`.

## Running the worker

```
APP_DATABASE_URL=postgres://truss_app:…@host/truss SPECTORA_API_KEY=… \
  npm run worker -- dry-run examples/dry-run-request.json      # up to the Review; no submit, no text to Truss
TRUSS_LIVE_SUBMISSIONS=enabled … npm run worker -- book request.json --key <idempotency key>
```

Set `TRUSS_LOG_CREATE_FIELDS=1` for the designated test booking: it prints the create request's field
names (never their values) to stderr, so the create-body check can then be pinned to Spectora's real shape.

One job per run. Exit code 0 means the job reached a final state (printed as JSON); 2 refused or invalid;
3 the browser would not stop (run `owner release-session` after the process is gone).

## Tests

```
npm test               # full suite against a throwaway PostgreSQL 14+ server
npm run typecheck
```

If the PostgreSQL binaries are not found automatically, set `PG_BIN` to their directory.

## Owner runbook

```
npm run owner -- status                    # jobs, submissions, last hour, browser session, kill switch, breaker
npm run owner -- jobs                      # history
npm run owner -- errors                    # what needs reconciling, recent safety events
npm run owner -- disable --reason "…"      # stop all new submissions now (also stops one about to submit)
npm run owner -- enable --approval-ref "…" --reason "…" --yes
npm run owner -- ack-confirmation --reason "…"   # after a confirmation report (see below)
npm run owner -- lookup <jobId>            # read-only Spectora search for that job
npm run owner -- reconcile <jobId> --found <inspectionId> [--confirmed] --note "…"
npm run owner -- reconcile <jobId> --not-found --note "…"
npm run owner -- reset-breaker --reason "…" --yes
npm run owner -- release-session <jobId> --note "…"   # after a worker whose browser would not stop has exited
```

From a phone, most hosted PostgreSQL providers have a web SQL console. Signed in as `truss_owner`:
`SELECT safety.owner_disable_submissions('reason');`

**Breaker opened:** run `errors`, reconcile every UNKNOWN job (Spectora dashboard or `lookup`), fix the
cause, then `reset-breaker`. The reset is refused while anything is unreconciled.

**`BrowserDidNotStopError` (worker exit code 3):** the browser ignored the stop request. The worker exits
and its browser with it, but the browser slot stays held. Check nothing is still running on the worker
host, then `npm run owner -- release-session <jobId> --note "…"`. If it was submitting, the job becomes
UNKNOWN for you to reconcile.

**Reconcile refused with `session_in_progress`:** that job's worker is still alive. Wait, or stop it.

**An owner command fails with a lock timeout after 20 s** (reset-breaker, reconcile, release-session wait
for the global lock): a worker connection is holding it. `disable` never waits. As the database admin, in
the provider's console:
`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'truss_app';`

**Status shows submissions off with `stopped_by_confirmation_report`:** Spectora confirmed a new booking on
creation. Turn Require Confirmation back on in Spectora, then `ack-confirmation`, then `enable`. `enable` is
refused while a report is unacknowledged, and it waits for any report being written at that moment.

**UNKNOWN:** the submit may or may not have reached Spectora. That job never gets another attempt, and
no booking job at all runs until you reconcile it (`lookup`, then `reconcile`). After "not found", send a
new job (new idempotency key); it is checked again from scratch.

**Confirming:** bookings arrive in Spectora as requests (Require Confirmation stays on). After you
confirm one in Spectora, record it: `reconcile <jobId> --found <inspectionId> --confirmed --note "…"`.
