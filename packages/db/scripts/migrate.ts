import { readdir } from "node:fs/promises";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "../src/client";

loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

if (await readdir(migrationsFolder).catch(() => null)) {
  const url = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL_DIRECT (or DATABASE_URL) is required to migrate");
  }
  const { pool, db } = createDb(url, 1);
  try {
    await migrate(db, { migrationsFolder });
    console.log("[migrate] migrations applied");
  } finally {
    await pool.end();
  }
} else {
  console.log("[migrate] no migrations found, run `pnpm db:generate` first");
}