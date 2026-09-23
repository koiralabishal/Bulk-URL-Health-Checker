import { batchChannel, BATCHES_LIST_CHANNEL, type ServerToClientMessage } from "@urlchecker/shared";
import { cache } from "./redis";

export { batchChannel };

export async function publish(batchId: string, message: ServerToClientMessage): Promise<void> {
  const payload = JSON.stringify(message);
  await cache.publish(batchChannel(batchId), payload);
  // List subscribers (history table) only care about batch-level summaries.
  if (message.type === "batch_updated") {
    await cache.publish(BATCHES_LIST_CHANNEL, payload).catch(() => {});
  }
}
