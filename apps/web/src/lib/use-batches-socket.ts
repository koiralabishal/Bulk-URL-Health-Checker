"use client";

import { ServerToClientMessageSchema, type BatchesPage } from "@urlchecker/shared";
import { useEffect, useRef, useState } from "react";

const PING_INTERVAL_MS = 20_000;
const PONG_TIMEOUT_MS = 8_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;

function wsUrlFor(): string {
  const base =
    process.env.NEXT_PUBLIC_WS_URL ??
    `ws://${typeof window !== "undefined" ? window.location.hostname : "localhost"}:3001`;
  return `${base.replace(/\/$/, "")}/api/batches/socket`;
}

/**
 * Streams `batch_updated` events for any batch on the current history page so
 * status pills, progress bars and result counts update without a reload.
 */
export function useBatchesSocket(initial: BatchesPage) {
  const [page, setPage] = useState<BatchesPage>(initial);
  const [connected, setConnected] = useState(false);
  const reconnectAttempt = useRef(0);
  const closedRef = useRef(false);

  // Adopt server refetches (e.g. after Re-analyze / pagination).
  useEffect(() => {
    setPage(initial);
  }, [initial]);

  useEffect(() => {
    closedRef.current = false;
    reconnectAttempt.current = 0;

    const url = wsUrlFor();
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
        if (parsed.type === "batch_updated") {
          setPage((prev) => {
            const index = prev.items.findIndex((item) => item.id === parsed.batchId);
            if (index === -1) return prev; // not on this page
            const items = [...prev.items];
            items[index] = parsed.batch;
            return { ...prev, items };
          });
        }
        // "pong" is a silent heartbeat ack; other types are for detail sockets.
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
  }, []);

  return { page, connected };
}
