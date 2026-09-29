"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CountryRiskScore } from "@/lib/useCountryRisk";
import type { AnomalyFindingResponse } from "@/lib/useAnomalies";
import { signalDescription } from "@/lib/anomalyLabels";
import { THREAT_COLORS, THREAT_LABELS, momentumArrow, momentumBucketLabel } from "@/lib/threat";
import { countryName } from "@/lib/format";
import { summarizeHistory, withLivePoint, type HistorySnapshot } from "@/lib/historySummary";

interface TrendsPanelProps {
  countryScores: CountryRiskScore[];
  anomalies: Map<string, AnomalyFindingResponse[]>;
  // Shared with the globe and the other tabs (2026-09-28): picking a
  // country here selects it everywhere, and a country picked on the globe
  // opens its history here instead of an empty search box.
  selectedCountry: string | null;
  onSelectCountry: (country: string | null) => void;
}

// /api/history also returns a snapshot-only summary; the panel builds its
// own with the live score as the newest point (historySummary.ts).
interface HistoryResponse {
  history: HistorySnapshot[];
  earlierMethodDays?: number;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

const CHART_HEIGHT = 90;
const MOVERS_SHOWN = 8;

function HistoryChart({ history }: { history: HistorySnapshot[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Newest on the right, in view: a long history overflows to the left.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [history.length]);

  if (history.length === 0) return null;
  const maxScore = Math.max(...history.map((h) => h.score), 5);
  const first = history[0];
  const last = history[history.length - 1];
  const label = (h: HistorySnapshot) => (h.live ? "Live now" : formatDate(h.snapshotAt));

  return (
    <div>
      <div ref={scrollRef} className="flex h-[90px] items-end gap-[3px] overflow-x-auto rounded border border-neutral-800 bg-black/40 p-2">
        {history.map((h) => {
          const barHeight = Math.max(4, (h.score / maxScore) * CHART_HEIGHT);
          return (
            <div
              key={h.snapshotAt}
              className={`w-3 shrink-0 rounded-t-sm${h.live ? " ring-1 ring-white/80" : ""}`}
              style={{ height: `${barHeight}px`, backgroundColor: THREAT_COLORS[h.threatLevel] }}
              title={`${label(h)} - score ${h.score.toFixed(1)} (${THREAT_LABELS[h.threatLevel]})`}
            />
          );
        })}
      </div>
      <div className="mt-1 flex justify-between font-mono text-[9px] text-neutral-500">
        <span className={first.live ? "text-red-300" : undefined}>{label(first)}</span>
        {history.length > 1 && <span className={last.live ? "text-red-300" : undefined}>{label(last)}</span>}
      </div>
    </div>
  );
}

function MoverRow({ score, onSelect }: { score: CountryRiskScore; onSelect: () => void }) {
  const color =
    score.momentumDirection > 0 ? "text-red-400" : score.momentumDirection < 0 ? "text-emerald-500" : "text-neutral-500";
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left font-mono text-xs text-neutral-300 hover:bg-red-950/30"
    >
      <span className="truncate">{countryName(score.country)}</span>
      <span className="flex shrink-0 items-center gap-2">
        <span className={`text-[10px] ${color}`} title={momentumBucketLabel(score.momentum)}>
          {momentumArrow(score.momentumDirection)} {score.momentum}
        </span>
        <span
          className="rounded-sm px-1 py-0.5 text-[9px] font-bold uppercase text-black"
          style={{ backgroundColor: THREAT_COLORS[score.threatLevel] }}
        >
          {score.threatLabel}
        </span>
      </span>
    </button>
  );
}

export default function TrendsPanel({
  countryScores,
  anomalies,
  selectedCountry,
  onSelectCountry,
}: TrendsPanelProps) {
  const [query, setQuery] = useState("");
  const [data, setData] = useState<(HistoryResponse & { country: string }) | null>(null);
  const [failedCountry, setFailedCountry] = useState<string | null>(null);
  // Only its UTC day matters: the live point stands in for that day's snapshot.
  const [openedAt] = useState(() => new Date().toISOString());

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return countryScores
      .filter(
        (s) =>
          s.country.toLowerCase() === q ||
          countryName(s.country).toLowerCase().includes(q),
      )
      .slice(0, 20);
  }, [query, countryScores]);

  // Momentum is already computed per country; ranking it here needs no
  // extra request. Rising first, then the countries easing the most.
  const movers = useMemo(() => {
    const rising = countryScores
      .filter((s) => s.momentumDirection > 0)
      .sort((a, b) => b.momentum - a.momentum)
      .slice(0, MOVERS_SHOWN);
    const easing = countryScores
      .filter((s) => s.momentumDirection < 0)
      .sort((a, b) => b.momentum - a.momentum)
      .slice(0, MOVERS_SHOWN / 2);
    return { rising, easing };
  }, [countryScores]);

  useEffect(() => {
    if (!selectedCountry) return;
    let cancelled = false;
    fetch(`/api/history?country=${selectedCountry}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<HistoryResponse>;
      })
      .then((json) => {
        if (cancelled) return;
        setData({ ...json, country: selectedCountry });
        setFailedCountry(null);
      })
      .catch(() => {
        if (!cancelled) setFailedCountry(selectedCountry);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedCountry]);

  const current = selectedCountry && data?.country === selectedCountry ? data : null;

  // The chart's last bar is the live score (2026-09-29), from the same
  // /api/risk/summary poll that colors the globe. A country missing from a
  // loaded summary has no scored events, so it is live at 0.
  const series = useMemo(() => {
    if (!current || !selectedCountry) return [];
    const liveScore = countryScores.find((s) => s.country === selectedCountry);
    const live: HistorySnapshot | null =
      countryScores.length === 0
        ? null
        : {
            snapshotAt: openedAt,
            score: liveScore?.score ?? 0,
            threatLevel: liveScore?.threatLevel ?? 1,
            momentum: liveScore?.momentum ?? 0,
          };
    return withLivePoint(current.history, live);
  }, [current, selectedCountry, countryScores, openedAt]);
  const summary = current && selectedCountry ? summarizeHistory(selectedCountry, series) : null;
  const loading = !!selectedCountry && !current && failedCountry !== selectedCountry;
  const countryAnomalies = selectedCountry ? (anomalies.get(selectedCountry) ?? []) : [];

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto p-3">
        <h2 className="mb-1 font-mono text-xs uppercase tracking-[0.2em] text-red-500">
          Trends
        </h2>
        <p className="mb-3 text-[11px] leading-snug text-neutral-500">
          A country&apos;s Pulse history, one snapshot a day, ending with the
          live score. Pick a country on the globe or search for one.
        </p>

        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search a country…"
          aria-label="Search a country"
          className="mb-2 w-full rounded border border-neutral-800 bg-black/60 px-3 py-2 font-mono text-xs text-red-300 placeholder:text-neutral-500 focus:border-red-700 focus:outline-none"
        />

        {query && (
          <div className="mb-3 max-h-48 overflow-y-auto rounded border border-neutral-800">
            {results.length === 0 && (
              <p className="p-2 font-mono text-[11px] text-neutral-500">
                No matches among scored countries.
              </p>
            )}
            {results.map((s) => (
              <MoverRow
                key={s.country}
                score={s}
                onSelect={() => {
                  onSelectCountry(s.country);
                  setQuery("");
                }}
              />
            ))}
          </div>
        )}

        {selectedCountry && (
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="font-mono text-sm text-red-300">
                {countryName(selectedCountry)}
              </span>
              <button
                type="button"
                onClick={() => onSelectCountry(null)}
                className="font-mono text-[10px] text-neutral-500 hover:text-red-400"
              >
                ✕ clear
              </button>
            </div>

            {loading && (
              <p className="font-mono text-[11px] text-neutral-500">
                Loading history…
              </p>
            )}
            {failedCountry === selectedCountry && !current && (
              <p role="status" className="font-mono text-[11px] text-amber-500">
                History could not be loaded. Try again shortly.
              </p>
            )}

            {current && (
              <>
                <HistoryChart history={series} />
                <p className="mt-3 whitespace-pre-wrap text-xs leading-relaxed text-neutral-300">
                  {summary?.text}
                </p>
                {!!current.earlierMethodDays && (
                  <p className="mt-2 text-[11px] leading-snug text-neutral-500">
                    {current.earlierMethodDays} earlier day{current.earlierMethodDays === 1 ? " was" : "s were"} scored
                    under a previous method and {current.earlierMethodDays === 1 ? "is" : "are"} left
                    out: those scores are on a different scale and would make the trend misleading.
                  </p>
                )}
                {countryAnomalies.length > 0 && (
                  <div className="mt-3 rounded border border-amber-900/60 bg-amber-950/10 p-2">
                    <span className="font-mono text-[9px] uppercase tracking-wider text-amber-500">
                      ⚠ Recent anomalies
                    </span>
                    {countryAnomalies.map((f) => (
                      <p
                        key={`${f.signalType}:${f.category ?? ""}`}
                        className="mt-1 font-mono text-[10px] leading-relaxed text-neutral-400"
                      >
                        {signalDescription(f)}.
                      </p>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {!selectedCountry && !query && (
          <div className="space-y-3">
            {movers.rising.length > 0 && (
              <section>
                <h3 className="mb-1 font-mono text-[10px] uppercase tracking-wider text-neutral-400">
                  Rising fastest
                </h3>
                <div className="rounded border border-neutral-800">
                  {movers.rising.map((s) => (
                    <MoverRow key={s.country} score={s} onSelect={() => onSelectCountry(s.country)} />
                  ))}
                </div>
              </section>
            )}
            {movers.easing.length > 0 && (
              <section>
                <h3 className="mb-1 font-mono text-[10px] uppercase tracking-wider text-neutral-400">
                  Easing fastest
                </h3>
                <div className="rounded border border-neutral-800">
                  {movers.easing.map((s) => (
                    <MoverRow key={s.country} score={s} onSelect={() => onSelectCountry(s.country)} />
                  ))}
                </div>
              </section>
            )}
            <p className="text-[10px] leading-snug text-neutral-500">
              Momentum (0-100) compares the last 24 hours and 7 days of activity
              with the periods just before them, for the pillar driving each
              country&apos;s level. It describes change, not the level itself.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
