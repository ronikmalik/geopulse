// Response shapes returned by src/app/api/layers/*/route.ts — shared
// between page.tsx (which polls them via useLiveLayer) and
// LayersDashboard.tsx (which renders the inline ticker previews).
import type { TrackedAircraft } from "@/lib/sources/adsblol";
import type { WeatherSnapshot } from "@/lib/sources/openmeteo";
import type { WorldBankObservation } from "@/lib/sources/worldbank";
import type { CftcPosition } from "@/lib/sources/cftc";
import type { KevEntry } from "@/lib/sources/cisakev";

export interface FlightsResponse {
  aircraft: TrackedAircraft[];
}

export interface WeatherResponse {
  conditions: WeatherSnapshot[];
}

export interface GdpResponse {
  countries: WorldBankObservation[];
}

export interface PopulationResponse {
  countries: WorldBankObservation[];
}

export interface CommercialFlightsResponse {
  aircraft: TrackedAircraft[];
}

export interface ForexRate {
  pair: string;
  rate: number;
  changePct: number;
  date: string;
}

export interface ForexResponse {
  rates: ForexRate[];
}

export interface CftcResponse {
  positions: CftcPosition[];
}

export interface CyberResponse {
  vulnerabilities: KevEntry[];
}

export interface TelegramLayerPost {
  channelLabel: string;
  country: string;
  url: string;
  text: string;
  translated: boolean;
  publishedAt: string;
}

export interface TelegramLayerResponse {
  posts: TelegramLayerPost[];
}
