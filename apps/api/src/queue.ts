import { Queue } from "bullmq";
import { queueConnection } from "./redis";

export const URL_QUEUE_NAME = "url-check";

export type UrlCheckJobData = {
  batchId: string;
  urlId: string;
  runSeq: number;
};

export function jobIdFor(data: UrlCheckJobData): string {
  return `${data.batchId}:${data.urlId}:${data.runSeq}`;
}

export const urlQueue = new Queue<UrlCheckJobData>(URL_QUEUE_NAME, {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 1000 },
  },
});