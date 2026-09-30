import { DatabaseError } from "pg";
import { db } from "@/lib/db";
import { mockPayment, type PaymentResult } from "@/lib/payment/mockPayment";
import { BookingError } from "./errors";

export type BookingStatus = "pending_payment" | "confirmed" | "payment_failed" | "cancelled";

export type TrialClassSummary = {
  id: string;
  name: string;
  startsAt: string;
  capacity: number;
  confirmedCount: number;
  availableSeats: number;
};

export type Booking = {
  id: string;
  parentId: string;
  studentId: string;
  trialClassId: string;
  status: BookingStatus;
  cancelReason: string | null;
};

export type PaymentOutcome = {
  outcome: "confirmed" | "payment_failed" | "class_full" | "not_payable";
  bookingId: string;
  status: BookingStatus;
  /** True when the same Idempotency-Key was already processed. */
  replayed: boolean;
  /** Whether the (mock) provider was actually charged by this request. */
  charged: boolean;
  /** Money captured but the seat was lost to a concurrent payment. */
  refundRequired: boolean;
};

// Only confirmed bookings consume a seat. Pending bookings do not hold one.
const CLASS_SUMMARY_SQL = `
  SELECT tc.id, tc.name, tc.starts_at, tc.capacity,
         COUNT(b.id) FILTER (WHERE b.status = 'confirmed')::int AS confirmed_count
  FROM trial_classes tc
  LEFT JOIN bookings b ON b.trial_class_id = tc.id`;

function toClassSummary(row: {
  id: string;
  name: string;
  starts_at: Date;
  capacity: number;
  confirmed_count: number;
}): TrialClassSummary {
  return {
    id: row.id,
    name: row.name,
    startsAt: row.starts_at.toISOString(),
    capacity: row.capacity,
    confirmedCount: row.confirmed_count,
    availableSeats: Math.max(0, row.capacity - row.confirmed_count),
  };
}

export async function listTrialClasses(): Promise<TrialClassSummary[]> {
  const { rows } = await db().query(`${CLASS_SUMMARY_SQL} GROUP BY tc.id ORDER BY tc.starts_at`);
  return rows.map(toClassSummary);
}

export async function getTrialClass(id: string): Promise<TrialClassSummary | null> {
  const { rows } = await db().query(`${CLASS_SUMMARY_SQL} WHERE tc.id = $1 GROUP BY tc.id`, [id]);
  return rows[0] ? toClassSummary(rows[0]) : null;
}

export async function listParentsWithStudents() {
  const { rows } = await db().query(`
    SELECT p.id, p.name,
           COALESCE(json_agg(json_build_object('id', s.id, 'name', s.name) ORDER BY s.name)
                    FILTER (WHERE s.id IS NOT NULL), '[]') AS students
    FROM parents p LEFT JOIN students s ON s.parent_id = p.id
    GROUP BY p.id ORDER BY p.name`);
  return rows as { id: string; name: string; students: { id: string; name: string }[] }[];
}

export async function getBooking(id: string): Promise<Booking | null> {
  const { rows } = await db().query(
    `SELECT id, parent_id, student_id, trial_class_id, status, cancel_reason
     FROM bookings WHERE id = $1`,
    [id],
  );
  const r = rows[0];
  return r
    ? {
        id: r.id,
        parentId: r.parent_id,
        studentId: r.student_id,
        trialClassId: r.trial_class_id,
        status: r.status,
        cancelReason: r.cancel_reason,
      }
    : null;
}

export async function getRoster(trialClassId: string) {
  const trialClass = await getTrialClass(trialClassId);
  if (!trialClass) throw new BookingError("CLASS_NOT_FOUND", "Trial class not found.");
  const { rows } = await db().query(
    `SELECT s.id, s.name, b.updated_at AS confirmed_at
     FROM bookings b JOIN students s ON s.id = b.student_id
     WHERE b.trial_class_id = $1 AND b.status = 'confirmed'
     ORDER BY b.updated_at`,
    [trialClassId],
  );
  return {
    trialClass,
    students: rows.map((r) => ({ id: r.id, name: r.name, confirmedAt: r.confirmed_at })),
  };
}

/**
 * Creates a pending_payment booking. This does NOT reserve a seat: seats are
 * only taken at payment confirmation (see settle_payment in db/schema.sql).
 */
export async function createBooking(input: {
  parentId: string;
  studentId: string;
  trialClassId: string;
}): Promise<Booking> {
  const owned = await db().query("SELECT 1 FROM students WHERE id = $1 AND parent_id = $2", [
    input.studentId,
    input.parentId,
  ]);
  // Same response for "no such student" and "not your student", so the API
  // does not reveal which students exist under other parents.
  if (owned.rowCount === 0) throw new BookingError("STUDENT_NOT_FOUND", "Student not found.");

  const trialClass = await getTrialClass(input.trialClassId);
  if (!trialClass) throw new BookingError("CLASS_NOT_FOUND", "Trial class not found.");
  // Fast-fail for UX only. The authoritative capacity check happens under a
  // row lock at confirmation time.
  if (trialClass.availableSeats === 0) {
    throw new BookingError("CLASS_FULL", "This class is already full.");
  }

  try {
    const { rows } = await db().query(
      `INSERT INTO bookings (parent_id, student_id, trial_class_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [input.parentId, input.studentId, input.trialClassId],
    );
    return (await getBooking(rows[0].id))!;
  } catch (err) {
    // The partial unique index is the real duplicate guard: it also covers two
    // concurrent requests that would both pass an application-level SELECT.
    if (err instanceof DatabaseError && err.constraint === "uq_active_booking_per_student_class") {
      throw new BookingError(
        "DUPLICATE_BOOKING",
        "This student already has an active booking for this class.",
      );
    }
    throw err;
  }
}

export async function payForBooking(input: {
  bookingId: string;
  idempotencyKey: string;
  result: PaymentResult;
}): Promise<PaymentOutcome> {
  const { bookingId, idempotencyKey, result } = input;

  // 1. Replay of an already-processed request: never charge twice.
  const prior = await db().query("SELECT 1 FROM payment_attempts WHERE idempotency_key = $1", [
    idempotencyKey,
  ]);
  if (prior.rowCount) return settle(bookingId, idempotencyKey, result, null, false);

  // 2. Pre-checks before touching the payment provider.
  const booking = await getBooking(bookingId);
  if (!booking) throw new BookingError("BOOKING_NOT_FOUND", "Booking not found.");
  if (booking.status !== "pending_payment") {
    return { ...noCharge(bookingId, booking.status), outcome: "not_payable" };
  }
  const trialClass = await getTrialClass(booking.trialClassId);
  if (trialClass!.availableSeats === 0) {
    // Someone else confirmed the last seat while this parent was on the
    // payment step. Cancel without charging. Seats never free up in this
    // scope, so "0 available" here cannot become stale in the other direction.
    const { rowCount } = await db().query(
      `UPDATE bookings SET status = 'cancelled', cancel_reason = 'class_full', updated_at = NOW()
       WHERE id = $1 AND status = 'pending_payment'`,
      [bookingId],
    );
    if (rowCount) return { ...noCharge(bookingId, "cancelled"), outcome: "class_full" };
  }

  // 3. Charge (outside any DB transaction: never hold a lock across a network call).
  const payment = await mockPayment(result);

  // 4. Record the result and settle the booking atomically under the class lock.
  return settle(bookingId, idempotencyKey, payment.status, payment.providerReference, true);
}

function noCharge(bookingId: string, status: BookingStatus) {
  return { bookingId, status, replayed: false, charged: false, refundRequired: false };
}

async function settle(
  bookingId: string,
  idempotencyKey: string,
  result: PaymentResult,
  providerReference: string | null,
  charged: boolean,
): Promise<PaymentOutcome> {
  try {
    const { rows } = await db().query("SELECT settle_payment($1, $2, $3, $4) AS r", [
      bookingId,
      idempotencyKey,
      result,
      providerReference,
    ]);
    const r = rows[0].r;
    return {
      outcome: r.outcome,
      bookingId: r.bookingId,
      status: r.status,
      replayed: r.replayed,
      charged: charged && !r.replayed,
      refundRequired: charged && !r.replayed && r.outcome === "class_full",
    };
  } catch (err) {
    if (err instanceof DatabaseError) {
      if (err.message === "BOOKING_NOT_FOUND") {
        throw new BookingError("BOOKING_NOT_FOUND", "Booking not found.");
      }
      if (
        err.message === "IDEMPOTENCY_KEY_REUSED" ||
        err.constraint === "payment_attempts_idempotency_key_key"
      ) {
        throw new BookingError(
          "IDEMPOTENCY_KEY_REUSED",
          "This Idempotency-Key was already used for a different request.",
        );
      }
    }
    throw err;
  }
}
