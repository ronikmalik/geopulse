"use client";

import { useEffect, useRef, useState } from "react";
import type { GeoEvent } from "@/lib/types";
import { CATEGORY_LABELS, type Category } from "@/lib/categories";
import { sourceLabel } from "@/lib/sourceLabels";
import { eventPlace, splitAttribution, splitTsunamiStatus, stripOutletSuffix, type TsunamiStatus } from "@/lib/displayText";
import { timeAgo } from "@/lib/format";

interface FeedPanelProps {
  events: GeoEvent[];
  loading?: boolean;
  selectedId: number | null;
  onSelect: (event: GeoEvent) => void;
  // Shown when there is nothing to list. The default suits the live feed;
  // a country or category view passes its own, since "listening" there
  // would suggest data is on its way when the answer is simply "none".
  emptyMessage?: string;
}

const TSUNAMI_TONE: Record<TsunamiStatus["tone"], string> = {
  calm: "border-emerald-900/70 text-emerald-400",
  info: "border-neutral-700 text-neutral-300",
  caution: "border-amber-800 text-amber-400",
  alert: "border-red-700 text-red-300",
};

// Rows the local gate model published during a Gemini outage carry this
// reviewModel prefix (gateStudent.ts GATE_STUDENT_MODEL_ID) until the
// gate re-checks them.
const LOCAL_MODEL_PREFIX = "gate-student:";

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
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
    fetchJson<{ sources: DuplicateSource[] }>(`/api/events/duplicates?id=${eventId}`)
      .then((data) => {
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
      <p className="mt-1.5 font-mono text-[10px] text-neutral-500">
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

interface SimilarEvent {
  id: number;
  source: string;
  url: string;
  title: string;
  publishedAt: string;
  similarity: number;
}

// Fetched on demand when a card is expanded, same lazy pattern as
// AdditionalSources above — but shown for every card, not just clustered
// ones (sourceCount > 0 is about same-story duplicates; this is
// semantically-related-but-distinct past events, a different signal). See
// src/lib/similarEvents.ts. Silently renders nothing if the embedding
// pipeline hasn't reached this event yet (freshly-inserted, or
// GEMINI_API_KEY not configured) — enrichment, not something to surface
// as broken or loading-forever.
function RelatedEvents({ eventId }: { eventId: number }) {
  const [items, setItems] = useState<SimilarEvent[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchJson<{ items: SimilarEvent[] }>(`/api/events/similar?id=${eventId}`)
      .then((data) => {
        if (!cancelled) setItems(data.items ?? []);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  if (!items || items.length === 0) return null;

  return (
    <div className="mt-1.5">
      <p className="font-mono text-[10px] uppercase tracking-wider text-neutral-500">
        Related:
      </p>
      <div className="mt-1 space-y-1">
        {items.map((item) => {
          // Telegram titles carry the channel label as a prefix; the
          // source is already printed first, so show the post alone.
          const title = stripOutletSuffix(splitAttribution(item.title, item.source).body);
          return (
            <a
              key={item.id}
              href={item.url}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="block truncate font-mono text-[10px] text-neutral-400 hover:text-red-400"
              title={`${title} (${timeAgo(item.publishedAt)})`}
            >
              {sourceLabel(item.source)} - {title}
            </a>
          );
        })}
      </div>
    </div>
  );
}

// The nearest major seaport, for events placed precisely enough to say
// (src/lib/ports.ts). The port table is loaded only when a card is opened.
function NearPort({ event }: { event: GeoEvent }) {
  const [near, setNear] = useState<{ name: string; country: string; size: "L" | "M"; km: number } | null>(null);
  useEffect(() => {
    let cancelled = false;
    import("@/lib/ports")
      .then(({ nearestMajorPort }) => {
        const hit = nearestMajorPort(event);
        if (!cancelled && hit) setNear({ ...hit.port, km: hit.km });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [event]);
  if (!near) return null;
  return (
    <p className="mt-1.5 font-mono text-[10px] text-neutral-400" title="NGA World Port Index">
      {Math.max(1, Math.round(near.km))} km from {near.name} ({near.size === "L" ? "large" : "medium"} seaport)
    </p>
  );
}

export default function FeedPanel({
  events,
  loading,
  selectedId,
  onSelect,
  emptyMessage = "Listening for signals…",
}: FeedPanelProps) {
  const sorted = [...events].sort(
    (a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(),
  );

  // Clicking a pulse on the globe selects its event (see page.tsx's
  // onSelect) and switches to this tab, but the matching card can easily
  // be scrolled off-screen in a long feed — highlighting it via isSelected
  // below did nothing visible if the user never scrolled to find it. This
  // brings the selected card into view whenever selectedId changes,
  // regardless of whether the selection came from a globe click, an alert
  // toast, or a direct card click.
  const selectedRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [selectedId]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto">
        {loading && (
          <p className="p-4 font-mono text-xs text-neutral-500">
            Loading feed…
          </p>
        )}
        {!loading && sorted.length === 0 && (
          <p className="p-4 font-mono text-xs text-neutral-500">
            {emptyMessage}
          </p>
        )}
        {sorted.map((event) => {
          const isSelected = selectedId === event.id;
          const sourceCount = event.sourceCount ?? 0;
          const attributed = splitAttribution(event.summary, event.source);
          const { body, tsunami } = splitTsunamiStatus(attributed.body);
          const byLocalModel = event.reviewModel?.startsWith(LOCAL_MODEL_PREFIX) ?? false;
          return (
          <article
            key={event.id}
            className={`border-b border-red-950 ${isSelected ? "bg-red-950/40" : ""}`}
          >
          <button
            type="button"
            ref={isSelected ? selectedRef : undefined}
            onClick={() => onSelect(event)}
            aria-expanded={isSelected}
            aria-controls={isSelected ? `event-details-${event.id}` : undefined}
            className="block w-full px-4 py-3 text-left transition hover:bg-red-950/30 focus-visible:outline-2 focus-visible:outline-red-400 focus-visible:outline-offset-[-2px]"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[10px] uppercase tracking-wider text-red-500">
                {CATEGORY_LABELS[event.category as Category] ??
                  event.category}
              </span>
              <span className="font-mono text-[10px] text-neutral-400">
                {timeAgo(event.publishedAt)}
              </span>
            </div>
            <div className="mt-1 flex items-center gap-1.5">
              <span className="font-mono text-xs text-red-300">
                {eventPlace(event)}
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
              {stripOutletSuffix(body)}
            </p>
            {tsunami && (
              <p className={`mt-1.5 inline-block rounded border px-1.5 py-0.5 font-mono text-[10px] ${TSUNAMI_TONE[tsunami.tone]}`}>
                NOAA {tsunami.center}: {tsunami.text}
              </p>
            )}
            <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-neutral-400">
              {sourceLabel(event.source)}
              {attributed.translatedFrom && (
                <span
                  className="rounded border border-amber-900/70 px-1 font-mono text-[9px] uppercase tracking-wider text-amber-500/90"
                  title="Machine-translated. The original post is linked below."
                >
                  Translated · {attributed.translatedFrom}
                </span>
              )}
              {byLocalModel && (
                <span
                  className="rounded border border-sky-900 px-1 font-mono text-[9px] uppercase tracking-wider text-sky-400"
                  title={event.reviewReasoning ?? "Published by the local gate model while Gemini was unavailable; Gemini re-checks it."}
                >
                  Local model review · re-check pending
                </span>
              )}
            </p>
            <div className="mt-1.5 flex gap-0.5" role="img" aria-label={`Event severity ${event.severity} of 5`}>
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
            {isSelected && (
              <div id={`event-details-${event.id}`} className="mx-4 mb-3 border-t border-red-950/70 pt-2">
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
                <NearPort event={event} />
                {sourceCount > 0 && <AdditionalSources eventId={event.id} />}
                <RelatedEvents eventId={event.id} />
              </div>
            )}
          </article>
          );
        })}
      </div>
    </div>
  );
}
