import { closeRedis } from "./redis";
import { pool } from "./db";
import { urlQueue } from "./queue";
import { start } from "./server";

await start();

async function shutdown(signal: string) {
  console.log(`[api] ${signal} received, shutting down`);
  const timer = setTimeout(() => process.exit(1), 5000);
  timer.unref();
  await urlQueue.close().catch(() => {});
  await closeRedis();
  await pool.end().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));