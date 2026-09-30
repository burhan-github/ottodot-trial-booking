import { Pool } from "pg";

declare global {
  var __pgPool: Pool | undefined;
}

// One pool per process. In dev, Next.js hot reload re-evaluates modules, so
// the pool is cached on globalThis to avoid leaking connections.
export function db(): Pool {
  if (!globalThis.__pgPool) {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is not set (see .env.example)");
    }
    globalThis.__pgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
    });
  }
  return globalThis.__pgPool;
}
