import { Redis, type RedisOptions } from "ioredis";
import { env } from "./env";

const base: RedisOptions = {
  enableReadyCheck: false,
  enableOfflineQueue: true,
  retryStrategy: (times) => Math.min(times * 200, 5000),
};

function onError(role: string) {
  return (err: Error) => console.error(`[redis:${role}] ${err.message}`);
}

// General-purpose client: default (bounded) retries.
export const cache = new Redis(env.REDIS_URL, base);
cache.on("error", onError("cache"));

// BullMQ Queue producer: bounded retries so a broken Redis fails fast to the caller.
export const queueConnection = new Redis(env.REDIS_URL, {
  ...base,
  maxRetriesPerRequest: 1,
});
queueConnection.on("error", onError("queue"));

// Pub/Sub subscriber. Dedicated client once in SUBSCRIBE mode; never run normal commands on it.
export const subscriber = new Redis(env.REDIS_URL, {
  ...base,
  maxRetriesPerRequest: null,
});
subscriber.on("error", onError("pubsub"));

export async function closeRedis(): Promise<void> {
  await Promise.allSettled([cache.quit(), queueConnection.quit(), subscriber.quit()]);
}