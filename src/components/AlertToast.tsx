"use client";

import { useEffect, useRef } from "react";
import type { GeoEvent } from "@/lib/types";
import { CATEGORY_LABELS, type Category } from "@/lib/categories";
import { eventPlace, splitAttribution, stripOutletSuffix } from "@/lib/displayText";

interface AlertToastProps {
  event: GeoEvent;
  onDismiss: () => void;
  onFocus: () => void;
  // Position within the currently-visible toast stack. When ingest lands a
  // batch of events in one poll tick, they all mount in the same render —
  // without a stagger they visibly flash in as one clump ("four things pop
  // up at once"). This offsets each toast's entrance (and dismiss timer by
  // the same amount) so a batch reads as a quick sequence instead.
  index?: number;
}

const STAGGER_MS = 180;
const VISIBLE_MS = 8000;

export default function AlertToast({
  event,
  onDismiss,
  onFocus,
  index = 0,
}: AlertToastProps) {
  const delayMs = index * STAGGER_MS;

  // The parent passes a fresh onDismiss closure on every render, and it
  // re-renders on every feed poll and layer refresh. With onDismiss as an
  // effect dependency each of those restarted the timer (2026-09-28), so
  // a toast's lifetime depended on unrelated polling. Read it from a ref.
  const onDismissRef = useRef(onDismiss);
  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    const t = setTimeout(() => onDismissRef.current(), VISIBLE_MS + delayMs);
    return () => clearTimeout(t);
  }, [delayMs]);

  const { body } = splitAttribution(event.summary, event.source);

  return (
    <div
      style={{ animationDelay: `${delayMs}ms`, animationFillMode: "backwards" }}
      className="pointer-events-auto relative w-full animate-[alertIn_0.25s_ease-out] rounded border border-red-600/70 bg-black/90 shadow-[0_0_18px_rgba(255,0,0,0.35)] backdrop-blur-sm transition hover:border-red-400 sm:w-80"
    >
      <button
        type="button"
        onClick={onFocus}
        className="block w-full p-3 text-left focus-visible:outline-2 focus-visible:outline-red-400"
      >
        <div className="flex items-center justify-between gap-2 pr-6">
          <span className="font-mono text-[10px] uppercase tracking-widest text-red-500">
            {CATEGORY_LABELS[event.category as Category] ?? event.category}
          </span>
          <span className="font-mono text-[10px] text-red-400/80">
            SEV {event.severity}
          </span>
        </div>
        <div className="mt-1 font-mono text-xs text-red-300">
          {eventPlace(event)}
        </div>
        <div className="mt-1 line-clamp-3 text-sm leading-snug text-neutral-200">
          {stripOutletSuffix(body)}
        </div>
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss alert"
        className="absolute right-1 top-1 rounded px-1.5 py-0.5 font-mono text-xs text-neutral-500 hover:text-red-300 focus-visible:outline-2 focus-visible:outline-red-400"
      >
        ✕
      </button>
    </div>
  );
}
