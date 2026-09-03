"use client";

import type { GeoEvent } from "@/lib/types";
import { CATEGORY_LABELS, type Category } from "@/lib/categories";

interface FeedPanelProps {
  events: GeoEvent[];
  loading?: boolean;
  selectedId: number | null;
  onSelect: (event: GeoEvent) => void;
}

function timeAgo(iso: string | Date): string {
  const date = typeof iso === "string" ? new Date(iso) : iso;
  const diffMs = Date.now() - date.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function FeedPanel({
  events,
  loading,
  selectedId,
  onSelect,
}: FeedPanelProps) {
  const sorted = [...events].sort(
    (a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(),
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto">
        {loading && (
          <p className="p-4 font-mono text-xs text-neutral-600">
            Loading feed…
          </p>
        )}
        {!loading && sorted.length === 0 && (
          <p className="p-4 font-mono text-xs text-neutral-600">
            Listening for signals…
          </p>
        )}
        {sorted.map((event) => (
          <button
            key={event.id}
            onClick={() => onSelect(event)}
            className={`block w-full border-b border-red-950 px-4 py-3 text-left transition hover:bg-red-950/30 ${
              selectedId === event.id ? "bg-red-950/40" : ""
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[10px] uppercase tracking-wider text-red-500">
                {CATEGORY_LABELS[event.category as Category] ??
                  event.category}
              </span>
              <span className="font-mono text-[10px] text-neutral-600">
                {timeAgo(event.publishedAt)}
              </span>
            </div>
            <div className="mt-1 font-mono text-xs text-red-300">
              {event.location}
            </div>
            <p className="mt-1 line-clamp-2 text-sm text-neutral-300">
              {event.summary}
            </p>
            <div className="mt-1.5 flex gap-0.5">
              {Array.from({ length: 5 }).map((_, i) => (
                <span
                  key={i}
                  className={`h-1 w-3 rounded-sm ${
                    i < event.severity ? "bg-red-600" : "bg-red-950"
                  }`}
                />
              ))}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
