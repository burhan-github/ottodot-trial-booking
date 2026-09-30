// Negative control: temporarily removes the class-row lock from settle_payment,
// runs the concurrency test (expected to FAIL = overbooking), then restores it.
// Proves the race test actually detects the bug it claims to guard against.
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import pg from "pg";
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });
const schema = readFileSync("db/schema.sql", "utf8");
const fn = schema.slice(schema.indexOf("CREATE FUNCTION settle_payment"));
const lockLine = "WHERE id = v_booking.trial_class_id FOR UPDATE;";
if (!fn.includes(lockLine)) throw new Error("lock line not found");
// Also widen the race window (between the COUNT and the commit) so the
// unlocked version reliably interleaves; in real traffic that window is only
// milliseconds wide, which is why a naive race test can pass by luck.
const countCheck = "IF v_confirmed >= v_capacity THEN";
const unlocked = fn
  .replace(lockLine, "WHERE id = v_booking.trial_class_id;")
  .replace(countCheck, "PERFORM pg_sleep(1);\n    " + countCheck)
  .replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION");

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query(unlocked);
  console.log("lock REMOVED; running concurrency test (expect failure)...");
  try {
    execSync('npx vitest run -t "truly concurrent"', { stdio: "inherit" });
    console.log("\nUNEXPECTED: test passed without the lock");
  } catch {
    console.log("\nOK: without the lock the race test fails (overbooking detected)");
  }
} finally {
  await client.query(fn.replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION"));
  console.log("lock restored");
  await client.end();
}
