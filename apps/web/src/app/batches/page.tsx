import BatchesHistory from "@/components/batches-history";
import { fetchBatchesPage } from "@/lib/api";
import { DEFAULT_PAGE_SIZE } from "@urlchecker/shared";

export const dynamic = "force-dynamic";

export default async function BatchesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const { page: pageParam } = await searchParams;
  const page = Math.max(1, Number.parseInt(pageParam ?? "1", 10) || 1);
  const data = await fetchBatchesPage(page, DEFAULT_PAGE_SIZE);
  return <BatchesHistory initial={data} />;
}
