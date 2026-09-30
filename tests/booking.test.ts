import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { BookingError } from "@/lib/booking/errors";
import { createBooking, getBooking, getRoster, payForBooking } from "@/lib/booking/service";
import {
  cleanupTestData,
  confirmedCount,
  createClassFixture,
  key,
  paymentAttempts,
} from "./fixtures";

beforeAll(cleanupTestData);
afterAll(async () => {
  await cleanupTestData();
  await db().end();
});

const book = (f: { parentId: string; studentId: string }, trialClassId: string) =>
  createBooking({ ...f, trialClassId });

async function expectBookingError(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toBeInstanceOf(BookingError);
  await expect(p).rejects.toMatchObject({ code });
}

describe("booking + payment", () => {
  it("creates a pending_payment booking that does not consume a seat", async () => {
    const { classId, free } = await createClassFixture({ confirmed: 3, freeStudents: 1 });
    const booking = await book(free[0], classId);

    expect(booking.status).toBe("pending_payment");
    expect(await confirmedCount(classId)).toBe(3);
  });

  it("confirms on successful payment and adds the child to the roster", async () => {
    const { classId, free } = await createClassFixture({ confirmed: 3, freeStudents: 1 });
    const booking = await book(free[0], classId);

    const res = await payForBooking({ bookingId: booking.id, idempotencyKey: key(), result: "succeeded" });

    expect(res).toMatchObject({ outcome: "confirmed", status: "confirmed", charged: true });
    const roster = await getRoster(classId);
    expect(roster.students.map((s) => s.id)).toContain(free[0].studentId);
    expect(roster.trialClass.availableSeats).toBe(0);
  });

  it("payment failure does not add the child to the roster, and the child can book again", async () => {
    const { classId, free } = await createClassFixture({ confirmed: 3, freeStudents: 1 });
    const booking = await book(free[0], classId);

    const res = await payForBooking({ bookingId: booking.id, idempotencyKey: key(), result: "failed" });

    expect(res).toMatchObject({ outcome: "payment_failed", status: "payment_failed" });
    expect(await confirmedCount(classId)).toBe(3);
    expect((await getRoster(classId)).students.map((s) => s.id)).not.toContain(free[0].studentId);
    expect(await paymentAttempts(booking.id)).toEqual([{ status: "failed", refund_required: false }]);

    // Retry = a new booking; payment_failed does not block the child.
    const retry = await book(free[0], classId);
    expect(retry.status).toBe("pending_payment");
  });

  it("rejects a duplicate active booking for the same child and class", async () => {
    const { classId, free } = await createClassFixture({ confirmed: 0, freeStudents: 1 });
    const first = await book(free[0], classId);

    await expectBookingError(book(free[0], classId), "DUPLICATE_BOOKING");

    await payForBooking({ bookingId: first.id, idempotencyKey: key(), result: "succeeded" });
    await expectBookingError(book(free[0], classId), "DUPLICATE_BOOKING");
  });

  it("rejects concurrent duplicate bookings via the database constraint", async () => {
    const { classId, free } = await createClassFixture({ confirmed: 0, freeStudents: 1 });

    const results = await Promise.allSettled(Array.from({ length: 5 }, () => book(free[0], classId)));

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((r) => r.status === "rejected")) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({ code: "DUPLICATE_BOOKING" });
    }
  });

  it("rejects booking another parent's child", async () => {
    const { classId, free } = await createClassFixture({ confirmed: 0, freeStudents: 2 });
    const [parentA, parentB] = free;

    await expectBookingError(
      createBooking({ parentId: parentA.parentId, studentId: parentB.studentId, trialClassId: classId }),
      "STUDENT_NOT_FOUND",
    );
  });

  it("rejects booking a full class", async () => {
    const { classId, free } = await createClassFixture({ confirmed: 4, freeStudents: 1 });
    await expectBookingError(book(free[0], classId), "CLASS_FULL");
  });

  it("rejects paying an already confirmed booking with a new key", async () => {
    const { classId, free } = await createClassFixture({ confirmed: 0, freeStudents: 1 });
    const booking = await book(free[0], classId);
    await payForBooking({ bookingId: booking.id, idempotencyKey: key(), result: "succeeded" });

    const again = await payForBooking({ bookingId: booking.id, idempotencyKey: key(), result: "succeeded" });

    expect(again).toMatchObject({ outcome: "not_payable", charged: false });
    expect(await paymentAttempts(booking.id)).toHaveLength(1);
  });

  it("replays the original result for a retried Idempotency-Key", async () => {
    const { classId, free } = await createClassFixture({ confirmed: 0, freeStudents: 1 });
    const booking = await book(free[0], classId);
    const k = key();

    const first = await payForBooking({ bookingId: booking.id, idempotencyKey: k, result: "succeeded" });
    const retry = await payForBooking({ bookingId: booking.id, idempotencyKey: k, result: "succeeded" });

    expect(first).toMatchObject({ outcome: "confirmed", replayed: false });
    expect(retry).toMatchObject({ outcome: "confirmed", replayed: true, charged: false });
    expect(await paymentAttempts(booking.id)).toHaveLength(1);
  });

  it("rejects reusing an Idempotency-Key for a different booking", async () => {
    const { classId, free } = await createClassFixture({ confirmed: 0, freeStudents: 2 });
    const a = await book(free[0], classId);
    const b = await book(free[1], classId);
    const k = key();
    await payForBooking({ bookingId: a.id, idempotencyKey: k, result: "succeeded" });

    await expectBookingError(
      payForBooking({ bookingId: b.id, idempotencyKey: k, result: "succeeded" }),
      "IDEMPOTENCY_KEY_REUSED",
    );
  });
});

describe("last-seat race (capacity 4, 3 already confirmed)", () => {
  it("brief scenario: B pays first, then A's payment is rejected without charging", async () => {
    const { classId, free } = await createClassFixture({ confirmed: 3, freeStudents: 2 });
    const [userA, userB] = free;

    // 1-2. Both select the last seat and move to payment.
    const bookingA = await book(userA, classId);
    const bookingB = await book(userB, classId);

    // 3. B completes payment first.
    const b = await payForBooking({ bookingId: bookingB.id, idempotencyKey: key(), result: "succeeded" });
    expect(b.outcome).toBe("confirmed");

    // 4. A then tries to complete payment.
    const a = await payForBooking({ bookingId: bookingA.id, idempotencyKey: key(), result: "succeeded" });
    expect(a).toMatchObject({ outcome: "class_full", status: "cancelled", charged: false });
    expect(await paymentAttempts(bookingA.id)).toHaveLength(0);

    expect(await confirmedCount(classId)).toBe(4);
    expect((await getBooking(bookingA.id))?.cancelReason).toBe("class_full");
  });

  it("truly concurrent payments: exactly one confirmation, losers flagged for refund", async () => {
    const { classId, free } = await createClassFixture({ confirmed: 3, freeStudents: 6 });
    const bookings = await Promise.all(free.map((f) => book(f, classId)));

    // All six pass the pre-check (3/4 confirmed) and get charged, then race
    // inside settle_payment. The winner is not predetermined.
    const results = await Promise.all(
      bookings.map((b) => payForBooking({ bookingId: b.id, idempotencyKey: key(), result: "succeeded" })),
    );

    const confirmed = results.filter((r) => r.outcome === "confirmed");
    const lost = results.filter((r) => r.outcome === "class_full");
    expect(confirmed).toHaveLength(1);
    expect(lost).toHaveLength(5);
    for (const r of lost) expect(r.status).toBe("cancelled");

    // The invariant, checked in the database itself.
    expect(await confirmedCount(classId)).toBe(4);

    // Anyone who was charged but lost the seat is flagged for refund.
    for (const r of lost.filter((r) => r.charged)) {
      expect(r.refundRequired).toBe(true);
      expect(await paymentAttempts(r.bookingId)).toEqual([{ status: "succeeded", refund_required: true }]);
    }
  });

  it("concurrent double-submit with the same Idempotency-Key settles once", async () => {
    const { classId, free } = await createClassFixture({ confirmed: 3, freeStudents: 1 });
    const booking = await book(free[0], classId);
    const k = key();

    const results = await Promise.all([
      payForBooking({ bookingId: booking.id, idempotencyKey: k, result: "succeeded" }),
      payForBooking({ bookingId: booking.id, idempotencyKey: k, result: "succeeded" }),
    ]);

    expect(results.every((r) => r.outcome === "confirmed")).toBe(true);
    expect(results.filter((r) => r.replayed)).toHaveLength(1);
    expect(await paymentAttempts(booking.id)).toHaveLength(1);
    expect(await confirmedCount(classId)).toBe(4);
  });
});
