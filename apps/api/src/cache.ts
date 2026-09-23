import {
  BATCH_LIST_CACHE_KEY,
  BATCH_LIST_CACHE_TTL_SECONDS,
  type BatchesPage,
} from "@urlchecker/shared";
import { cache } from "./redis";

const VERSION_KEY = `${BATCH_LIST_CACHE_KEY}:ver`;

function pageKey(version: string, page: number, pageSize: number): string {
  return `${BATCH_LIST_CACHE_KEY}:v${version}:p${page}:s${pageSize}`;
}

/**
 * Returns the cached page (if any) together with the version observed at read
 * time. The caller must pass that same version back to `setBatchesPage` so a
 * concurrent invalidation cannot publish a stale DB snapshot under the new
 * version key.
 */
export async function getBatchesPage(
  page: number,
  pageSize: number,
): Promise<{ data: BatchesPage | null; version: string }> {
  try {
    const version = (await cache.get(VERSION_KEY)) ?? "0";
    const raw = await cache.get(pageKey(version, page, pageSize));
    if (!raw) return { data: null, version };
    return { data: JSON.parse(raw) as BatchesPage, version };
  } catch {
    return { data: null, version: "0" };
  }
}

export async function setBatchesPage(
  page: number,
  pageSize: number,
  data: BatchesPage,
  version: string,
): Promise<void> {
  try {
    await cache.set(pageKey(version, page, pageSize), JSON.stringify(data), "EX", BATCH_LIST_CACHE_TTL_SECONDS);
  } catch {
    // caching is best-effort
  }
}

/**
 * Invalidate by bumping a version prefix: every page key becomes unreachable at
 * once without knowing which pages were cached. Old keys expire via TTL.
 * (Worker completion path bumps the same key directly.)
 */
export async function invalidateBatchesList(): Promise<void> {
  await cache.incr(VERSION_KEY).catch(() => {});
}
