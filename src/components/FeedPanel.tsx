"use client";

import { useEffect, useState } from "react";
import type { GeoEvent } from "@/lib/types";
import { CATEGORY_LABELS, type Category } from "@/lib/categories";
import { sourceLabel } from "@/lib/sourceLabels";

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

interface DuplicateSource {
  id: number;
  source: string;
  url: string;
  publishedAt: string;
}

// Fetched on demand only when a clustered card (sourceCount > 0) is
// expanded — see src/lib/eventDedup.ts for how these get attached to a
// primary event at ingest time, and GET /api/events/duplicates for the
// endpoint this reads.
function AdditionalSources({ eventId }: { eventId: number }) {
  const [sources, setSources] = useState<DuplicateSource[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/events/duplicates?id=${eventId}`)
      .then((res) => res.json())
      .then((data: { sources: DuplicateSource[] }) => {
        if (!cancelled) setSources(data.sources ?? []);
      })
      .catch(() => {
        if (!cancelled) setSources([]);
      });
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  if (!sources) {
    return (
      <p className="mt-1.5 font-mono text-[10px] text-neutral-600">
        loading other sources…
      </p>
    );
  }
  if (sources.length === 0) return null;

  return (
    <div className="mt-1.5">
      <p className="font-mono text-[10px] uppercase tracking-wider text-neutral-500">
        Also reported by:
      </p>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
        {sources.map((s) => (
          <a
            key={s.id}
            href={s.url}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="font-mono text-[10px] text-neutral-400 underline decoration-neutral-700 hover:text-red-400"
          >
            {sourceLabel(s.source)}
          </a>
        ))}
      </div>
    </div>
  );
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
        {sorted.map((event) => {
          const isSelected = selectedId === event.id;
          const sourceCount = event.sourceCount ?? 0;
          return (
          <button
            key={event.id}
            onClick={() => onSelect(event)}
            className={`block w-full border-b border-red-950 px-4 py-3 text-left transition hover:bg-red-950/30 ${
              isSelected ? "bg-red-950/40" : ""
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
            <div className="mt-1 flex items-center gap-1.5">
              <span className="font-mono text-xs text-red-300">
                {event.location}
              </span>
              {sourceCount > 0 && (
                <span
                  className="rounded-full border border-neutral-700 px-1.5 py-0 font-mono text-[9px] text-neutral-500"
                  title={`Reported by ${sourceCount + 1} sources`}
                >
                  +{sourceCount}
                </span>
              )}
            </div>
            <p className={`mt-1 text-sm text-neutral-300 ${isSelected ? "" : "line-clamp-2"}`}>
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
            {isSelected && (
              <div className="mt-2 border-t border-red-950/70 pt-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[10px] uppercase tracking-wider text-neutral-500">
                    Source: <span className="text-neutral-300">{sourceLabel(event.source)}</span>
                  </span>
                  <a
                    href={event.url}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="font-mono text-[10px] uppercase tracking-wider text-red-500 hover:text-red-400"
                  >
                    View original →
                  </a>
                </div>
                {sourceCount > 0 && <AdditionalSources eventId={event.id} />}
              </div>
            )}
          </button>
          );
        })}
      </div>
    </div>
  );
}
