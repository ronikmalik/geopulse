"use client";

import { useEffect } from "react";
import type { GeoEvent } from "@/lib/types";
import { CATEGORY_LABELS, type Category } from "@/lib/categories";

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

export default function AlertToast({
  event,
  onDismiss,
  onFocus,
  index = 0,
}: AlertToastProps) {
  const delayMs = index * STAGGER_MS;

  useEffect(() => {
    const t = setTimeout(onDismiss, 8000 + delayMs);
    return () => clearTimeout(t);
  }, [onDismiss, delayMs]);

  return (
    <button
      onClick={onFocus}
      style={{ animationDelay: `${delayMs}ms`, animationFillMode: "backwards" }}
      className="pointer-events-auto w-full animate-[alertIn_0.25s_ease-out] rounded border border-red-600/70 bg-black/90 p-3 text-left shadow-[0_0_18px_rgba(255,0,0,0.35)] backdrop-blur-sm transition hover:border-red-400 sm:w-80"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-widest text-red-500">
          {CATEGORY_LABELS[event.category as Category] ?? event.category}
        </span>
        <span className="font-mono text-[10px] text-red-700">
          SEV {event.severity}
        </span>
      </div>
      <div className="mt-1 font-mono text-xs text-red-300">
        {event.location}
      </div>
      <div className="mt-1 text-sm leading-snug text-neutral-200">
        {event.summary}
      </div>
    </button>
  );
}
