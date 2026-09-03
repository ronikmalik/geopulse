"use client";

import { useEffect, useMemo, useState } from "react";
import type { CountryRiskScore } from "@/lib/useCountryRisk";
import { THREAT_COLORS, type ThreatLevel } from "@/lib/threat";

interface TrendsPanelProps {
  countryScores: CountryRiskScore[];
}

// Mirrors HistorySnapshot/HistorySummary from src/lib/history.ts — defined
// locally rather than imported so this client component never pulls in
// that module's server-only db access (same pattern CountryRiskPanel.tsx
// uses for the shapes it fetches from /api/risk).
interface HistorySnapshot {
  snapshotAt: string;
  score: number;
  threatLevel: ThreatLevel;
  momentum: number;
}

interface HistorySummary {
  country: string;
  daysTracked: number;
  trend: "rising" | "falling" | "steady" | "insufficient-data";
  text: string;
}

const regionNames =
  typeof Intl !== "undefined"
    ? new Intl.DisplayNames(["en"], { type: "region" })
    : null;

function countryName(code: string): string {
  try {
    return regionNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

const CHART_HEIGHT = 90;

function HistoryChart({ history }: { history: HistorySnapshot[] }) {
  if (history.length === 0) return null;
  const maxScore = Math.max(...history.map((h) => h.score), 5);

  return (
    <div className="flex h-[90px] items-end gap-[3px] overflow-x-auto rounded border border-neutral-800 bg-black/40 p-2">
      {history.map((h) => {
        const barHeight = Math.max(4, (h.score / maxScore) * CHART_HEIGHT);
        return (
          <div
            key={h.snapshotAt}
            className="group relative w-3 shrink-0 rounded-t-sm"
            style={{ height: `${barHeight}px`, backgroundColor: THREAT_COLORS[h.threatLevel] }}
            title={`${formatDate(h.snapshotAt)} — score ${h.score.toFixed(1)}`}
          />
        );
      })}
    </div>
  );
}

export default function TrendsPanel({ countryScores }: TrendsPanelProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [history, setHistory] = useState<HistorySnapshot[]>([]);
  const [summary, setSummary] = useState<HistorySummary | null>(null);
  const [loading, setLoading] = useState(false);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return countryScores
      .filter(
        (s) =>
          s.country.toLowerCase().includes(q) ||
          countryName(s.country).toLowerCase().includes(q),
      )
      .slice(0, 20);
  }, [query, countryScores]);

  useEffect(() => {
    if (!selected) {
      setHistory([]);
      setSummary(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetch(`/api/history?country=${selected}`)
      .then((res) => res.json())
      .then((data: { history: HistorySnapshot[]; summary: HistorySummary }) => {
        if (cancelled) return;
        setHistory(data.history ?? []);
        setSummary(data.summary ?? null);
      })
      .catch(() => {
        if (!cancelled) {
          setHistory([]);
          setSummary(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto p-3">
        <h2 className="mb-1 font-mono text-xs uppercase tracking-[0.2em] text-red-500">
          Trends
        </h2>
        <p className="mb-3 font-mono text-[10px] text-red-800">
          Search a country to see its Pulse history — daily snapshots,
          recorded once a day, building up over time.
        </p>

        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search a country…"
          className="mb-2 w-full rounded border border-neutral-800 bg-black/60 px-3 py-2 font-mono text-xs text-red-300 placeholder:text-neutral-700 focus:border-red-700 focus:outline-none"
        />

        {query && !selected && (
          <div className="mb-3 max-h-48 overflow-y-auto rounded border border-neutral-800">
            {results.length === 0 && (
              <p className="p-2 font-mono text-[11px] text-neutral-600">
                No matches.
              </p>
            )}
            {results.map((s) => (
              <button
                key={s.country}
                onClick={() => {
                  setSelected(s.country);
                  setQuery(countryName(s.country));
                }}
                className="flex w-full items-center justify-between px-3 py-1.5 text-left font-mono text-xs text-neutral-300 hover:bg-red-950/30"
              >
                <span>{countryName(s.country)}</span>
                <span
                  className="rounded-sm px-1 py-0.5 text-[9px] font-bold uppercase text-black"
                  style={{ backgroundColor: THREAT_COLORS[s.threatLevel as ThreatLevel] }}
                >
                  {s.threatLabel}
                </span>
              </button>
            ))}
          </div>
        )}

        {selected && (
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="font-mono text-sm text-red-300">
                {countryName(selected)}
              </span>
              <button
                onClick={() => {
                  setSelected(null);
                  setQuery("");
                }}
                className="font-mono text-[10px] text-neutral-500 hover:text-red-400"
              >
                ✕ clear
              </button>
            </div>

            {loading && (
              <p className="font-mono text-[11px] text-neutral-600">
                Loading history…
              </p>
            )}

            {!loading && (
              <>
                <HistoryChart history={history} />
                <p className="mt-3 whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-neutral-300">
                  {summary?.text}
                </p>
              </>
            )}
          </div>
        )}

        {!query && !selected && (
          <p className="p-2 font-mono text-[11px] text-neutral-600">
            Type a country name or code above (e.g. &quot;Iran&quot; or
            &quot;IR&quot;) to look up its Pulse history.
          </p>
        )}
      </div>
    </div>
  );
}
