"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import GlobeView from "@/components/Globe";
import CategoryFilter from "@/components/CategoryFilter";
import AlertToast from "@/components/AlertToast";
import Dashboard, { type DashboardTab } from "@/components/Dashboard";
import { useEventStream } from "@/lib/useEventStream";
import { usePulsingEvents } from "@/lib/usePulsingEvents";
import { useCountryRisk } from "@/lib/useCountryRisk";
import { useLiveLayer } from "@/lib/useLiveLayer";
import {
  flightsToPoints,
  commercialFlightsToPoints,
  weatherToPoints,
} from "@/lib/mapPoints";
import { CATEGORIES, type Category } from "@/lib/categories";
import { DATA_LAYER_POLL_MS, type DataLayerId } from "@/lib/dataLayers";
import type {
  FlightsResponse,
  CommercialFlightsResponse,
  WeatherResponse,
  GdpResponse,
  PopulationResponse,
  ForexResponse,
  CftcResponse,
  CyberResponse,
  TelegramLayerResponse,
} from "@/lib/dataLayerTypes";
import type { GeoEvent } from "@/lib/types";

const FOREX_POLL_MS = 5 * 60_000;
const CFTC_POLL_MS = 60 * 60_000;

const MOBILE_TABS: { id: DashboardTab; label: string }[] = [
  { id: "feed", label: "Feed" },
  { id: "risk", label: "Pulse" },
  { id: "layers", label: "Layers" },
  { id: "forex", label: "Live Wire" },
  { id: "trends", label: "Trends" },
];

export default function Home() {
  const { events, status, incoming, dismissIncoming } = useEventStream();
  const pulsingIds = usePulsingEvents(incoming);
  const countryScores = useCountryRisk();
  // All eight pillars' event categories are on by default — this is a
  // global risk platform, not a conflict-theater tracker. The five
  // flashpoint pills in the top bar (CategoryFilter) let a user narrow
  // down; the Layers tab lets them broaden back out if they narrow too far.
  const [activeCategories, setActiveCategories] = useState<Set<Category>>(
    new Set(CATEGORIES),
  );
  const [selected, setSelected] = useState<GeoEvent | null>(null);
  const [selectedCountry, setSelectedCountry] = useState<string | null>(null);
  const [countryFeed, setCountryFeed] = useState<GeoEvent[]>([]);
  const [countryFeedLoading, setCountryFeedLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<DashboardTab>("feed");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [activeDataLayers, setActiveDataLayers] = useState<Set<DataLayerId>>(
    new Set(),
  );

  const filtered = useMemo(
    () => events.filter((e) => activeCategories.has(e.category as Category)),
    [events, activeCategories],
  );

  // Clicking a country on the globe shows its own breaking-news feed —
  // every category for that country, not just whichever ones happen to be
  // toggled on in the main view — rather than the pillar/threat-level
  // breakdown (that view still exists under the Risk tab, just no longer
  // the default click destination).
  //
  // This fetches from the DB (via /api/events) instead of filtering the
  // live SSE buffer: that buffer only ever holds the ~100 most recently
  // inserted events across ALL countries combined (see useEventStream.ts /
  // api/stream/route.ts), so a country whose events had aged out of that
  // shared window would filter to nothing and show "Listening for
  // signals…" even with real history in the DB.
  useEffect(() => {
    // No reset here: feedEvents below already falls back to `filtered`
    // whenever selectedCountry is null, regardless of countryFeed's
    // contents, so stale per-country data is simply never shown.
    if (!selectedCountry) return;
    let cancelled = false;
    // react-hooks/set-state-in-effect flags this, but it's React's own
    // canonical fetch-with-loading-flag pattern — see the identical note
    // in CountryRiskPanel.tsx.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCountryFeedLoading(true);
    fetch(`/api/events?country=${selectedCountry}`)
      .then((res) => res.json())
      .then((data: { events: GeoEvent[] }) => {
        if (!cancelled) setCountryFeed(data.events ?? []);
      })
      .catch(() => {
        if (!cancelled) setCountryFeed([]);
      })
      .finally(() => {
        if (!cancelled) setCountryFeedLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedCountry]);

  const feedEvents = useMemo(
    () => (selectedCountry ? countryFeed : filtered),
    [countryFeed, filtered, selectedCountry],
  );

  const toggleCategory = (cat: Category) => {
    setActiveCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const toggleDataLayer = (id: DataLayerId) => {
    setActiveDataLayers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const flightsLayer = useLiveLayer<FlightsResponse>(
    "/api/layers/flights",
    DATA_LAYER_POLL_MS.flights,
    activeDataLayers.has("flights"),
  );
  const commercialFlightsLayer = useLiveLayer<CommercialFlightsResponse>(
    "/api/layers/commercial-flights",
    DATA_LAYER_POLL_MS["commercial-flights"],
    activeDataLayers.has("commercial-flights"),
  );
  const weatherLayer = useLiveLayer<WeatherResponse>(
    "/api/layers/weather",
    DATA_LAYER_POLL_MS.weather,
    activeDataLayers.has("weather"),
  );
  const gdpLayer = useLiveLayer<GdpResponse>(
    "/api/layers/gdp",
    DATA_LAYER_POLL_MS.gdp,
    activeDataLayers.has("gdp"),
  );
  const populationLayer = useLiveLayer<PopulationResponse>(
    "/api/layers/population",
    DATA_LAYER_POLL_MS.population,
    activeDataLayers.has("population"),
  );
  const cyberLayer = useLiveLayer<CyberResponse>(
    "/api/layers/cyber",
    DATA_LAYER_POLL_MS.cyber,
    activeDataLayers.has("cyber"),
  );
  const telegramLayer = useLiveLayer<TelegramLayerResponse>(
    "/api/layers/telegram",
    DATA_LAYER_POLL_MS.telegram,
    activeDataLayers.has("telegram"),
  );

  // Forex is the app's headline feature, not an opt-in layer — it polls
  // continuously rather than gating behind a checkbox.
  const forexLayer = useLiveLayer<ForexResponse>(
    "/api/layers/forex",
    FOREX_POLL_MS,
    true,
  );
  // CFTC Commitments of Traders — weekly speculative positioning, same
  // always-on treatment as the rates themselves.
  const cftcLayer = useLiveLayer<CftcResponse>(
    "/api/layers/cftc",
    CFTC_POLL_MS,
    true,
  );

  const extraPoints = useMemo(() => {
    const points = [];
    if (activeDataLayers.has("flights") && flightsLayer.data) {
      points.push(...flightsToPoints(flightsLayer.data.aircraft));
    }
    if (activeDataLayers.has("commercial-flights") && commercialFlightsLayer.data) {
      points.push(...commercialFlightsToPoints(commercialFlightsLayer.data.aircraft));
    }
    if (activeDataLayers.has("weather") && weatherLayer.data) {
      points.push(...weatherToPoints(weatherLayer.data.conditions));
    }
    return points;
  }, [
    activeDataLayers,
    flightsLayer.data,
    commercialFlightsLayer.data,
    weatherLayer.data,
  ]);

  const dashboardProps = {
    events: feedEvents,
    feedLoading: Boolean(selectedCountry) && countryFeedLoading,
    selectedEventId: selected?.id ?? null,
    onSelectEvent: (event: GeoEvent) => {
      setSelected(event);
      setMobileOpen(false);
    },
    countryScores,
    selectedCountry,
    onSelectCountry: setSelectedCountry,
    activeCategories,
    onToggleCategory: toggleCategory,
    activeDataLayers,
    onToggleDataLayer: toggleDataLayer,
    flights: flightsLayer.data,
    commercialFlights: commercialFlightsLayer.data,
    commercialFlightsError: commercialFlightsLayer.error,
    weather: weatherLayer.data,
    gdp: gdpLayer.data,
    population: populationLayer.data,
    cyber: cyberLayer.data,
    telegram: telegramLayer.data,
    forex: forexLayer.data,
    cftc: cftcLayer.data,
    connectionStatus: status,
  };

  return (
    <div className="relative h-dvh w-dvw overflow-hidden bg-black">
      <div className="absolute inset-0">
        <GlobeView
          events={filtered}
          onSelect={(event) => {
            setSelected(event);
            setSelectedCountry(null);
            setActiveTab("feed");
            setMobileOpen(false);
          }}
          flyToId={selected?.id ?? null}
          countryScores={countryScores}
          selectedCountry={selectedCountry}
          onCountryClick={(country) => {
            setSelectedCountry(country);
            setActiveTab("feed");
            setMobileOpen(true);
          }}
          extraPoints={extraPoints}
          pulsingIds={pulsingIds}
        />
      </div>

      {/* Top bar */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 p-3 sm:p-4 lg:right-96">
        <div className="pointer-events-auto min-w-0">
          <h1 className="font-mono text-base font-bold tracking-[0.2em] text-red-500 drop-shadow-[0_0_10px_rgba(255,0,0,0.6)] sm:text-lg sm:tracking-[0.3em]">
            GEOPULSE
          </h1>
          <p className="font-mono text-[9px] tracking-widest text-red-800 sm:text-[10px]">
            GLOBAL RISK INTELLIGENCE
          </p>
          <div className="mt-2 -ml-1 max-w-[calc(100vw-1.5rem)] overflow-x-auto pl-1 pb-1 [mask-image:linear-gradient(to_right,black_82%,transparent_100%)] sm:max-w-none sm:overflow-visible sm:[mask-image:none]">
            <CategoryFilter active={activeCategories} onToggle={toggleCategory} />
          </div>
        </div>
      </div>

      {/* Incoming alert toasts */}
      <div className="pointer-events-none absolute inset-x-3 top-24 z-20 flex flex-col gap-2 sm:inset-x-auto sm:right-[26rem] sm:w-80">
        {incoming.slice(-4).map((event, i) => (
          <AlertToast
            key={event.id}
            event={event}
            index={i}
            onDismiss={() => dismissIncoming(event.id)}
            onFocus={() => {
              setSelected(event);
              setSelectedCountry(null);
              setActiveTab("feed");
              setMobileOpen(false);
            }}
          />
        ))}
      </div>

      {/* Desktop dashboard — single tabbed panel, always visible */}
      <div className="absolute bottom-0 right-0 top-0 z-10 hidden w-96 border-l border-red-950 bg-black/85 backdrop-blur-sm lg:block">
        <Dashboard activeTab={activeTab} onTabChange={setActiveTab} {...dashboardProps} />
      </div>

      {/* Mobile bottom-sheet dashboard */}
      {mobileOpen && (
        <div className="absolute inset-x-0 bottom-14 top-24 z-20 rounded-t-xl border-t border-red-950 bg-black/95 backdrop-blur-sm lg:hidden">
          <Dashboard
            activeTab={activeTab}
            onTabChange={setActiveTab}
            showTabBar={false}
            {...dashboardProps}
          />
        </div>
      )}

      {/* Mobile bottom tab bar */}
      <div className="pointer-events-auto absolute inset-x-0 bottom-0 z-20 flex h-14 border-t border-red-950 bg-black/95 backdrop-blur-sm lg:hidden">
        {MOBILE_TABS.map((tab, i) => (
          <Fragment key={tab.id}>
            {i > 0 && <div className="w-px bg-red-950" />}
            <button
              onClick={() => {
                if (mobileOpen && activeTab === tab.id) {
                  setMobileOpen(false);
                } else {
                  setActiveTab(tab.id);
                  setMobileOpen(true);
                }
              }}
              className={`flex flex-1 items-center justify-center font-mono text-xs uppercase tracking-wider transition ${
                mobileOpen && activeTab === tab.id
                  ? "text-red-400"
                  : "text-neutral-500"
              }`}
            >
              {tab.label}
            </button>
          </Fragment>
        ))}
      </div>
    </div>
  );
}
