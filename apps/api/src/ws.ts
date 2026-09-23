import {
  batchChannel,
  BATCHES_LIST_CHANNEL,
  ClientToServerMessageSchema,
  ServerToClientMessageSchema,
  type ServerToClientMessage,
} from "@urlchecker/shared";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { subscriber } from "./redis";
import { getBatchDetail } from "./routes";

// Clients per channel, per instance. Events are fanned in from Upstash pub/sub.
const channelClients = new Map<string, Set<WebSocket>>();
const subscribedChannels = new Set<string>();

function send(socket: WebSocket, message: ServerToClientMessage): void {
  if (socket.readyState === socket.OPEN) {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      /* socket is tearing down; ignore */
    }
  }
}

subscriber.on("message", (channel, message) => {
  if (!channel.startsWith("batch:")) return;
  const clients = channelClients.get(channel);
  if (!clients) return;
  const parsed = ServerToClientMessageSchema.safeParse(JSON.parse(message));
  if (!parsed.success) return;
  for (const socket of clients) send(socket, parsed.data);
});

async function ensureSubscribed(channel: string): Promise<void> {
  if (subscribedChannels.has(channel)) return;
  subscribedChannels.add(channel);
  await subscriber.subscribe(channel).catch(() => subscribedChannels.delete(channel));
}

async function unsubscribeIfEmpty(channel: string): Promise<void> {
  const clients = channelClients.get(channel);
  if (clients && clients.size > 0) return;
  channelClients.delete(channel);
  if (subscribedChannels.delete(channel)) {
    await subscriber.unsubscribe(channel).catch(() => {});
  }
}

export async function registerSocketRoutes(fastify: FastifyInstance): Promise<void> {
  // Shared list channel: one socket streams `batch_updated` for every batch the
  // history table is showing (no per-row sockets). SSR provides the initial page.
  fastify.get("/api/batches/socket", { websocket: true }, async (socket) => {
    const channel = BATCHES_LIST_CHANNEL;

    let clients = channelClients.get(channel);
    if (!clients) {
      clients = new Set();
      channelClients.set(channel, clients);
    }
    clients.add(socket);
    await ensureSubscribed(channel).catch(() => {});

    socket.on("message", (raw) => {
      try {
        const msg = ClientToServerMessageSchema.safeParse(JSON.parse(String(raw)));
        if (msg.success && msg.data.type === "ping") {
          send(socket, { type: "pong" });
        }
      } catch {
        /* ignore malformed frames */
      }
    });

    socket.on("close", () => {
      clients.delete(socket as WebSocket);
      void unsubscribeIfEmpty(channel);
    });
  });

  fastify.get<{ Params: { id: string } }>(
    "/api/batches/:id/socket",
    { websocket: true },
    async (socket, req) => {
      const batchId = req.params.id;
      const channel = batchChannel(batchId);

      // Validate before holding a slot: 404 close instead of a hanging socket.
      const detail = await getBatchDetail(batchId);
      if (!detail) {
        socket.close(4404, "Batch not found");
        return;
      }

      let clients = channelClients.get(channel);
      if (!clients) {
        clients = new Set();
        channelClients.set(channel, clients);
      }
      clients.add(socket);
      await ensureSubscribed(channel).catch(() => {});

      // Snapshot-first: every (re)connect pays the full truth, then incremental events.
      send(socket, { type: "snapshot", batchId, batch: detail });

      socket.on("message", (raw) => {
        try {
          const msg = ClientToServerMessageSchema.safeParse(JSON.parse(String(raw)));
          if (msg.success && msg.data.type === "ping") {
            send(socket, { type: "pong" });
          }
        } catch {
          /* ignore malformed frames */
        }
      });

      socket.on("close", () => {
        clients.delete(socket as WebSocket);
        void unsubscribeIfEmpty(channel);
      });
    },
  );
}