"use client";

import {
  LAYER_CATEGORIES,
  CATEGORY_LABELS,
  type Category,
} from "@/lib/categories";
import {
  DATA_LAYERS,
  DATA_LAYER_LABELS,
  DATA_LAYER_DESCRIPTIONS,
  type DataLayerId,
} from "@/lib/dataLayers";
import type {
  FlightsResponse,
  CommercialFlightsResponse,
  WeatherResponse,
  SatellitesResponse,
  CryptoResponse,
  GithubResponse,
  GdpResponse,
  PopulationResponse,
  MacroResponse,
  CyberResponse,
} from "@/lib/dataLayerTypes";

interface LayersDashboardProps {
  active: Set<Category>;
  onToggle: (category: Category) => void;
  activeDataLayers: Set<DataLayerId>;
  onToggleDataLayer: (id: DataLayerId) => void;
  flights: FlightsResponse | null;
  commercialFlights: CommercialFlightsResponse | null;
  weather: WeatherResponse | null;
  satellites: SatellitesResponse | null;
  crypto: CryptoResponse | null;
  github: GithubResponse | null;
  gdp: GdpResponse | null;
  population: PopulationResponse | null;
  macro: MacroResponse | null;
  cyber: CyberResponse | null;
}

const LAYER_DESCRIPTIONS: Partial<Record<Category, string>> = {
  "political-instability":
    "GDELT — coups, contested elections, martial law, government collapse.",
  humanitarian:
    "GDELT — famine, displacement, refugee flows, disease outbreaks.",
  earthquake: "USGS — magnitude 4.5+ seismic events, refreshed every ingest cycle.",
  "natural-disaster":
    "NASA EONET + GDACS — cyclones, volcanoes, tsunamis, severe storms.",
  "climate-hazard": "NASA EONET + GDACS — floods, wildfires, drought.",
  "infrastructure-outage":
    "IODA (Georgia Tech) — country-level internet connectivity disruptions.",
};

function formatUsd(value: number): string {
  if (value >= 1e12) return `$${(value / 1e12).toFixed(2)}T`;
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  return `$${value.toFixed(0)}`;
}

function formatPrice(value: number): string {
  return value >= 1 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`;
}

function formatCount(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(0)}K`;
  return value.toFixed(0);
}

export default function LayersDashboard({
  active,
  onToggle,
  activeDataLayers,
  onToggleDataLayer,
  flights,
  commercialFlights,
  weather,
  satellites,
  crypto,
  github,
  gdp,
  population,
  macro,
  cyber,
}: LayersDashboardProps) {
  function renderPreview(id: DataLayerId) {
    if (id === "flights" && flights) {
      return (
        <span className="mt-1 block text-[11px] text-neutral-500">
          {flights.aircraft.length} aircraft tracked
        </span>
      );
    }
    if (id === "commercial-flights" && commercialFlights) {
      return (
        <span className="mt-1 block text-[11px] text-neutral-500">
          {commercialFlights.aircraft.length} aircraft tracked
        </span>
      );
    }
    if (id === "weather" && weather) {
      return (
        <span className="mt-1 block text-[11px] text-neutral-500">
          {weather.conditions.length} locations monitored
        </span>
      );
    }
    if (id === "satellites" && satellites) {
      return (
        <div className="mt-1.5 space-y-0.5 text-[11px] text-neutral-500">
          <div>{satellites.satellites.length} tracked</div>
          {satellites.satellites.slice(0, 4).map((sat) => (
            <div key={sat.noradCatId} className="truncate">
              {sat.name} — {sat.orbitalPeriodMin.toFixed(0)} min orbit
            </div>
          ))}
        </div>
      );
    }
    if (id === "crypto" && crypto) {
      return (
        <div className="mt-1.5 space-y-0.5 text-[11px]">
          {crypto.markets.slice(0, 5).map((m) => (
            <div key={m.id} className="flex justify-between gap-2 text-neutral-500">
              <span>{m.symbol}</span>
              <span>{formatPrice(m.priceUsd)}</span>
              <span className={m.change24hPct >= 0 ? "text-emerald-500" : "text-red-500"}>
                {m.change24hPct >= 0 ? "+" : ""}
                {m.change24hPct.toFixed(1)}%
              </span>
            </div>
          ))}
        </div>
      );
    }
    if (id === "github" && github) {
      return (
        <div className="mt-1.5 space-y-0.5 text-[11px] text-neutral-500">
          {github.repos.slice(0, 4).map((repo) => (
            <div key={repo.fullName} className="flex justify-between gap-2">
              <span className="truncate">{repo.fullName}</span>
              <span className="shrink-0">
                ★{repo.stars.toLocaleString()}
                {repo.language ? ` · ${repo.language}` : ""}
              </span>
            </div>
          ))}
        </div>
      );
    }
    if (id === "gdp" && gdp) {
      return (
        <div className="mt-1.5 space-y-0.5 text-[11px] text-neutral-500">
          {gdp.countries.slice(0, 5).map((c) => (
            <div key={c.countryIso3} className="flex justify-between gap-2">
              <span className="truncate">{c.countryName}</span>
              <span className="shrink-0">{c.value != null ? formatUsd(c.value) : "—"}</span>
            </div>
          ))}
        </div>
      );
    }
    if (id === "population" && population) {
      return (
        <div className="mt-1.5 space-y-0.5 text-[11px] text-neutral-500">
          {population.countries.slice(0, 5).map((c) => (
            <div key={c.countryIso3} className="flex justify-between gap-2">
              <span className="truncate">{c.countryName}</span>
              <span className="shrink-0">{c.value != null ? formatCount(c.value) : "—"}</span>
            </div>
          ))}
        </div>
      );
    }
    if (id === "macro" && macro) {
      const rows = [
        macro.eurUsd && `EUR/USD  ${macro.eurUsd.value.toFixed(4)} (${macro.eurUsd.date})`,
        macro.usPolicyRate &&
          `US Policy Rate  ${macro.usPolicyRate.value.toFixed(3)}% (${macro.usPolicyRate.date})`,
        macro.euUnemploymentPct &&
          `EU Unemployment  ${macro.euUnemploymentPct.value.toFixed(1)}% (${macro.euUnemploymentPct.period})`,
      ].filter((r): r is string => Boolean(r));
      if (rows.length === 0) return null;
      return (
        <div className="mt-1.5 space-y-0.5 text-[11px] text-neutral-500">
          {rows.map((row) => (
            <div key={row}>{row}</div>
          ))}
        </div>
      );
    }
    if (id === "cyber" && cyber) {
      return (
        <div className="mt-1.5 space-y-1 text-[11px] text-neutral-500">
          {cyber.vulnerabilities.slice(0, 5).map((v) => (
            <div key={v.cveId} className="flex items-start justify-between gap-2">
              <span className="truncate">
                {v.cveId} — {v.product}
                {v.knownRansomwareUse && (
                  <span className="ml-1 text-red-500">⚠ ransomware</span>
                )}
              </span>
              <span className="shrink-0">{v.dateAdded}</span>
            </div>
          ))}
        </div>
      );
    }
    return null;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto p-3">
        <h2 className="mb-2 font-mono text-xs uppercase tracking-[0.2em] text-red-500">
          Event Layers
        </h2>
        {LAYER_CATEGORIES.map((cat) => {
          const isActive = active.has(cat);
          return (
            <button
              key={cat}
              onClick={() => onToggle(cat)}
              className={`mb-2 flex w-full items-start gap-3 rounded border px-3 py-2.5 text-left transition ${
                isActive
                  ? "border-red-500 bg-red-950/40"
                  : "border-neutral-800 hover:border-red-900"
              }`}
            >
              <span
                className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border font-mono text-[10px] leading-none ${
                  isActive
                    ? "border-red-400 bg-red-500 text-black"
                    : "border-neutral-700 text-transparent"
                }`}
              >
                ✓
              </span>
              <span className="min-w-0">
                <span
                  className={`block font-mono text-xs uppercase tracking-wider ${
                    isActive ? "text-red-300" : "text-neutral-400"
                  }`}
                >
                  {CATEGORY_LABELS[cat]}
                </span>
                {LAYER_DESCRIPTIONS[cat] && (
                  <span className="mt-0.5 block text-[11px] text-neutral-500">
                    {LAYER_DESCRIPTIONS[cat]}
                  </span>
                )}
              </span>
            </button>
          );
        })}

        <h2 className="mb-2 mt-4 font-mono text-xs uppercase tracking-[0.2em] text-red-500">
          Live Data Layers
        </h2>
        <p className="mb-2 font-mono text-[10px] text-red-800">
          Flights/weather render on the globe; the rest preview here.
        </p>
        {DATA_LAYERS.map((id) => {
          const isActive = activeDataLayers.has(id);
          return (
            <button
              key={id}
              onClick={() => onToggleDataLayer(id)}
              className={`mb-2 flex w-full items-start gap-3 rounded border px-3 py-2.5 text-left transition ${
                isActive
                  ? "border-red-500 bg-red-950/40"
                  : "border-neutral-800 hover:border-red-900"
              }`}
            >
              <span
                className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border font-mono text-[10px] leading-none ${
                  isActive
                    ? "border-red-400 bg-red-500 text-black"
                    : "border-neutral-700 text-transparent"
                }`}
              >
                ✓
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className={`block font-mono text-xs uppercase tracking-wider ${
                    isActive ? "text-red-300" : "text-neutral-400"
                  }`}
                >
                  {DATA_LAYER_LABELS[id]}
                </span>
                <span className="mt-0.5 block text-[11px] text-neutral-500">
                  {DATA_LAYER_DESCRIPTIONS[id]}
                </span>
                {isActive && renderPreview(id)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
