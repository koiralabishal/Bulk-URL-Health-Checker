"use client";

import { useEffect, useRef, useState } from "react";
import { ServerToClientMessageSchema, type BatchDetail } from "@urlchecker/shared";
import { countUrlRows } from "@/lib/format";

const PING_INTERVAL_MS = 20_000;
const PONG_TIMEOUT_MS = 8_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;

function wsUrlFor(batchId: string): string {
  const base = process.env.NEXT_PUBLIC_WS_URL ?? `ws://${typeof window !== "undefined" ? window.location.hostname : "localhost"}:3001`;
  return `${base.replace(/\/$/, "")}/api/batches/${batchId}/socket`;
}

export function useBatchSocket(batchId: string, initial: BatchDetail) {
  const [batch, setBatch] = useState<BatchDetail>(initial);
  const [connected, setConnected] = useState(false);
  const reconnectAttempt = useRef(0);
  const closedRef = useRef(false);

  // router.refresh() re-renders the server component with a fresh snapshot;
  // adopt it so HTTP re-reads (e.g. after re-analyze) show immediately.
  useEffect(() => {
    setBatch(initial);
  }, [initial]);

  useEffect(() => {
    closedRef.current = false;
    reconnectAttempt.current = 0;

    const url = wsUrlFor(batchId);
    let socket: WebSocket | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let pongTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const clearTimers = () => {
      if (pingTimer) clearInterval(pingTimer);
      if (pongTimer) clearTimeout(pongTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      pingTimer = null;
      pongTimer = null;
      reconnectTimer = null;
    };

    const connect = () => {
      if (closedRef.current) return;
      clearTimers();

      const ws = new WebSocket(url);
      socket = ws;

      ws.onopen = () => {
        setConnected(true);
        reconnectAttempt.current = 0;
        pingTimer = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          ws.send(JSON.stringify({ type: "ping" }));
          pongTimer = setTimeout(() => {
            // No pong within the window → assume dead link and force reconnect.
            ws.close();
          }, PONG_TIMEOUT_MS);
        }, PING_INTERVAL_MS);
      };

      ws.onmessage = (event) => {
        let parsed;
        try {
          parsed = ServerToClientMessageSchema.parse(JSON.parse(String(event.data)));
        } catch {
          return;
        }
        if (parsed.type === "snapshot") {
          setBatch(parsed.batch);
        } else if (parsed.type === "batch_updated") {
          setBatch((prev) => ({
            ...prev,
            status: parsed.batch.status,
            counts: parsed.batch.counts,
            updatedAt: parsed.batch.updatedAt,
          }));
        } else if (parsed.type === "url_updated") {
          setBatch((prev) => {
            const urls = prev.urls.map((u) => (u.id === parsed.url.id ? parsed.url : u));
            return { ...prev, urls, counts: countUrlRows(urls) };
          });
        }
        // "pong" is a silent heartbeat ack; nothing to render.
      };

      ws.onclose = () => {
        setConnected(false);
        clearTimers();
        if (closedRef.current) return;
        const attempts = reconnectAttempt.current;
        const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempts, RECONNECT_MAX_MS);
        reconnectAttempt.current += 1;
        reconnectTimer = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    connect();

    return () => {
      closedRef.current = true;
      clearTimers();
      socket?.close();
    };
  }, [batchId]);

  return { batch, connected };
}