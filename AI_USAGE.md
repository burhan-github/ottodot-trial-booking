# AI Usage

> Draft written with Claude Code from what happened in the session.
> _TODO (Burhannudin): review, correct anything that does not match your experience, and fill in the tool name below._

## Tools

- **_TODO: name of the chat assistant_**: used to produce a step-by-step plan (schema, state machine, locking strategy, test list, README outline) before any code.
- **Claude Code (Claude Opus 5.5)**: reviewed that plan against the brief, then implemented the schema, service, API routes, tests, UI, and docs under my direction. Commits co-authored by Claude are marked `Co-Authored-By`.

## What I used AI for

- Turning the brief into a design: entities, statuses, invariants, and where each check lives.
- Critiquing the plan before coding (details below).
- Writing the implementation and the integration tests, including the concurrency tests.
- Scaffolding Next.js 16 conventions I am less familiar with, such as async route `params` and the ESLint rules.
- Drafting the README.

## Where AI helped me move faster

- **Scaffolding plus boilerplate.** Going from an empty folder to a working Next.js app,
  schema, seed, and 13 passing integration tests took well under an hour, while the time
  I spent on decisions stayed the same.
- **Test fixtures.** The fixture design (each test builds its own class and families)
  meant the tests could safely run against a shared remote database from the start.

## Where I corrected or rejected AI output

The first AI plan had several flaws that I rejected after a second review pass:

1. **Idempotency that did nothing.** The plan used a unique `provider_reference` for
   idempotency, but the same plan generated a fresh random reference on every request,
   so the unique index could never catch a duplicate. I replaced it with a
   client-supplied `Idempotency-Key`, checked under the booking row lock.
2. **`RAISE EXCEPTION 'CLASS_FULL'` inside the confirm function.** This rolls back the
   whole transaction, so a captured payment would leave no trace and the booking would
   stay `pending_payment` forever. Now the function returns an outcome, cancels the
   booking, and records the payment with `refund_required`.
3. **Retrying on the same booking** (`payment_failed → pending_payment`). This conflicts
   with the partial unique index: the child could already have a new active booking,
   which would cause a unique violation and a 500. I made every status terminal instead;
   a retry is a new booking.
4. **The seed data contradicted the demo.** Every seeded child was already confirmed in
   the 3/4 class, so nobody could take the last seat. I added more families.
5. **An overclaim in the plan's README text**: "database constraint prevents
   overbooking". A `CHECK` cannot count rows; it is the lock plus the re-check.

**One the AI itself got wrong during implementation.** Its first negative-control
script (remove the lock and expect the race test to fail) put the artificial delay
*before* the `COUNT`. The unlocked code still passed, by luck. Instead of accepting a
green result, we investigated: we probed that connections really run in parallel, then
moved the delay into the real race window, between `COUNT` and `COMMIT`. Only then did
the unlocked version overbook and the test fail, which is what proves the test is
meaningful.

## What I would change next time

- Start with a single brief-to-invariants checklist and have the AI check every
  proposal against it. Most of the plan's flaws were internal contradictions that a
  checklist would have caught.
- Ask for the negative control (break it on purpose, watch the test fail) at the same
  time as the concurrency test, not afterwards.
- Share environment facts early, such as "plain Postgres behind PgBouncer, no Docker".
  The plan assumed Supabase RPC and anon keys, which did not match the environment.

## How I verified the final implementation

- 13 integration tests against real PostgreSQL 16 (`npm test`), including 6 concurrent
  payments for the last seat and concurrent duplicate bookings.
- The negative control (`npm run verify:lock`) showing that the race test fails without
  the lock.
- A manual HTTP smoke test of every endpoint and the brief's B-pays-first scenario.
- `npm run build` and `eslint` pass.
- _TODO: what you personally read/re-ran yourself._
