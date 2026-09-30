import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";

/**
 * Each test builds its own isolated class + families, so tests never depend
 * on the demo seed or on each other, and can run against a shared database.
 */
export async function createClassFixture(opts: { confirmed: number; freeStudents: number }) {
  const tag = randomUUID().slice(0, 8);
  const pool = db();

  const { rows: cls } = await pool.query(
    `INSERT INTO trial_classes (name, starts_at, capacity)
     VALUES ($1, NOW() + INTERVAL '7 days', 4) RETURNING id`,
    [`test-${tag}`],
  );
  const classId: string = cls[0].id;

  // One parent per student, like separate families competing for seats.
  const families: { parentId: string; studentId: string }[] = [];
  for (let i = 0; i < opts.confirmed + opts.freeStudents; i++) {
    const { rows: p } = await pool.query(
      "INSERT INTO parents (name, email) VALUES ($1, $2) RETURNING id",
      [`parent-${tag}-${i}`, `p-${tag}-${i}@test.local`],
    );
    const { rows: s } = await pool.query(
      "INSERT INTO students (parent_id, name) VALUES ($1, $2) RETURNING id",
      [p[0].id, `student-${tag}-${i}`],
    );
    families.push({ parentId: p[0].id, studentId: s[0].id });
  }

  for (const f of families.slice(0, opts.confirmed)) {
    await pool.query(
      `INSERT INTO bookings (parent_id, student_id, trial_class_id, status)
       VALUES ($1, $2, $3, 'confirmed')`,
      [f.parentId, f.studentId, classId],
    );
  }

  return { classId, free: families.slice(opts.confirmed), all: families };
}

export async function confirmedCount(classId: string): Promise<number> {
  const { rows } = await db().query(
    "SELECT COUNT(*)::int AS n FROM bookings WHERE trial_class_id = $1 AND status = 'confirmed'",
    [classId],
  );
  return rows[0].n;
}

export async function paymentAttempts(bookingId: string) {
  const { rows } = await db().query(
    "SELECT status, refund_required FROM payment_attempts WHERE booking_id = $1",
    [bookingId],
  );
  return rows as { status: string; refund_required: boolean }[];
}

export async function cleanupTestData() {
  const pool = db();
  await pool.query(`DELETE FROM payment_attempts WHERE booking_id IN (
      SELECT b.id FROM bookings b JOIN trial_classes c ON c.id = b.trial_class_id
      WHERE c.name LIKE 'test-%')`);
  await pool.query(`DELETE FROM bookings WHERE trial_class_id IN (
      SELECT id FROM trial_classes WHERE name LIKE 'test-%')`);
  await pool.query("DELETE FROM trial_classes WHERE name LIKE 'test-%'");
  await pool.query("DELETE FROM students WHERE name LIKE 'student-%'");
  await pool.query("DELETE FROM parents WHERE email LIKE '%@test.local'");
}

export const key = () => randomUUID();
