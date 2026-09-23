import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// The monorepo keeps its shared .env at the repo root; load it here so both
// server-side (API_URL) and client-inlined (NEXT_PUBLIC_*) env vars resolve.
loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), override: true });

const config: NextConfig = {
  transpilePackages: ["@urlchecker/shared"],
};

export default config;