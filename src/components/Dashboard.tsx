"use client";

import FeedPanel from "./FeedPanel";
import CountryRiskPanel from "./CountryRiskPanel";
import LayersDashboard from "./LayersDashboard";
import ForexPanel from "./ForexPanel";
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
  SatellitesResponse,
  CryptoResponse,
  GithubResponse,
  GdpResponse,
  PopulationResponse,
  MacroResponse,
  ForexResponse,
  CftcResponse,
  CyberResponse,
} from "@/lib/dataLayerTypes";

export type DashboardTab = "feed" | "risk" | "layers" | "forex";

interface DashboardProps {
  activeTab: DashboardTab;
  onTabChange: (tab: DashboardTab) => void;
  showTabBar?: boolean;

  events: GeoEvent[];
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
  weather: WeatherResponse | null;
  satellites: SatellitesResponse | null;
  crypto: CryptoResponse | null;
  github: GithubResponse | null;
  gdp: GdpResponse | null;
  population: PopulationResponse | null;
  macro: MacroResponse | null;
  cyber: CyberResponse | null;

  forex: ForexResponse | null;
  cftc: CftcResponse | null;

  connectionStatus: ConnectionState;
}

const TAB_META: { id: DashboardTab; label: string; dot: string }[] = [
  { id: "feed", label: "Feed", dot: "bg-red-500" },
  { id: "risk", label: "Risk", dot: "bg-orange-500" },
  { id: "layers", label: "Layers", dot: "bg-sky-400" },
  { id: "forex", label: "Forex", dot: "bg-emerald-500" },
];

export default function Dashboard(props: DashboardProps) {
  const { activeTab, onTabChange, showTabBar = true } = props;

  const tabCount: Record<DashboardTab, number> = {
    feed: props.events.length,
    risk: props.countryScores.length,
    layers: props.activeDataLayers.size,
    forex: props.forex?.rates.length ?? 0,
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
          <FeedPanel
            events={props.events}
            selectedId={props.selectedEventId}
            onSelect={props.onSelectEvent}
          />
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
            weather={props.weather}
            satellites={props.satellites}
            crypto={props.crypto}
            github={props.github}
            gdp={props.gdp}
            population={props.population}
            macro={props.macro}
            cyber={props.cyber}
          />
        )}
        {activeTab === "forex" && (
          <ForexPanel data={props.forex} cftc={props.cftc} />
        )}
      </div>
    </div>
  );
}
