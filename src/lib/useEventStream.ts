"use client";

import { useEffect, useRef, useState } from "react";
import type { GeoEvent } from "@/lib/types";

export type ConnectionState = "connecting" | "live" | "disconnected";

const INITIAL_RECONNECT_MS = 1000;
const MAX_RECONNECT_MS = 15_000;

// This app is explicitly designed to be left open for extended live
// monitoring (see api/stream/route.ts's background-ingest trigger) — with
// no cap, `events` and `seenIds` below grow for as long as the tab stays
// open, degrading render cost over a long session and making the feed-count
// badge (Dashboard.tsx's `props.events.length`) climb forever instead of
// reflecting a recent window. Bounded well above the server's own 100-item
// initial backfill so normal scrollback never feels truncated.
const MAX_BUFFERED_EVENTS = 500;

export function useEventStream() {
  const [events, setEvents] = useState<GeoEvent[]>([]);
  const [status, setStatus] = useState<ConnectionState>("connecting");
  const [incoming, setIncoming] = useState<GeoEvent[]>([]);
  const seenIds = useRef<Set<number>>(new Set());
  const lastIdRef = useRef(0);

  useEffect(() => {
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectDelay = INITIAL_RECONNECT_MS;
    let cancelled = false;

    // The server (api/stream/route.ts) closes each connection cleanly
    // after ~45s to stay under serverless duration limits rather than
    // risking an abrupt platform kill. We take ownership of reconnecting
    // here (instead of relying on the browser's built-in EventSource
    // retry) so we can resume from the last event id — no re-backfill
    // flicker — and back off if a reconnect attempt itself keeps failing.
    function connect() {
      if (cancelled) return;
      setStatus((prev) => (prev === "live" ? prev : "connecting"));

      const url = lastIdRef.current
        ? `/api/stream?since=${lastIdRef.current}`
        : "/api/stream";
      const es = new EventSource(url);
      source = es;

      es.addEventListener("backfill", (e) => {
        const rows = JSON.parse((e as MessageEvent).data) as GeoEvent[];
        for (const r of rows) seenIds.current.add(r.id);
        if (rows.length > 0) {
          lastIdRef.current = Math.max(
            lastIdRef.current,
            rows[rows.length - 1].id,
          );
        }
        setEvents(rows);
        setStatus("live");
        reconnectDelay = INITIAL_RECONNECT_MS;
      });

      es.addEventListener("event", (e) => {
        const row = JSON.parse((e as MessageEvent).data) as GeoEvent;
        lastIdRef.current = Math.max(lastIdRef.current, row.id);
        setStatus("live");
        reconnectDelay = INITIAL_RECONNECT_MS;
        if (seenIds.current.has(row.id)) return;
        seenIds.current.add(row.id);
        setEvents((prev) => {
          const next = [...prev, row];
          if (next.length <= MAX_BUFFERED_EVENTS) return next;
          const trimmed = next.slice(next.length - MAX_BUFFERED_EVENTS);
          // seenIds must track exactly what's still buffered — otherwise a
          // dropped-off-the-front event's id stays "seen" forever, so if it
          // were ever re-sent (e.g. a future backfill window) it would be
          // silently ignored instead of being added back.
          seenIds.current = new Set(trimmed.map((e) => e.id));
          return trimmed;
        });
        setIncoming((prev) => [...prev, row]);
      });

      es.addEventListener("ping", (e) => {
        setStatus("live");
        reconnectDelay = INITIAL_RECONNECT_MS;
        try {
          const data = JSON.parse((e as MessageEvent).data) as {
            lastId?: number;
          };
          if (typeof data.lastId === "number") {
            lastIdRef.current = Math.max(lastIdRef.current, data.lastId);
          }
        } catch {
          // Malformed ping payload — harmless, the connection is still live.
        }
      });

      es.onopen = () => {
        setStatus("live");
        reconnectDelay = INITIAL_RECONNECT_MS;
      };

      // Fires for both a real network error and the server's routine
      // self-close — either way, close out this connection and reopen
      // from lastIdRef with capped exponential backoff.
      es.onerror = () => {
        es.close();
        if (source === es) source = null;
        if (cancelled) return;
        setStatus("disconnected");
        reconnectTimer = setTimeout(() => {
          reconnectDelay = Math.min(reconnectDelay * 1.5, MAX_RECONNECT_MS);
          connect();
        }, reconnectDelay);
      };
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      source?.close();
    };
  }, []);

  const dismissIncoming = (id: number) => {
    setIncoming((prev) => prev.filter((e) => e.id !== id));
  };

  return { events, status, incoming, dismissIncoming };
}
