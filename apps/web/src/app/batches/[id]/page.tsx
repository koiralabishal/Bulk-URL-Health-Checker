import { notFound } from "next/navigation";
import { fetchBatchDetail } from "@/lib/api";
import BatchLive from "@/components/batch-live";

export const dynamic = "force-dynamic";

export default async function BatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await fetchBatchDetail(id);
  if (!detail) notFound();
  return <BatchLive batchId={id} initial={detail} />;
}