"use client";

import FeedPanel from "./FeedPanel";
import CountryRiskPanel from "./CountryRiskPanel";
import LayersDashboard from "./LayersDashboard";
import LiveWirePanel from "./LiveWirePanel";
import TrendsPanel from "./TrendsPanel";
import ConnectionStatus from "./ConnectionStatus";
import type { ConnectionState } from "@/lib/useEventStream";
import type { GeoEvent } from "@/lib/types";
import type { Category } from "@/lib/categories";
import type { CountryRiskScore } from "@/lib/useCountryRisk";
import type { DataLayerId } from "@/lib/dataLayers";
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

export type DashboardTab = "feed" | "risk" | "layers" | "forex" | "trends";

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

interface DashboardProps {
  activeTab: DashboardTab;
  onTabChange: (tab: DashboardTab) => void;
  showTabBar?: boolean;

  events: GeoEvent[];
  feedLoading?: boolean;
  selectedEventId: number | null;
  onSelectEvent: (event: GeoEvent) => void;

  countryScores: CountryRiskScore[];
  selectedCountry: string | null;
  onSelectCountry: (country: string | null) => void;

  activeCategories: Set<Category>;
  onToggleCategory: (cat: Category) => void;
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

  forex: ForexResponse | null;
  cftc: CftcResponse | null;

  connectionStatus: ConnectionState;
}

const TAB_META: { id: DashboardTab; label: string; dot: string }[] = [
  { id: "feed", label: "Feed", dot: "bg-red-500" },
  { id: "risk", label: "Pulse", dot: "bg-orange-500" },
  { id: "layers", label: "Layers", dot: "bg-sky-400" },
  { id: "forex", label: "Live Wire", dot: "bg-emerald-500" },
  { id: "trends", label: "Trends", dot: "bg-violet-400" },
];

export default function Dashboard(props: DashboardProps) {
  const { activeTab, onTabChange, showTabBar = true } = props;

  const tabCount: Record<DashboardTab, number> = {
    feed: props.events.length,
    risk: props.countryScores.length,
    layers: props.activeDataLayers.size,
    forex: props.forex?.rates.length ?? 0,
    trends: 0,
  };

  return (
    <div className="flex h-full flex-col">
      {showTabBar && (
        <div className="flex shrink-0 items-center justify-end border-b border-red-950/50 px-3 py-1.5">
          <ConnectionStatus status={props.connectionStatus} />
        </div>
      )}
      {showTabBar && (
        <div className="flex shrink-0 border-b border-red-950">
          {TAB_META.map((tab) => {
            const isActive = activeTab === tab.id;
            const count = tabCount[tab.id];
            return (
              <button
                key={tab.id}
                onClick={() => onTabChange(tab.id)}
                className={`flex flex-1 flex-col items-center gap-1.5 py-2.5 font-mono text-[10px] uppercase tracking-wider transition ${
                  isActive
                    ? "text-red-300"
                    : "text-neutral-600 hover:text-red-700"
                }`}
              >
                <span className="flex items-center gap-1.5">
                  <span className={`h-1.5 w-1.5 rounded-full ${tab.dot}`} />
                  {tab.label}
                  {count > 0 && <span className="text-neutral-600">{count}</span>}
                </span>
                <span
                  className={`h-0.5 w-8 rounded-full transition ${
                    isActive
                      ? "bg-red-500 shadow-[0_0_6px_rgba(255,0,0,0.6)]"
                      : "bg-transparent"
                  }`}
                />
              </button>
            );
          })}
        </div>
      )}
      <div className="min-h-0 flex-1">
        {activeTab === "feed" && (
          <div className="flex h-full flex-col">
            {props.selectedCountry && (
              <div className="flex shrink-0 items-center justify-between border-b border-red-950/70 bg-red-950/20 px-4 py-2">
                <span className="font-mono text-[11px] uppercase tracking-wider text-red-300">
                  Showing: {countryName(props.selectedCountry)}
                </span>
                <button
                  onClick={() => props.onSelectCountry(null)}
                  className="font-mono text-[11px] text-neutral-500 hover:text-red-400"
                  aria-label="Clear country filter"
                >
                  ✕ clear
                </button>
              </div>
            )}
            <div className="min-h-0 flex-1">
              <FeedPanel
                events={props.events}
                loading={props.feedLoading}
                selectedId={props.selectedEventId}
                onSelect={props.onSelectEvent}
              />
            </div>
          </div>
        )}
        {activeTab === "risk" && (
          <CountryRiskPanel
            scores={props.countryScores}
            selectedCountry={props.selectedCountry}
            onSelectCountry={props.onSelectCountry}
          />
        )}
        {activeTab === "layers" && (
          <LayersDashboard
            active={props.activeCategories}
            onToggle={props.onToggleCategory}
            activeDataLayers={props.activeDataLayers}
            onToggleDataLayer={props.onToggleDataLayer}
            flights={props.flights}
            commercialFlights={props.commercialFlights}
            commercialFlightsError={props.commercialFlightsError}
            weather={props.weather}
            gdp={props.gdp}
            population={props.population}
            cyber={props.cyber}
            telegram={props.telegram}
          />
        )}
        {activeTab === "forex" && (
          <LiveWirePanel
            selectedCountry={props.selectedCountry}
            forex={props.forex}
            cftc={props.cftc}
          />
        )}
        {activeTab === "trends" && (
          <TrendsPanel countryScores={props.countryScores} />
        )}
      </div>
    </div>
  );
}
