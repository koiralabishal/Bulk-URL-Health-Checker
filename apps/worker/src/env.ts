import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name}. Copy .env.example to .env and fill it.`);
  }
  return value;
}

export const env = {
  DATABASE_URL: requireEnv("DATABASE_URL"),
  REDIS_URL: requireEnv("REDIS_URL"),
  // Only meaningful on Render (free Web Service port scan). Locally the API
  // owns :3001 — never bind it from the worker or SSR fetches get "worker ok".
  HEALTH_PORT: process.env.RENDER ? Number(process.env.PORT ?? 0) || null : null,
  HOST: process.env.HOST ?? "0.0.0.0",
};