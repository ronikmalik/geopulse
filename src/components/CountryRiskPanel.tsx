"use client";

import { useEffect, useState } from "react";
import { useWatchlist } from "@/lib/useWatchlist";
import type { CountryRiskScore } from "@/lib/useCountryRisk";
import {
  THREAT_COLORS,
  momentumArrow,
  momentumBucketLabel,
  type ThreatLevel,
  type MomentumDirection,
} from "@/lib/threat";
import { CATEGORY_LABELS, type Category } from "@/lib/categories";

interface CountryRiskEvent {
  id: number;
  title: string;
  summary: string;
  url: string;
  source: string;
  category: string;
  severity: number;
  publishedAt: string;
  weight: number;
}

interface PillarBreakdownEntry {
  pillarId: string;
  label: string;
  shortLabel: string;
  color: string;
  threatLevel: ThreatLevel;
  threatLabel: string;
  momentum: number;
  momentumDirection: MomentumDirection;
  eventCount: number;
  lastEventAt: string | null;
  covered: boolean;
}

interface CountryThreatDetail {
  country: string;
  threatLevel: ThreatLevel;
  threatLabel: string;
  momentum: number;
  momentumDirection: MomentumDirection;
  pillars: PillarBreakdownEntry[];
  events: CountryRiskEvent[];
}

interface CountrySnapshot {
  country: string;
  currency: {
    currency: string;
    rate: number;
    changePct: number | null;
    date: string;
    source: "ecb" | "community";
  } | null;
  index: {
    symbol: string;
    name: string;
    price: number;
    change: number;
    changePct: number;
  } | null;
}

interface CountryRiskPanelProps {
  scores: CountryRiskScore[];
  selectedCountry: string | null;
  onSelectCountry: (country: string | null) => void;
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

function timeAgo(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function ThreatBadge({ level, label }: { level: ThreatLevel; label: string }) {
  return (
    <span
      className="rounded-sm px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider text-black"
      style={{ backgroundColor: THREAT_COLORS[level] }}
      title={`Threat Level ${level}`}
    >
      {label}
    </span>
  );
}

function MomentumTag({
  magnitude,
  direction,
}: {
  magnitude: number;
  direction: MomentumDirection;
}) {
  const color =
    direction > 0 ? "text-red-400" : direction < 0 ? "text-emerald-500" : "text-neutral-500";
  return (
    <span className={`font-mono text-[10px] ${color}`} title={momentumBucketLabel(magnitude)}>
      {momentumArrow(direction)} {magnitude}
    </span>
  );
}

export default function CountryRiskPanel({
  scores,
  selectedCountry,
  onSelectCountry,
}: CountryRiskPanelProps) {
  const [detail, setDetail] = useState<CountryThreatDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [snapshot, setSnapshot] = useState<CountrySnapshot | null>(null);
  const { watchlist, toggle } = useWatchlist();

  useEffect(() => {
    if (!selectedCountry) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setLoadingDetail(true);
    fetch(`/api/risk?country=${selectedCountry}`)
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setDetail(data);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      })
      .finally(() => {
        if (!cancelled) setLoadingDetail(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedCountry]);

  useEffect(() => {
    if (!selectedCountry) {
      setSnapshot(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/country-snapshot?country=${selectedCountry}`)
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setSnapshot(data);
      })
      .catch(() => {
        if (!cancelled) setSnapshot(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedCountry]);

  // Selecting a country with no current score (e.g. clicked on the globe
  // with no recent events) still gets a row, so it stays visible/expandable.
  const selectedHasScore =
    selectedCountry && scores.some((s) => s.country === selectedCountry);
  const rows: (CountryRiskScore | { country: string; placeholder: true })[] =
    selectedCountry && !selectedHasScore
      ? [{ country: selectedCountry, placeholder: true }, ...scores]
      : scores;

  const ranked = [...rows].sort((a, b) => {
    const aWatched = watchlist.has(a.country);
    const bWatched = watchlist.has(b.country);
    if (aWatched !== bWatched) return aWatched ? -1 : 1;
    const aLevel = "threatLevel" in a ? a.threatLevel : 0;
    const bLevel = "threatLevel" in b ? b.threatLevel : 0;
    if (aLevel !== bLevel) return bLevel - aLevel;
    const aScore = "score" in a ? a.score : -1;
    const bScore = "score" in b ? b.score : -1;
    return bScore - aScore;
  });

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto">
        {ranked.length === 0 && (
          <p className="p-4 font-mono text-xs text-neutral-600">
            No scored countries yet… click any country on the globe.
          </p>
        )}
        {ranked.map((r) => {
          const isWatched = watchlist.has(r.country);
          const isExpanded = selectedCountry === r.country;
          const isPlaceholder = "placeholder" in r;
          const threatLevel: ThreatLevel = "threatLevel" in r ? r.threatLevel : 1;
          const threatLabel = "threatLabel" in r ? r.threatLabel : "";
          const momentum = "momentum" in r ? r.momentum : 0;
          const momentumDirection: MomentumDirection =
            "momentumDirection" in r ? r.momentumDirection : 0;
          const eventCount = "eventCount" in r ? r.eventCount : 0;
          const lastEventAt = "lastEventAt" in r ? r.lastEventAt : "";
          return (
            <div key={r.country} className="border-b border-red-950">
              <div className="flex items-center gap-2 px-4 py-2.5">
                <button
                  onClick={() => toggle(r.country)}
                  aria-label={isWatched ? "Remove from watchlist" : "Add to watchlist"}
                  className={`font-mono text-sm ${
                    isWatched ? "text-red-500" : "text-neutral-700 hover:text-red-700"
                  }`}
                >
                  {isWatched ? "★" : "☆"}
                </button>
                <button
                  onClick={() =>
                    onSelectCountry(isExpanded ? null : r.country)
                  }
                  className="flex-1 text-left"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs text-red-300">
                      {countryName(r.country)}
                    </span>
                    {!isPlaceholder && (
                      <div className="flex items-center gap-2">
                        <MomentumTag magnitude={momentum} direction={momentumDirection} />
                        <ThreatBadge level={threatLevel} label={threatLabel} />
                      </div>
                    )}
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <span className="font-mono text-[10px] text-neutral-600">
                      {isPlaceholder
                        ? "no recent events"
                        : `${eventCount} events · ${timeAgo(lastEventAt)}`}
                    </span>
                  </div>
                </button>
              </div>
              {isExpanded && (
                <div className="border-t border-red-950/70 bg-black/40 px-4 py-2">
                  {loadingDetail && (
                    <p className="font-mono text-[10px] text-neutral-600">
                      loading threat assessment…
                    </p>
                  )}
                  {!loadingDetail && detail && detail.country === r.country && (
                    <>
                      <div className="mb-2 grid grid-cols-2 gap-1.5 border-b border-red-950/70 pb-2">
                        {detail.pillars.map((p) => (
                          <div
                            key={p.pillarId}
                            className={`rounded-sm border px-1.5 py-1 ${
                              p.covered
                                ? "border-neutral-800"
                                : "border-neutral-900 opacity-50"
                            }`}
                            title={p.label}
                          >
                            <div className="flex items-center justify-between gap-1">
                              <span className="truncate font-mono text-[9px] uppercase tracking-wider text-neutral-500">
                                {p.shortLabel}
                              </span>
                              {p.covered ? (
                                <ThreatBadge level={p.threatLevel} label={String(p.threatLevel)} />
                              ) : (
                                <span className="font-mono text-[8px] text-neutral-700">
                                  n/a
                                </span>
                              )}
                            </div>
                            {p.covered && (
                              <div className="mt-0.5 flex items-center justify-between">
                                <span className="font-mono text-[9px] text-neutral-600">
                                  {p.eventCount} evt
                                </span>
                                <MomentumTag
                                  magnitude={p.momentum}
                                  direction={p.momentumDirection}
                                />
                              </div>
                            )}
                            {!p.covered && (
                              <div className="mt-0.5 font-mono text-[8px] text-neutral-700">
                                not yet tracked
                              </div>
                            )}
                          </div>
                        ))}
                      </div>

                      {snapshot?.country === r.country &&
                        (snapshot.currency || snapshot.index) && (
                          <div className="mb-2 grid grid-cols-2 gap-2 border-b border-red-950/70 pb-2">
                            {snapshot.currency && (
                              <div>
                                <div className="font-mono text-[9px] uppercase tracking-wider text-neutral-500">
                                  USD/{snapshot.currency.currency}
                                </div>
                                <div className="font-mono text-xs text-red-300">
                                  {snapshot.currency.rate < 1
                                    ? snapshot.currency.rate.toFixed(4)
                                    : snapshot.currency.rate.toFixed(2)}
                                </div>
                                {snapshot.currency.changePct != null && (
                                  <div
                                    className={`font-mono text-[10px] ${
                                      snapshot.currency.changePct >= 0
                                        ? "text-emerald-500"
                                        : "text-red-500"
                                    }`}
                                  >
                                    {snapshot.currency.changePct >= 0 ? "+" : ""}
                                    {snapshot.currency.changePct.toFixed(2)}%
                                  </div>
                                )}
                              </div>
                            )}
                            {snapshot.index && (
                              <div>
                                <div className="truncate font-mono text-[9px] uppercase tracking-wider text-neutral-500">
                                  {snapshot.index.name}
                                </div>
                                <div className="font-mono text-xs text-red-300">
                                  {snapshot.index.price.toLocaleString()}
                                </div>
                                <div
                                  className={`font-mono text-[10px] ${
                                    snapshot.index.changePct >= 0
                                      ? "text-emerald-500"
                                      : "text-red-500"
                                  }`}
                                >
                                  {snapshot.index.changePct >= 0 ? "+" : ""}
                                  {snapshot.index.changePct.toFixed(2)}%
                                </div>
                              </div>
                            )}
                          </div>
                        )}

                      {detail.events.length === 0 && (
                        <p className="font-mono text-[10px] text-neutral-600">
                          No tracked events for this country in the last 30 days.
                        </p>
                      )}
                      {detail.events.map((e) => (
                        <a
                          key={e.id}
                          href={e.url}
                          target="_blank"
                          rel="noreferrer"
                          className="block border-b border-red-950/50 py-1.5 last:border-b-0 hover:bg-red-950/20"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-mono text-[9px] uppercase tracking-wider text-red-700">
                              {CATEGORY_LABELS[e.category as Category] ?? e.category} · sev {e.severity}
                            </span>
                            <span className="font-mono text-[9px] text-neutral-600">
                              {timeAgo(e.publishedAt)}
                            </span>
                          </div>
                          <p className="mt-0.5 line-clamp-2 text-[11px] text-neutral-300">
                            {e.summary}
                          </p>
                        </a>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
