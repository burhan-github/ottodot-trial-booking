// Drops and recreates the schema, then loads the demo seed.
// Usage: npm run db:reset   (reads DATABASE_URL from .env.local)
import { readFileSync } from "node:fs";
import pg from "pg";
import { config } from "dotenv";

config({ path: ".env.local" });

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
});
await client.connect();
try {
  for (const file of ["db/schema.sql", "db/seed.sql"]) {
    await client.query(readFileSync(file, "utf8"));
    console.log(`applied ${file}`);
  }
} finally {
  await client.end();
}
