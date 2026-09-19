"use client";

import { useEffect, useRef, useState } from "react";
import type { GeoEvent } from "@/lib/types";

export type ConnectionState = "connecting" | "live" | "disconnected";

// Polling client for GET /api/events/feed (2026-09-19) — replaces the old
// EventSource client for /api/stream. Same hook contract (`events`,
// `status`, `incoming`, `dismissIncoming`) so nothing above this file
// changed; see the route's own header comment for why SSE-on-serverless
// was the wrong shape for this app's compute budget.
//
// Cadence: POLL_INTERVAL_MS while the tab is visible, HIDDEN_POLL_INTERVAL_MS
// once it's backgrounded (the browser throttles timers there anyway, and
// nobody is looking — this is where an "always open" monitoring tab used
// to quietly burn the most). Switching back to the tab polls immediately.
// Every RECONCILE_EVERY_N_POLLS-th poll re-fetches the whole recent window
// instead of a delta: that is how later approvals, country/severity
// corrections and kill-switch removals reach an open tab, since an
// insertion-id cursor can't represent any of those.
const POLL_INTERVAL_MS = 12_000;
const HIDDEN_POLL_INTERVAL_MS = 60_000;
const RECONCILE_EVERY_N_POLLS = 10;
const INITIAL_RETRY_MS = 3_000;
const MAX_RETRY_MS = 60_000;

// This app is explicitly designed to be left open for extended live
// monitoring — with no cap, `events` grows for as long as the tab stays
// open, degrading render cost over a long session and making the feed-
// count badge (Dashboard.tsx's `props.events.length`) climb forever
// instead of reflecting a recent window. Bounded well above the server's
// own 100-item initial window so normal scrollback never feels truncated.
const MAX_BUFFERED_EVENTS = 500;
const MAX_INCOMING_EVENTS = 20;

interface FeedResponse {
  events: GeoEvent[];
  cursor: number;
  reconcile: boolean;
}

function trimBuffer(next: GeoEvent[]): GeoEvent[] {
  return next.length <= MAX_BUFFERED_EVENTS ? next : next.slice(next.length - MAX_BUFFERED_EVENTS);
}

export function useEventStream() {
  const [events, setEvents] = useState<GeoEvent[]>([]);
  const [status, setStatus] = useState<ConnectionState>("connecting");
  const [incoming, setIncoming] = useState<GeoEvent[]>([]);
  const cursorRef = useRef(0);
  const pollCountRef = useRef(0);
  const knownIds = useRef<Set<number>>(new Set());

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    let retryDelay = INITIAL_RETRY_MS;
    let hasLoaded = false;

    function schedule(ms: number) {
      if (cancelled) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(poll, ms);
    }

    function nextInterval(): number {
      return typeof document !== "undefined" && document.visibilityState === "hidden"
        ? HIDDEN_POLL_INTERVAL_MS
        : POLL_INTERVAL_MS;
    }

    // Full-window reconcile: the server's recent window replaces whatever
    // the client holds for that id range (so removed/killed rows vanish and
    // corrected rows update in place), while anything OLDER than the window
    // is kept as scrollback. Rows that are new to the client still surface
    // as toasts, same as a delta would. `fresh` is computed from knownIds
    // (a ref mirror of what's buffered) BEFORE the state updates, never
    // inside a setState updater — an updater has to be pure (React may
    // re-run it), and setIncoming from inside one would double-toast.
    function applyReconcile(window: GeoEvent[]) {
      if (window.length === 0) return;
      const windowStart = window[0].id;
      const fresh = window.filter((e) => !knownIds.current.has(e.id));
      setEvents((prev) => {
        const older = prev.filter((e) => e.id < windowStart);
        const next = trimBuffer([...older, ...window]);
        knownIds.current = new Set(next.map((e) => e.id));
        return next;
      });
      if (fresh.length > 0 && hasLoaded) {
        setIncoming((cur) => [...cur, ...fresh].slice(-MAX_INCOMING_EVENTS));
      }
    }

    function applyDelta(rows: GeoEvent[]) {
      const fresh = rows.filter((e) => !knownIds.current.has(e.id));
      if (fresh.length === 0) return;
      for (const e of fresh) knownIds.current.add(e.id);
      setEvents((prev) => {
        const next = trimBuffer([...prev, ...fresh]);
        if (next.length < prev.length + fresh.length) {
          knownIds.current = new Set(next.map((e) => e.id));
        }
        return next;
      });
      setIncoming((cur) => [...cur, ...fresh].slice(-MAX_INCOMING_EVENTS));
    }

    async function poll() {
      if (cancelled || inFlight) return;
      inFlight = true;
      const wantReconcile = !hasLoaded || pollCountRef.current % RECONCILE_EVERY_N_POLLS === 0;
      pollCountRef.current += 1;
      const url = wantReconcile ? "/api/events/feed" : `/api/events/feed?since=${cursorRef.current}`;
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as FeedResponse;
        if (cancelled) return;
        if (data.reconcile) applyReconcile(data.events);
        else applyDelta(data.events);
        // The cursor only ever moves forward: a reconcile's cursor is the
        // window's newest id, which a delta may already have passed.
        cursorRef.current = Math.max(cursorRef.current, data.cursor);
        hasLoaded = true;
        retryDelay = INITIAL_RETRY_MS;
        setStatus("live");
        schedule(nextInterval());
      } catch {
        if (cancelled) return;
        setStatus("disconnected");
        schedule(retryDelay);
        retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
      } finally {
        inFlight = false;
      }
    }

    function onVisibilityChange() {
      // Coming back to the tab: poll now rather than waiting out a 60s
      // hidden-cadence timer. Going hidden: let the current timer run out,
      // the next schedule() picks the slower cadence on its own.
      if (document.visibilityState === "visible") schedule(0);
    }

    document.addEventListener("visibilitychange", onVisibilityChange);
    poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  const dismissIncoming = (id: number) => {
    setIncoming((prev) => prev.filter((e) => e.id !== id));
  };

  return { events, status, incoming, dismissIncoming };
}
