import {
  BatchDetailSchema,
  BatchesPageSchema,
  DeleteBatchResponseSchema,
  DeleteUrlsResponseSchema,
  type BatchDetail,
  type BatchesPage,
  type DeleteBatchResponse,
  type DeleteUrlsResponse,
} from "@urlchecker/shared";

export function apiUrl(): string {
  if (typeof window !== "undefined") {
    return process.env.NEXT_PUBLIC_API_URL ?? `http://${window.location.hostname}:3001`;
  }
  return process.env.API_URL ?? "http://localhost:3001";
}

export async function fetchBatchesPage(page = 1, pageSize = 10): Promise<BatchesPage> {
  const res = await fetch(`${apiUrl()}/api/batches?page=${page}&pageSize=${pageSize}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`API /api/batches failed with ${res.status}`);
  return BatchesPageSchema.parse(await res.json());
}

export async function fetchBatchDetail(id: string): Promise<BatchDetail | null> {
  const res = await fetch(`${apiUrl()}/api/batches/${id}`, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`API /api/batches/${id} failed with ${res.status}`);
  return BatchDetailSchema.parse(await res.json());
}

async function post(path: string): Promise<void> {
  const res = await fetch(`${apiUrl()}${path}`, { method: "POST" });
  if (!res.ok) {
    let message = `API returned ${res.status}`;
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch {
      // keep default
    }
    throw new Error(message);
  }
}

async function del(path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${apiUrl()}${path}`, {
    method: "DELETE",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let message = `API returned ${res.status}`;
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch {
      // keep default
    }
    throw new Error(message);
  }
  if (res.status === 204) return { ok: true };
  return res.json();
}

export async function createBatch(urls: string[]): Promise<string> {
  const res = await fetch(`${apiUrl()}/api/batches`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ urls }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `API returned ${res.status}`);
  return data.batchId as string;
}

export function reanalyzeBatch(batchId: string): Promise<void> {
  return post(`/api/batches/${batchId}/re-analyze`);
}

export function retryFailed(batchId: string): Promise<void> {
  return post(`/api/batches/${batchId}/retry-failed`);
}

export function reanalyzeUrl(batchId: string, urlId: string): Promise<void> {
  return post(`/api/batches/${batchId}/urls/${urlId}/re-analyze`);
}

export function cancelBatch(batchId: string): Promise<void> {
  return post(`/api/batches/${batchId}/cancel`);
}

export async function deleteBatch(batchId: string): Promise<DeleteBatchResponse> {
  const data = await del(`/api/batches/${batchId}`);
  return DeleteBatchResponseSchema.parse(data);
}

export async function deleteBatches(ids: string[]): Promise<DeleteBatchResponse> {
  const data = await del(`/api/batches`, { ids });
  return DeleteBatchResponseSchema.parse(data);
}

export async function deleteUrl(batchId: string, urlId: string): Promise<DeleteUrlsResponse> {
  const data = await del(`/api/batches/${batchId}/urls/${urlId}`);
  return DeleteUrlsResponseSchema.parse(data);
}

export async function deleteUrls(batchId: string, urlIds: string[]): Promise<DeleteUrlsResponse> {
  const data = await del(`/api/batches/${batchId}/urls`, { urlIds });
  return DeleteUrlsResponseSchema.parse(data);
}