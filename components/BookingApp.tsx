"use client";

import { useCallback, useEffect, useState } from "react";

type Student = { id: string; name: string };
type Parent = { id: string; name: string; students: Student[] };
type TrialClass = {
  id: string;
  name: string;
  startsAt: string;
  capacity: number;
  confirmedCount: number;
  availableSeats: number;
};
type Roster = { trialClass: TrialClass; students: { id: string; name: string }[] };

// A booking made in this browser session. The idempotency key is created once
// per booking, so double clicks and network retries replay instead of re-charging.
type SessionBooking = {
  id: string;
  parentName: string;
  studentName: string;
  className: string;
  status: string;
  idempotencyKey: string;
  message?: string;
};

const MESSAGES: Record<string, string> = {
  CLASS_FULL: "Sorry, this class is already full.",
  DUPLICATE_BOOKING: "This student already has an active booking for this class.",
  BOOKING_NOT_PAYABLE: "This booking can no longer be paid.",
  STUDENT_NOT_FOUND: "Student not found.",
};

const STATUS_STYLE: Record<string, string> = {
  pending_payment: "bg-amber-100 text-amber-900",
  confirmed: "bg-green-100 text-green-900",
  payment_failed: "bg-red-100 text-red-900",
  cancelled: "bg-gray-200 text-gray-800",
};

async function api<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; body: T }> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  return { ok: res.ok, body: await res.json() };
}

export function BookingApp() {
  const [parents, setParents] = useState<Parent[]>([]);
  const [classes, setClasses] = useState<TrialClass[]>([]);
  const [parentId, setParentId] = useState("");
  const [studentId, setStudentId] = useState("");
  const [bookings, setBookings] = useState<SessionBooking[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rosterClassId, setRosterClassId] = useState("");
  const [roster, setRoster] = useState<Roster | null>(null);

  const parent = parents.find((p) => p.id === parentId);

  const refresh = useCallback(async () => {
    const { body } = await api<TrialClass[]>("/api/trial-classes");
    setClasses(body);
    setRosterClassId((id) => id || body[0]?.id || "");
  }, []);

  useEffect(() => {
    api<Parent[]>("/api/parents").then(({ body }) => {
      setParents(body);
      setParentId(body[0]?.id ?? "");
      setStudentId(body[0]?.students[0]?.id ?? "");
    });
    api<TrialClass[]>("/api/trial-classes").then(({ body }) => {
      setClasses(body);
      setRosterClassId(body[0]?.id ?? "");
    });
  }, []);

  useEffect(() => {
    if (!rosterClassId) return;
    api<Roster>(`/api/trial-classes/${rosterClassId}/roster`).then(({ body }) => setRoster(body));
  }, [rosterClassId, classes]);

  async function book(trialClass: TrialClass) {
    setBusy(`book:${trialClass.id}`);
    setNotice(null);
    const { ok, body } = await api<{ id: string; status: string; error?: string }>("/api/bookings", {
      method: "POST",
      body: JSON.stringify({ parentId, studentId, trialClassId: trialClass.id }),
    });
    setBusy(null);
    if (!ok) {
      setNotice(MESSAGES[body.error ?? ""] ?? "Something went wrong. Please try again.");
      return;
    }
    setBookings((bs) => [
      {
        id: body.id,
        status: body.status,
        parentName: parent?.name ?? "",
        studentName: parent?.students.find((s) => s.id === studentId)?.name ?? "",
        className: trialClass.name,
        idempotencyKey: crypto.randomUUID(),
      },
      ...bs,
    ]);
  }

  async function pay(booking: SessionBooking, result: "succeeded" | "failed") {
    setBusy(`pay:${booking.id}`);
    const { body } = await api<{
      status: string;
      error?: string;
      charged?: boolean;
      refundRequired?: boolean;
      replayed?: boolean;
    }>(`/api/bookings/${booking.id}/payment`, {
      method: "POST",
      headers: { "Idempotency-Key": booking.idempotencyKey },
      body: JSON.stringify({ result }),
    });
    setBusy(null);

    let message: string | undefined;
    if (body.error === "CLASS_FULL") {
      message = body.refundRequired
        ? "Payment captured, but the last seat was taken a moment earlier. A refund is required."
        : "The last seat was taken before payment. You were not charged.";
    } else if (body.error) {
      message = MESSAGES[body.error] ?? "Something went wrong. Please try again.";
    } else if (body.status === "payment_failed") {
      message = "Payment failed. The child was not added to the roster. You can book again.";
    }
    setBookings((bs) =>
      bs.map((b) => (b.id === booking.id ? { ...b, status: body.status ?? b.status, message } : b)),
    );
    refresh();
  }

  return (
    <div className="mx-auto max-w-5xl space-y-8 p-4 sm:p-8">
      <header>
        <h1 className="text-2xl font-semibold">Ottodot Trial Booking</h1>
        <p className="text-sm text-gray-600">
          Only confirmed bookings take a seat. Capacity is re-checked under a database lock when
          payment is confirmed.
        </p>
      </header>

      <section className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="font-medium">Parent (acting as)</span>
          <select
            className="mt-1 w-full rounded border p-2"
            value={parentId}
            onChange={(e) => {
              const next = parents.find((p) => p.id === e.target.value);
              setParentId(e.target.value);
              setStudentId(next?.students[0]?.id ?? "");
            }}
          >
            {parents.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="font-medium">Child</span>
          <select
            className="mt-1 w-full rounded border p-2"
            value={studentId}
            onChange={(e) => setStudentId(e.target.value)}
          >
            {parent?.students.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      </section>

      {notice && <p className="rounded bg-red-50 p-3 text-sm text-red-800">{notice}</p>}

      <section>
        <h2 className="mb-3 text-lg font-semibold">Trial classes</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          {classes.map((c) => {
            const full = c.availableSeats === 0;
            return (
              <div key={c.id} className="rounded-lg border p-4">
                <h3 className="font-medium">{c.name}</h3>
                <p className="text-sm text-gray-600">{new Date(c.startsAt).toLocaleString()}</p>
                <p className="mt-2 text-sm">
                  {c.confirmedCount} / {c.capacity} confirmed ·{" "}
                  {full ? "full" : `${c.availableSeats} seat${c.availableSeats === 1 ? "" : "s"} left`}
                </p>
                <button
                  className="mt-3 w-full rounded bg-black px-3 py-2 text-sm text-white disabled:opacity-40"
                  disabled={full || !studentId || busy !== null}
                  onClick={() => book(c)}
                >
                  {busy === `book:${c.id}` ? "Booking..." : full ? "Full" : "Book trial"}
                </button>
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Bookings (this session)</h2>
        {bookings.length === 0 && (
          <p className="text-sm text-gray-600">
            No bookings yet. Tip: book the last seat as Alice, switch to Bob and book the same class,
            then pay Bob first to replay the last-seat scenario.
          </p>
        )}
        <ul className="space-y-3">
          {bookings.map((b) => (
            <li key={b.id} className="rounded-lg border p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm">
                  <strong>{b.studentName}</strong> ({b.parentName}) · {b.className}
                </span>
                <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[b.status] ?? ""}`}>
                  {b.status}
                </span>
              </div>
              {b.message && <p className="mt-2 text-sm text-gray-700">{b.message}</p>}
              {b.status === "pending_payment" && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    className="rounded bg-green-700 px-3 py-1.5 text-sm text-white disabled:opacity-40"
                    disabled={busy !== null}
                    onClick={() => pay(b, "succeeded")}
                  >
                    {busy === `pay:${b.id}` ? "Processing..." : "Simulate successful payment"}
                  </button>
                  <button
                    className="rounded border px-3 py-1.5 text-sm disabled:opacity-40"
                    disabled={busy !== null}
                    onClick={() => pay(b, "failed")}
                  >
                    Simulate failed payment
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Roster (admin / teacher)</h2>
        <select
          className="rounded border p-2 text-sm"
          value={rosterClassId}
          onChange={(e) => setRosterClassId(e.target.value)}
        >
          {classes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        {roster && (
          <ol className="mt-3 list-decimal space-y-1 pl-6 text-sm">
            {roster.students.map((s) => (
              <li key={s.id}>{s.name}</li>
            ))}
            {roster.students.length === 0 && <li className="list-none text-gray-600">No confirmed students.</li>}
          </ol>
        )}
      </section>
    </div>
  );
}
