"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { splitAttribution, stripOutletSuffix } from "@/lib/displayText";
import { useWatchlist } from "@/lib/useWatchlist";
import { useTabVisible } from "@/lib/useTabVisible";
import type { CountryRiskScore } from "@/lib/useCountryRisk";
import type { AnomalyFindingResponse } from "@/lib/useAnomalies";
import { signalDescription } from "@/lib/anomalyLabels";
import {
  THREAT_COLORS,
  THREAT_DESCRIPTIONS,
  THREAT_LEVEL_THRESHOLDS,
  THREAT_LABELS,
  momentumArrow,
  momentumBucketLabel,
  explainPulseLevel,
  type ThreatLevel,
  type MomentumDirection,
} from "@/lib/threat";
import { CATEGORY_LABELS, type Category } from "@/lib/categories";
import { sourceLabel } from "@/lib/sourceLabels";
import { countryName, timeAgo } from "@/lib/format";

type ConfidenceTier = "single-source" | "corroborated" | "cross-confirmed";

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
  correlationGroupId: string | null;
  confidence: ConfidenceTier | null;
  clusterSize: number;
}

interface PillarBreakdownEntry {
  weightedLoad?: number;
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

interface CountryBrief {
  briefText: string;
  eventCount: number;
  generatedAt: string;
}

interface CountryThreatDetail {
  calculatedAt?: string;
  scoringVersion?: number;
  country: string;
  threatLevel: ThreatLevel;
  threatLabel: string;
  momentum: number;
  momentumDirection: MomentumDirection;
  pillars: PillarBreakdownEntry[];
  events: CountryRiskEvent[];
  brief: CountryBrief | null;
}

interface TravelAdvisory {
  level: 1 | 2 | 3 | 4;
  levelLabel: string;
  url: string;
}

interface CountryDossier {
  countryName: string;
  region: string | null;
  incomeLevel: string | null;
  capitalCity: string | null;
  gdpUsd: { value: number; year: string } | null;
  population: { value: number; year: string } | null;
  travelAdvisory: TravelAdvisory | null;
  summary: string;
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
  dossier: CountryDossier | null;
}

const compactNumber = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

interface CountryRiskPanelProps {
  scores: CountryRiskScore[];
  anomalies: Map<string, AnomalyFindingResponse[]>;
  selectedCountry: string | null;
  onSelectCountry: (country: string | null) => void;
}

// Collapsed-row badge — a count, not a blended score (see docs/ROADMAP.md's
// "no falsely precise single score" principle): "3 unusual signals" is
// honest about what was checked and found unusual; a single composite
// number would imply weighting/rigor no hand-picked formula actually has.
function AnomalyBadge({ findings }: { findings: AnomalyFindingResponse[] }) {
  if (findings.length === 0) return null;
  const title = findings.map(signalDescription).join(" · ");
  return (
    <span
      className="rounded-sm border border-amber-600/60 px-1 py-0 font-mono text-[9px] text-amber-500"
      title={title}
    >
      ⚠ {findings.length} unusual
    </span>
  );
}

// Event text for the country list: the post itself, then its source —
// with the machine-translation disclosure kept on the source line when the
// stored text carried one (see splitAttribution).
function RiskEventText({ summary, source }: { summary: string; source: string }) {
  const { body, translatedFrom } = splitAttribution(summary, source);
  return (
    <>
      <p className="mt-0.5 line-clamp-2 text-[11px] text-neutral-300">{stripOutletSuffix(body)}</p>
      <span className="mt-0.5 block font-mono text-[9px] text-neutral-500">
        Source: {sourceLabel(source)}
        {translatedFrom && ` · machine-translated from ${translatedFrom}`}
      </span>
    </>
  );
}

function ThreatBadge({ level, label }: { level: ThreatLevel; label: string }) {
  return (
    <span
      className="rounded-sm px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider text-black"
      style={{ backgroundColor: THREAT_COLORS[level] }}
      title={`Pulse Level ${level}: ${THREAT_DESCRIPTIONS[level]}`}
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
  anomalies,
  selectedCountry,
  onSelectCountry,
}: CountryRiskPanelProps) {
  const [detail, setDetail] = useState<CountryThreatDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailErrorCountry, setDetailErrorCountry] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<CountrySnapshot | null>(null);
  const { watchlist, toggle } = useWatchlist();
  const visible = useTabVisible();
  const [query, setQuery] = useState("");
  // The open row is brought into view: a country picked on the globe can
  // sit far down a list of ~200, and the panel otherwise opened at the top
  // with the expanded row nowhere in sight.
  const expandedRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (selectedCountry) expandedRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [selectedCountry]);

  useEffect(() => {
    // No setDetail(null) reset here: every render site below already
    // guards on `detail.country === r.country`, so stale detail for a
    // deselected country is simply never shown — resetting it would only
    // trigger an extra render for no visible effect.
    if (!selectedCountry || !visible) return;
    let cancelled = false;
    // react-hooks/set-state-in-effect flags this, but it's React's own
    // canonical fetch-with-loading-flag pattern (react.dev/learn/
    // synchronizing-with-effects#fetching-data) — deriving "loading"
    // instead would mean losing the distinction between "still fetching"
    // and "fetch failed", which the current .catch/.finally below relies
    // on. Not worth restructuring into a reducer for a lint nit.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadingDetail(true);
    const controller = new AbortController();
    let inFlight = false;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const res = await fetch(`/api/risk?country=${selectedCountry}`, { signal: controller.signal });
        if (!res.ok) throw new Error("Risk details unavailable");
        const data = await res.json();
        if (data.country !== selectedCountry || !Array.isArray(data.pillars)) throw new Error("Invalid risk details");
        if (!cancelled) {
          setDetail(data);
          setDetailErrorCountry(null);
        }
      } catch {
        // Preserve the last known explanation, visibly marked as stale.
        if (!cancelled) setDetailErrorCountry(selectedCountry);
      } finally {
        inFlight = false;
        if (!cancelled) setLoadingDetail(false);
      }
    };
    void load();
    // Match the globe's 15-minute CDN horizon (2026-09-24). Previously an
    // open panel stayed frozen indefinitely. Hidden tabs do no polling.
    const interval = setInterval(load, 15 * 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
      controller.abort();
    };
  }, [selectedCountry, visible]);

  useEffect(() => {
    // Same reasoning as the detail effect above: render already guards on
    // `snapshot?.country === r.country`, so no explicit reset is needed.
    if (!selectedCountry) return;
    let cancelled = false;
    fetch(`/api/country-snapshot?country=${selectedCountry}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
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

  const ranked = useMemo(() => {
    // Selecting a country with no current score (e.g. clicked on the globe
    // with no recent events) still gets a row, so it stays visible/expandable.
    const selectedHasScore =
      selectedCountry && scores.some((s) => s.country === selectedCountry);
    const rows: (CountryRiskScore | { country: string; placeholder: true })[] =
      selectedCountry && !selectedHasScore
        ? [{ country: selectedCountry, placeholder: true }, ...scores]
        : scores;
    const q = query.trim().toLowerCase();
    return rows
      .filter(
        (r) =>
          !q ||
          r.country === selectedCountry ||
          r.country.toLowerCase() === q ||
          countryName(r.country).toLowerCase().includes(q),
      )
      .sort((a, b) => {
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
  }, [scores, query, selectedCountry, watchlist]);

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-red-950 px-3 py-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Filter ${scores.length} countries…`}
          aria-label="Filter countries"
          className="w-full rounded border border-neutral-800 bg-black/60 px-2.5 py-1.5 font-mono text-xs text-red-300 placeholder:text-neutral-500 focus:border-red-700 focus:outline-none"
        />
        <p className="mt-1.5 font-mono text-[9px] uppercase tracking-wider text-neutral-500">
          ★ watchlist · ↑↓ momentum 0-100 · Pulse Level
        </p>
      </div>
      <div className="flex-1 overflow-y-auto">
        {ranked.length === 0 && (
          <p className="p-4 font-mono text-xs text-neutral-500">
            {query ? "No country matches that filter." : "No scored countries yet. Click any country on the globe."}
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
          const findings = anomalies.get(r.country) ?? [];
          return (
            <div
              key={r.country}
              ref={isExpanded ? expandedRef : undefined}
              className="scroll-mt-1 border-b border-red-950"
            >
              <div className="flex items-center gap-2 px-4 py-2.5">
                <button
                  type="button"
                  onClick={() => toggle(r.country)}
                  aria-label={isWatched ? `Remove ${countryName(r.country)} from watchlist` : `Add ${countryName(r.country)} to watchlist`}
                  aria-pressed={isWatched}
                  className={`-m-2.5 p-2.5 font-mono text-sm ${
                    isWatched ? "text-red-500" : "text-neutral-500 hover:text-red-400"
                  }`}
                >
                  {isWatched ? "★" : "☆"}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    onSelectCountry(isExpanded ? null : r.country)
                  }
                  aria-expanded={isExpanded}
                  className="flex-1 text-left"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs text-red-300">
                      {countryName(r.country)}
                    </span>
                    {!isPlaceholder && (
                      <div className="flex items-center gap-2">
                        {findings.length > 0 && <AnomalyBadge findings={findings} />}
                        <MomentumTag magnitude={momentum} direction={momentumDirection} />
                        <ThreatBadge level={threatLevel} label={threatLabel} />
                      </div>
                    )}
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <span className="font-mono text-[10px] text-neutral-500">
                      {isPlaceholder || eventCount === 0
                        ? "no recent events"
                        : `${eventCount} events · ${timeAgo(lastEventAt)}`}
                    </span>
                  </div>
                </button>
              </div>
              {isExpanded && (
                <div className="border-t border-red-950/70 bg-black/40 px-4 py-2">
                  {detailErrorCountry === r.country && (
                    <p role="status" className="mb-2 font-mono text-[10px] text-amber-500">
                      Refresh unavailable. {detail?.country === r.country ? "Showing the last known calculation." : "Risk details could not be loaded."}
                    </p>
                  )}
                  {loadingDetail && (
                    <p className="font-mono text-[10px] text-neutral-500">
                      loading pulse…
                    </p>
                  )}
                  {!loadingDetail && detail && detail.country === r.country && (
                    <>
                      <p className="mb-2 font-mono text-[10px] text-neutral-400">
                        {detail.scoringVersion !== undefined && `Method v${detail.scoringVersion}`}
                        {detail.calculatedAt && (
                          <time dateTime={detail.calculatedAt} title={new Date(detail.calculatedAt).toUTCString()}>
                            {` · Calculated ${timeAgo(detail.calculatedAt)}`}
                          </time>
                        )}
                      </p>
                      {detail.brief && (
                        <div className="mb-2 border-b border-red-950/70 pb-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-mono text-[9px] uppercase tracking-wider text-neutral-500">
                              AI summary · {detail.brief.eventCount} events
                            </span>
                            <span className="font-mono text-[9px] text-neutral-700">
                              {timeAgo(detail.brief.generatedAt)}
                            </span>
                          </div>
                          <p className="mt-1 text-xs leading-relaxed text-neutral-300">
                            {detail.brief.briefText}
                          </p>
                        </div>
                      )}
                      {findings.length > 0 && (
                        <div className="mb-2 border-b border-red-950/70 pb-2">
                          <span className="font-mono text-[9px] uppercase tracking-wider text-amber-500">
                            ⚠ {findings.length} unusual signal{findings.length > 1 ? "s" : ""}
                          </span>
                          {findings.map((f) => (
                            <p
                              key={`${f.signalType}:${f.category ?? ""}`}
                              className="mt-1 font-mono text-[10px] leading-relaxed text-neutral-400"
                            >
                              {signalDescription(f)}.
                            </p>
                          ))}
                        </div>
                      )}
                      {snapshot?.country === r.country && snapshot.dossier && (
                        <div className="mb-2 border-b border-red-950/70 pb-2">
                          {/* The dossier's own summary sentence repeats the GDP,
                              population and advisory shown just below, so
                              only the fields it adds are listed here. */}
                          <p className="font-mono text-[10px] leading-relaxed text-neutral-400">
                            {[
                              snapshot.dossier.region,
                              snapshot.dossier.incomeLevel && snapshot.dossier.incomeLevel !== "Aggregates"
                                ? snapshot.dossier.incomeLevel
                                : null,
                              snapshot.dossier.capitalCity
                                ? `Capital ${snapshot.dossier.capitalCity.replace(/\.$/, "")}`
                                : null,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </p>
                          {snapshot.dossier.travelAdvisory && (
                            <a
                              href={snapshot.dossier.travelAdvisory.url}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className={`mt-1.5 inline-block rounded-sm border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider ${
                                snapshot.dossier.travelAdvisory.level >= 3
                                  ? "border-amber-800 text-amber-500"
                                  : "border-neutral-700 text-neutral-500"
                              }`}
                              title="US State Dept Travel Advisory - opens the official advisory page"
                            >
                              Travel Advisory Level {snapshot.dossier.travelAdvisory.level}:{" "}
                              {snapshot.dossier.travelAdvisory.levelLabel}
                            </a>
                          )}
                          {(snapshot.dossier.gdpUsd || snapshot.dossier.population) && (
                            <div className="mt-1.5 flex items-center gap-4">
                              {snapshot.dossier.gdpUsd && (
                                <div>
                                  <div className="font-mono text-[9px] uppercase tracking-wider text-neutral-500">
                                    GDP ({snapshot.dossier.gdpUsd.year})
                                  </div>
                                  <div className="font-mono text-xs text-red-300">
                                    ${compactNumber.format(snapshot.dossier.gdpUsd.value)}
                                  </div>
                                </div>
                              )}
                              {snapshot.dossier.population && (
                                <div>
                                  <div className="font-mono text-[9px] uppercase tracking-wider text-neutral-500">
                                    Population ({snapshot.dossier.population.year})
                                  </div>
                                  <div className="font-mono text-xs text-red-300">
                                    {compactNumber.format(snapshot.dossier.population.value)}
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                      <div className="mb-2 border-b border-red-950/70 pb-2">
                        <p className="text-[11px] leading-snug text-neutral-400">
                          <span className="font-mono text-[9px] uppercase tracking-wider text-neutral-500">
                            Why {detail.threatLabel}:{" "}
                          </span>
                          {explainPulseLevel(detail.pillars)}
                        </p>
                        <details className="mt-1 text-[10px] leading-snug text-neutral-500">
                          <summary className="cursor-pointer font-mono uppercase tracking-wider text-neutral-500 hover:text-neutral-400">
                            How this is scored
                          </summary>
                          <ul className="mt-1 list-disc space-y-0.5 pl-4">
                            <li>Weighted load measures observed activity, not the probability of a future crisis. Low coverage can hide real risk.</li>
                            <li>Pillar thresholds: {[...THREAT_LEVEL_THRESHOLDS].reverse().map(([min, level]) => `${THREAT_LABELS[level]} at ${min}`).join("; ")}.</li>
                            <li>Each approved story adds its severity, halving every 3 days; nothing older than 30 days counts.</li>
                            <li>A story carried by several outlets counts once, with a capped bonus per independent source (up to x1.6).</li>
                            <li>Hazards are weighted by how many people live within 100 km.</li>
                            <li>A single automated sensor (satellite fires, seismometers) is capped: alone it can reach High, never Extreme.</li>
                            <li>The overall level is the highest pillar, one step higher when two or more pillars are High at once.</li>
                          </ul>
                        </details>
                      </div>
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
                              <div className="mt-1 font-mono text-[9px] text-neutral-400" title={p.weightedLoad === undefined ? undefined : `Exact weighted load: ${p.weightedLoad}`}>
                                {p.weightedLoad !== undefined && `Weighted load ${p.weightedLoad.toFixed(2)}`}
                              </div>
                            )}
                            {p.covered && (
                              <div className="mt-0.5 flex items-center justify-between">
                                <span className="font-mono text-[9px] text-neutral-500">
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
                        <p className="font-mono text-[10px] text-neutral-500">
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
                            <span className="font-mono text-[9px] text-neutral-500">
                              {timeAgo(e.publishedAt)}
                            </span>
                          </div>
                          <RiskEventText summary={e.summary} source={e.source} />
                          {e.clusterSize > 1 && (
                            <span
                              className={`mt-1 inline-block font-mono text-[9px] uppercase tracking-wider ${
                                e.confidence === "cross-confirmed"
                                  ? "text-emerald-500"
                                  : "text-amber-500"
                              }`}
                              title="Same country, pillar, and day as other tracked reports"
                            >
                              {e.confidence === "cross-confirmed" ? "✓✓" : "✓"}{" "}
                              {e.confidence === "cross-confirmed" ? "Cross-confirmed" : "Corroborated"} ·{" "}
                              {e.clusterSize} reports
                            </span>
                          )}
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
