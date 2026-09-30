# Ottodot Trial Booking

The smallest working slice of a trial-class booking flow: a parent picks a child and a
trial class, books it, completes a mock payment, and sees the booking status. Admins
and teachers see a roster of **confirmed** students only. Classes are capped at 4.

The focus is backend correctness: the data model, the invariants, and the last-seat
race. The UI is intentionally plain.

**Stack:** Next.js 16 (App Router, route handlers) · TypeScript · PostgreSQL 16 via `pg` · Zod · Vitest · Tailwind

## How to run

Requires Node 20+ and any PostgreSQL 13+ database.

```bash
npm install
cp .env.example .env.local      # set DATABASE_URL
npm run db:reset                # creates schema + loads demo seed (destructive)
npm run dev                     # http://localhost:3000
npm test                        # integration tests against the database
npm run verify:lock             # negative control, see "Verification"
```

### Demo seed

| Class | State | Shows |
|---|---|---|
| Science: Forces & Motion | 3 / 4 confirmed | the last-seat race. Booking **Emma Tan** (Alice) again gives the duplicate case |
| Math: Fractions | 0 / 4, plus Mia Lim `payment_failed` | available seats, and a failed payment that is not on the roster |
| Science: Energy | 4 / 4 | a full class |

**Replaying the brief's scenario in the UI:**
1. As Alice, book Noah into Forces & Motion (user A).
2. Switch to Bob and book Mia into the same class (user B).
3. Pay for Mia first. She is confirmed and the class is now 4 / 4.
4. Pay for Noah. He is rejected with *"You were not charged"* and the booking becomes `cancelled`.

## What I built

| Endpoint | Purpose |
|---|---|
| `GET /api/trial-classes` | Classes with `confirmedCount` and `availableSeats` |
| `GET /api/parents` | Parents and their children. Stands in for "the logged-in parent" |
| `POST /api/bookings` | `{parentId, studentId, trialClassId}` → `201` `pending_payment` |
| `GET /api/bookings/:id` | Booking status |
| `POST /api/bookings/:id/payment` | `{result: "succeeded" \| "failed"}` plus an `Idempotency-Key` header |
| `GET /api/trial-classes/:id/roster` | Confirmed students only |

- Route handlers only parse input and map errors to HTTP codes (`app/api/**`).
- Business logic lives in `lib/booking/service.ts`.
- The critical section is one PL/pgSQL function, `settle_payment`, in `db/schema.sql`.

**HTTP semantics:**
- `400` means invalid input.
- `404` means not found, including a student who belongs to another parent.
- `409` means a business conflict: `DUPLICATE_BOOKING`, `CLASS_FULL`, `BOOKING_NOT_PAYABLE`, or `IDEMPOTENCY_KEY_REUSED`.
- A **failed payment returns `200`** with `status: payment_failed`. The request itself succeeded; the payment outcome is business data.

## Backend design

### Data model

```
parents 1──< students 1──< bookings >──1 trial_classes
                               1
                               └──< payment_attempts
```

- `trial_classes.capacity` is data (default 4), not a constant in code.
- `bookings.status`: `pending_payment | confirmed | payment_failed | cancelled`. When the status is `cancelled`, `cancel_reason` gives the cause (for example `class_full`).
- `payment_attempts` records every provider result and has these fields:
  - `idempotency_key` (unique)
  - `provider_reference`
  - `refund_required`, set when money was captured but the seat was lost

### Booking statuses

```
pending_payment ──paid, seat free──────► confirmed         (terminal)
       │ ─────────payment failed────────► payment_failed    (terminal)
       └──────────class already full────► cancelled         (terminal, cancel_reason = class_full)
```

A retry after a failure is a **new booking**. Keeping every status terminal keeps the
state machine and the audit trail simple.

**Only `confirmed` consumes a seat.** A pending booking does not hold one.

### Invariants and where they are enforced

| Invariant | Enforced by |
|---|---|
| At most one *active* (`pending_payment` / `confirmed`) booking per child per class | **DB**: partial unique index `uq_active_booking_per_student_class` |
| A parent can only book their own child | **DB**: composite FK `(student_id, parent_id) → students(id, parent_id)`. The backend checks first so it can return a clean 404 |
| Confirmed bookings ≤ capacity | **DB transaction**: row lock on the class plus a re-count inside `settle_payment` |
| A failed payment never reaches the roster | Only `settle_payment` sets `confirmed`, and only on success. The roster filters `status = 'confirmed'` |
| One payment request is settled at most once | **DB**: unique `idempotency_key`, checked after the booking row lock |

A plain `CHECK` constraint cannot express "count of rows ≤ capacity". The capacity rule
is guaranteed by locking plus a transactional re-check, **not** by a constraint.

### Preventing duplicate bookings

- The partial unique index is the real guard. `createBooking` does not do a separate
  `SELECT` before inserting; it maps the unique violation to `409 DUPLICATE_BOOKING`.
- This also covers two concurrent submits, which would both pass an application-level
  check. A test fires 5 identical requests in parallel and exactly one succeeds.
- `payment_failed` and `cancelled` do not block a fresh booking.

### Payment failure

`settle_payment` sets `payment_failed` and records a `failed` attempt in the same
transaction. Seats and the roster are untouched, and the child can book again.

### The last-seat race

Brief scenario: A and B both reach payment for the last seat, B pays first, then A pays.

**Approach:** seats are claimed only at payment confirmation, inside one transaction.

1. **Pre-check before charging.** If the class is already full (B confirmed first), A's
   booking is cancelled and A is **not charged**.
2. **Charge** through the (mock) provider, outside any database transaction. A database
   lock must never be held across a network call.
3. **Settle** by calling `settle_payment` as a single statement, which does the following:
   - `SELECT … FOR UPDATE` on the booking row (to settle the booking and replay idempotency keys)
   - `SELECT … FOR UPDATE` on the **trial class row**, which serializes all confirmations for that class
   - re-count the `confirmed` bookings
   - if the class is full: set the booking to `cancelled`, record the attempt as `succeeded`, and set `refund_required = true`
   - otherwise: set the booking to `confirmed` and record the attempt as `succeeded`

   The pre-check narrows the window but is not trusted. Step 3 is authoritative: if A and
   B pay at the same instant, both pass step 1, but only one can confirm in step 3. The
   other is cancelled and flagged for refund.

   The lock order is always booking row, then class row, so concurrent calls cannot
   deadlock. Postgres runs at `READ COMMITTED` (its default), so the re-count after the
   lock sees confirmations committed while the call was waiting. **Under
   `REPEATABLE READ` this design would need a retry on serialization failure.**

**Why this approach:**
- Postgres already owns both the capacity and the booking state, so the check and the
  write happen atomically next to the data.
- A single-statement function call also works through a transaction-mode pooler
  (the test database sits behind PgBouncer), with no interactive transaction held open
  from Node.
- Redis or a queue would add a second source of truth to keep consistent, without
  solving a problem Postgres cannot already solve here.

**Trade-offs accepted:**
- **No seat hold during payment.** The other option is to reserve the seat at booking
  time with an expiry: `pending_payment` counts against capacity until a TTL passes, and
  a background job releases stale holds. That would stop A from ever being charged, but
  it adds expiry, a background job, and "phantom full" classes caused by abandoned
  checkouts. For a 4-seat trial class I chose simplicity, at the cost of this rare case:
  two payments truly in flight at the same moment means the loser is charged and flagged
  `refund_required`. The refund itself is out of scope.
- Every confirmation for a class is serialized. That is harmless at 4 seats per class
  and one row lock per class.
- Idempotency is a unique key in the database. With a real provider, the same key would
  also be forwarded to the provider, which dedupes the charge itself. The mock provider
  does not dedupe, so two *simultaneous* first requests with the same key could "charge"
  twice even though they settle once.

### Which checks go where

| Layer | Checks |
|---|---|
| **UI** | Disables Book on full classes, disables buttons while a request is in flight, generates one `Idempotency-Key` per booking. UX only, never trusted |
| **Backend** | Input validation (Zod), ownership, class exists, fast-fail on a full class, pre-check before charging, error mapping |
| **Database** | Active-booking uniqueness, ownership FK, capacity under lock, atomic settle plus payment record, idempotency key uniqueness |
| **Background job** (not built) | Refunds for `refund_required` attempts. It would also expire stale `pending_payment` bookings if seat holds were added |

## Verification

`tests/booking.test.ts` has 13 integration tests against a real Postgres. Each test
builds its own isolated class and families, so it does not depend on the seed.

| Test | Expected |
|---|---|
| Create booking | `pending_payment`, seat not consumed |
| Successful payment | `confirmed`, child on roster |
| Failed payment | `payment_failed`, roster unchanged, child can book again |
| Duplicate active booking (pending and confirmed) | `DUPLICATE_BOOKING` |
| 5 concurrent identical bookings | exactly 1 succeeds |
| Another parent's child | `STUDENT_NOT_FOUND` |
| Full class | `CLASS_FULL` |
| Pay a confirmed booking with a new key | `not_payable`, no second payment record |
| Same `Idempotency-Key` twice | original result replayed, 1 payment record |
| Key reused for another booking | `IDEMPOTENCY_KEY_REUSED` |
| **Brief scenario** (B pays, then A pays) | B `confirmed`; A `cancelled`, **not charged**; 4 confirmed |
| **6 truly concurrent payments for 1 seat** | exactly 1 `confirmed`, 5 cancelled with refund flag, confirmed count = 4 |
| Concurrent double-submit with the same key | settled once |

**Negative control (`npm run verify:lock`).** This script does the following:
1. temporarily removes the class-row lock from `settle_payment`,
2. widens the gap between COUNT and COMMIT,
3. runs the concurrency test and shows that it **fails with overbooking**,
4. restores the lock.

It proves the race test can actually detect the bug. My first version of this control
put the delay *before* the COUNT; the unlocked code then passed by luck, because the
real race window is only milliseconds wide. That is a useful reminder that a green
concurrency test is not evidence until you have seen it go red.

Manual checks: the HTTP smoke test (curl through each endpoint and the scenario above),
`npm run build`, and `eslint`.

## Assumptions

- **No authentication.** The parent is chosen from a dropdown, standing in for a
  signed-in session. In production `parentId` would come from the session, never from
  the request body.
- The mock payment result is chosen by the user, to demo both paths.
- A class does not reopen seats. No confirmed booking is ever cancelled in this slice,
  and that is what makes the "full ⇒ cancel without charging" pre-check safe.
- Anyone can read the roster. Admin auth is out of scope.
- Class start time is not validated (booking a class in the past is not blocked).

## What I deliberately cut

Authentication and roles, a real payment provider and webhooks, refunds, seat holds
with expiry, cancelling a confirmed booking, regular enrollment, a migrations tool
(`db/schema.sql` is a drop-and-recreate script), and UI polish.

## What I would monitor after release

- **`refund_required = true` count.** This is the race-loser rate, and every one of
  these needs a refund.
- **Invariant check:** alert if any class has `confirmed` > `capacity`. This should
  always be zero.
- `settle_payment` latency, and lock wait time on `trial_classes`.
- 409 rates by code (`CLASS_FULL`, `DUPLICATE_BOOKING`). A spike suggests UI staleness
  or double-submit bugs.
- Payment failure rate, and bookings stuck in `pending_payment`.
- Payment attempts where the provider succeeded but the booking is not confirmed or
  flagged (reconciliation).

## Next steps with more time

1. Real payment provider: forward the idempotency key, confirm through a webhook, and add a refund job for `refund_required`.
2. Auth: derive the parent from the session, and add an admin role for the roster.
3. Decide on seat holds with a TTL if data shows abandoned-checkout races matter.
4. A migrations tool and CI that runs the tests against an ephemeral Postgres.
5. An HTTP-level test suite, and a load test on a single hot class.
6. A class-start-time cutoff for bookings.

## Time spent

_TODO (Burhannudin): fill in honestly, e.g. "~X h planning/design, ~Y h implementation, ~Z h docs/video"._
