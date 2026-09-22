"use client";

import { useState } from "react";
import type { AlertView } from "@/lib/useAlerts";
import { stripOutletSuffix } from "@/lib/displayText";

// The alert surface (2026-09-22). Everything else in this app answers
// "what is happening"; this answers "what CHANGED", which is the question
// somebody with five minutes actually has.
//
// Rows are ranked by tier then recency by the API, so the most serious
// thing is always at the top. Each row expands into the arithmetic behind
// it — every component of the score with its own points — plus the events
// that drove it. That is deliberate: an alert you cannot interrogate is
// an opinion with a colour on it, and this product's whole claim is that
// its numbers can be taken apart.
//
// Clicking a row selects the country, which focuses the globe and filters
// the feed, so an alert is a way INTO the rest of the app rather than a
// dead end.

const regionNames =
  typeof Intl !== "undefined" ? new Intl.DisplayNames(["en"], { type: "region" }) : null;

function countryName(code: string): string {
  try {
    return regionNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

function timeAgo(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// FLASH earns the loudest treatment in the app because it is the rarest
// thing in it — the engine gates it behind a real risk-level rise with
// independent corroboration. ROUTINE is deliberately drab.
const TIER_STYLE: Record<string, { chip: string; border: string; label: string }> = {
  FLASH: {
    chip: "bg-red-600 text-black",
    border: "border-red-600/70 shadow-[0_0_14px_rgba(255,0,0,0.25)]",
    label: "Flash",
  },
  PRIORITY: {
    chip: "bg-orange-500 text-black",
    border: "border-orange-700/60",
    label: "Priority",
  },
  WATCH: { chip: "bg-amber-600/80 text-black", border: "border-amber-900/60", label: "Watch" },
  ROUTINE: {
    chip: "bg-neutral-700 text-neutral-200",
    border: "border-neutral-800",
    label: "Routine",
  },
};

function tierStyle(tier: string) {
  return TIER_STYLE[tier] ?? TIER_STYLE.ROUTINE;
}

// "3 to 4" reads better than a signed number for a 1-4 scale, and an
// unchanged value is worth saying out loud so a momentum-driven alert
// doesn't look like it is hiding a level change.
function changeText(label: string, now: number, before: number): string {
  if (now === before) return `${label} ${now}`;
  return `${label} ${before} to ${now}`;
}

interface AlertsPanelProps {
  alerts: AlertView[];
  loading?: boolean;
  onSelectCountry: (country: string) => void;
}

export default function AlertsPanel({ alerts, loading, onSelectCountry }: AlertsPanelProps) {
  const [expandedId, setExpandedId] = useState<number | null>(null);

  if (loading && alerts.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <p className="font-mono text-[11px] text-neutral-600">loading alerts…</p>
      </div>
    );
  }

  // Nothing here is the correct and common state, so it should read as
  // working rather than as broken or empty. The engine only speaks when a
  // country's level, momentum or unusual-signal count actually moved.
  if (alerts.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
        <span className="font-mono text-[10px] uppercase tracking-widest text-neutral-600">
          No change to report
        </span>
        <p className="max-w-xs font-mono text-[10px] leading-relaxed text-neutral-700">
          An alert is raised when a country&rsquo;s risk level, momentum or unusual-signal count
          moves. Quiet here means nothing moved in the last 72 hours, not that nothing is
          happening.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      {alerts.map((a) => {
        const style = tierStyle(a.tier);
        const isExpanded = expandedId === a.id;
        return (
          <div key={a.id} className={`border-b border-red-950/60 ${isExpanded ? "bg-black/40" : ""}`}>
            <button
              onClick={() => setExpandedId(isExpanded ? null : a.id)}
              className={`w-full border-l-2 px-4 py-2.5 text-left transition hover:bg-red-950/20 ${style.border}`}
              aria-expanded={isExpanded}
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  className={`rounded-sm px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-widest ${style.chip}`}
                >
                  {style.label}
                </span>
                <span className="font-mono text-[9px] text-neutral-600">{timeAgo(a.firedAt)}</span>
              </div>
              <div className="mt-1.5 font-mono text-[12px] leading-snug text-neutral-200">
                {a.headline}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[9px] text-neutral-600">
                <span>{changeText("level", a.level, a.previousLevel)}</span>
                <span>{changeText("momentum", a.momentum, a.previousMomentum)}</span>
                <span>
                  {a.sourceFamilies} source{a.sourceFamilies === 1 ? "" : "s"}
                </span>
                {a.anomalySignals > 0 && (
                  <span className="text-amber-600">
                    {a.anomalySignals} unusual signal{a.anomalySignals === 1 ? "" : "s"}
                  </span>
                )}
              </div>
            </button>

            {isExpanded && (
              <div className="px-4 pb-3">
                <div className="mb-2 border-b border-red-950/70 pb-2">
                  <span className="font-mono text-[9px] uppercase tracking-wider text-neutral-600">
                    Why this fired · score {a.score}
                  </span>
                  <div className="mt-1 flex flex-col gap-0.5">
                    {a.components.map((c) => (
                      <div key={c.name} className="flex items-baseline justify-between gap-3">
                        <span className="font-mono text-[10px] text-neutral-400">{c.detail}</span>
                        <span className="shrink-0 font-mono text-[10px] text-neutral-500">
                          +{c.points}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                {a.evidence.length > 0 && (
                  <div className="mb-2 border-b border-red-950/70 pb-2">
                    <span className="font-mono text-[9px] uppercase tracking-wider text-neutral-600">
                      Evidence
                    </span>
                    {a.evidence.map((e) => (
                      <a
                        key={e.id}
                        href={e.url}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1 block font-mono text-[10px] leading-relaxed text-neutral-400 hover:text-red-300"
                      >
                        <span className="text-neutral-600">sev {e.severity} · {e.source} — </span>
                        {stripOutletSuffix(e.title)}
                      </a>
                    ))}
                  </div>
                )}

                <button
                  onClick={() => onSelectCountry(a.country)}
                  className="font-mono text-[10px] uppercase tracking-wider text-red-400 hover:text-red-300"
                >
                  View {countryName(a.country)} →
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
