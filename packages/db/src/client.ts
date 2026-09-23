import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;

function sslConfig(connectionString: string): object | undefined {
  const params = new URL(connectionString).searchParams;
  if (params.get("sslmode") === "require" || params.get("ssl") === "true") {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

export function createDb(connectionString: string, max = 10): { pool: Pool; db: Db } {
  const pool = new Pool({
    connectionString,
    max,
    ssl: sslConfig(connectionString),
  });
  const instance = drizzle(pool, { schema });
  return { pool, db: instance };
}

export { schema };