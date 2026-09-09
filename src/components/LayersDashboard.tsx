"use client";

import {
  LAYER_CATEGORIES,
  CATEGORY_LABELS,
  type Category,
} from "@/lib/categories";
import { PILLARS, pillarForCategory } from "@/lib/pillars";
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
  GdpResponse,
  PopulationResponse,
  CyberResponse,
  TelegramLayerResponse,
  GpsJammingResponse,
  SubmarineCablesResponse,
  TravelAdvisoriesResponse,
  GridLossResponse,
  EnergyMixResponse,
  FoodPriceIndexResponse,
  AirQualityResponse,
  PortCongestionResponse,
  TradeBalanceResponse,
} from "@/lib/dataLayerTypes";

interface LayersDashboardProps {
  active: Set<Category>;
  onToggle: (category: Category) => void;
  activeDataLayers: Set<DataLayerId>;
  onToggleDataLayer: (id: DataLayerId) => void;
  flights: FlightsResponse | null;
  commercialFlights: CommercialFlightsResponse | null;
  commercialFlightsError: string | null;
  weather: WeatherResponse | null;
  gdp: GdpResponse | null;
  population: PopulationResponse | null;
  cyber: CyberResponse | null;
  telegram: TelegramLayerResponse | null;
  gpsJamming: GpsJammingResponse | null;
  submarineCables: SubmarineCablesResponse | null;
  travelAdvisories: TravelAdvisoriesResponse | null;
  gridLoss: GridLossResponse | null;
  energyMix: EnergyMixResponse | null;
  foodPriceIndex: FoodPriceIndexResponse | null;
  airQuality: AirQualityResponse | null;
  portCongestion: PortCongestionResponse | null;
  tradeBalance: TradeBalanceResponse | null;
}

const LAYER_DESCRIPTIONS: Partial<Record<Category, string>> = {
  "political-instability":
    "GDELT, RSS & Telegram — coups, contested elections, martial law, government collapse.",
  humanitarian:
    "GDELT, RSS & Telegram — famine, displacement, refugee flows, disease outbreaks.",
  earthquake: "USGS — magnitude 4.5+ seismic events, last 30 days.",
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
  commercialFlightsError,
  weather,
  gdp,
  population,
  cyber,
  telegram,
  gpsJamming,
  submarineCables,
  travelAdvisories,
  gridLoss,
  energyMix,
  foodPriceIndex,
  airQuality,
  portCongestion,
  tradeBalance,
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
      if (commercialFlightsError) {
        return (
          <span className="mt-1 block text-[11px] text-red-500">
            Unavailable right now ({commercialFlightsError}) — not a genuine zero
          </span>
        );
      }
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
    if (id === "telegram" && telegram) {
      return (
        <div className="mt-1.5 space-y-1.5 text-[11px] text-neutral-500">
          {telegram.posts.slice(0, 5).map((p) => (
            <div key={p.url}>
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-neutral-400">{p.channelLabel}</span>
                {p.translated && (
                  <span className="shrink-0 text-[9px] uppercase tracking-wider text-sky-500">
                    translated
                  </span>
                )}
              </div>
              <p className="line-clamp-2">{p.text}</p>
            </div>
          ))}
        </div>
      );
    }
    if (id === "gps-jamming" && gpsJamming?.summary) {
      const s = gpsJamming.summary;
      return (
        <div className="mt-1.5 space-y-0.5 text-[11px] text-neutral-500">
          <div>
            {s.date} — {s.totalBadHexes} suspect cells
            {s.globalSuspect ? " (flagged)" : ""}
          </div>
          {s.regions.slice(0, 5).map((r) => (
            <div key={r.countryIso2} className="flex justify-between gap-2">
              <span className="truncate">{r.countryName}</span>
              <span className="shrink-0">{r.badAircraftCount} reports</span>
            </div>
          ))}
        </div>
      );
    }
    if (id === "submarine-cables" && submarineCables?.summary) {
      const s = submarineCables.summary;
      return (
        <div className="mt-1.5 space-y-0.5 text-[11px] text-neutral-500">
          <div>
            {s.totalCables} cables, {s.totalLandingPoints} landing points
          </div>
          {s.topCountries.slice(0, 5).map((c) => (
            <div key={c.countryIso2} className="flex justify-between gap-2">
              <span className="truncate">{c.countryName}</span>
              <span className="shrink-0">{c.landingPointCount}</span>
            </div>
          ))}
        </div>
      );
    }
    if (id === "travel-advisories" && travelAdvisories) {
      return (
        <div className="mt-1.5 space-y-0.5 text-[11px] text-neutral-500">
          {travelAdvisories.advisories.slice(0, 6).map((a) => (
            <div key={a.country} className="flex justify-between gap-2">
              <span className="truncate">{a.countryName}</span>
              <span className="shrink-0">Level {a.level}</span>
            </div>
          ))}
        </div>
      );
    }
    if (id === "grid-loss" && gridLoss) {
      return (
        <div className="mt-1.5 space-y-0.5 text-[11px] text-neutral-500">
          {gridLoss.countries.slice(0, 5).map((c) => (
            <div key={c.countryIso3} className="flex justify-between gap-2">
              <span className="truncate">{c.countryName}</span>
              <span className="shrink-0">{c.value != null ? `${c.value.toFixed(1)}%` : "—"}</span>
            </div>
          ))}
        </div>
      );
    }
    if (id === "energy-mix" && energyMix) {
      return (
        <div className="mt-1.5 space-y-0.5 text-[11px] text-neutral-500">
          {energyMix.countries.slice(0, 5).map((c) => (
            <div key={c.countryIso3} className="flex justify-between gap-2">
              <span className="truncate">{c.countryName}</span>
              <span className="shrink-0">{c.value.toFixed(0)}% fossil</span>
            </div>
          ))}
        </div>
      );
    }
    if (id === "food-price-index" && foodPriceIndex?.index) {
      const idx = foodPriceIndex.index;
      return (
        <div className="mt-1.5 text-[11px] text-neutral-500">
          {idx.value.toFixed(1)} ({idx.date})
          {idx.changePct != null && (
            <span className={idx.changePct >= 0 ? "text-red-400" : "text-emerald-400"}>
              {" "}
              {idx.changePct >= 0 ? "+" : ""}
              {idx.changePct.toFixed(1)}% vs prior month
            </span>
          )}
        </div>
      );
    }
    if (id === "air-quality" && airQuality) {
      return (
        <div className="mt-1.5 space-y-0.5 text-[11px] text-neutral-500">
          {airQuality.readings
            .filter((r) => r.pm25 != null)
            .slice(0, 6)
            .map((r) => (
              <div key={r.location.name} className="flex justify-between gap-2">
                <span className="truncate">{r.location.name}</span>
                <span className="shrink-0">
                  {r.pm25} {r.unit}
                </span>
              </div>
            ))}
        </div>
      );
    }
    if (id === "port-congestion" && portCongestion) {
      return (
        <div className="mt-1.5 space-y-0.5 text-[11px] text-neutral-500">
          <div className="text-neutral-600">Quietest chokepoints (vessels/day):</div>
          {portCongestion.chokepoints.slice(0, 6).map((c) => (
            <div key={c.name} className="flex justify-between gap-2">
              <span className="truncate">{c.name}</span>
              <span className="shrink-0">{c.totalVessels}</span>
            </div>
          ))}
        </div>
      );
    }
    if (id === "trade-balance" && tradeBalance) {
      return (
        <div className="mt-1.5 space-y-1.5 text-[11px] text-neutral-500">
          {tradeBalance.countries.map((c) => (
            <div key={c.reporterIso2}>
              <div className="text-neutral-400">
                {c.reporterName} ({c.period})
              </div>
              {c.topPartners.slice(0, 3).map((p) => (
                <div key={p.partnerName} className="flex justify-between gap-2 pl-2">
                  <span className="truncate">{p.partnerName}</span>
                  <span className="shrink-0">{formatUsd(p.exportValueUsd)}</span>
                </div>
              ))}
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
        <p className="mb-2 font-mono text-[10px] text-red-800">
          All eight pillars are on by default. Untick to narrow the feed to specific categories.
        </p>
        {LAYER_CATEGORIES.map((cat) => {
          const isActive = active.has(cat);
          const pillar = PILLARS[pillarForCategory(cat)];
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
                <span className="flex items-center gap-1.5">
                  <span
                    className={`block font-mono text-xs uppercase tracking-wider ${
                      isActive ? "text-red-300" : "text-neutral-400"
                    }`}
                  >
                    {CATEGORY_LABELS[cat]}
                  </span>
                  <span
                    className="rounded-sm px-1 py-0.5 font-mono text-[8px] uppercase tracking-wider text-black"
                    style={{ backgroundColor: pillar.color }}
                  >
                    {pillar.shortLabel}
                  </span>
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
          Context Layers
        </h2>
        <p className="mb-2 font-mono text-[10px] text-red-800">
          Structural and situational context, not scored events. Flights, Commercial Air Traffic, Weather, GPS Jamming, Submarine Cables, Travel Advisories, Grid Losses, Energy Mix, Trade Balance, Chokepoint Traffic, Air Quality, and Cyber (Actively Exploited Vulnerabilities, plotted by vendor headquarters — a proxy, not the real exploitation location) all render as points on the globe (toggle one, then look at the map) and preview here; GDP/Population/Telegram/Food Price Index are ticker-only for now.
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
