// Response shapes returned by src/app/api/layers/*/route.ts — shared
// between page.tsx (which polls them via useLiveLayer) and
// LayersDashboard.tsx (which renders the inline ticker previews).
import type { TrackedAircraft } from "@/lib/sources/adsblol";
import type { WeatherSnapshot } from "@/lib/sources/openmeteo";
import type { WorldBankObservation } from "@/lib/sources/worldbank";
import type { CftcPosition } from "@/lib/sources/cftc";
import type { KevEntry } from "@/lib/sources/cisakev";
import type { GpsJammingSummary } from "@/lib/sources/gpsjam";
import type { SubmarineCableSummary } from "@/lib/sources/submarineCables";
import type { TravelAdvisory } from "@/lib/sources/travelAdvisories";
import type { OwidEnergyCountry } from "@/lib/sources/owidEnergy";
import type { FaoFoodPriceIndex } from "@/lib/sources/faoFoodPrice";
import type { AirQualityReading } from "@/lib/sources/openMeteoAirQuality";
import type { ChokepointTransit } from "@/lib/sources/portwatch";
import type { CountryTradeSummary } from "@/lib/sources/comtrade";
import type { CommodityPrice } from "@/lib/sources/commodities";

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
  // Set when the underlying withCache call itself throws (individual hub
  // queries in fetchAdsbLolCommercial already catch their own failures and
  // resolve to zero aircraft for that hub, so this is a rarer, more total
  // failure) — surfaced instead of masking it, same principle as GDELT's
  // 429 fix elsewhere in this app.
  error?: string;
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

export interface CommodityResponse {
  commodities: CommodityPrice[];
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

export interface GpsJammingResponse {
  summary: GpsJammingSummary | null;
}

export interface SubmarineCablesResponse {
  summary: SubmarineCableSummary | null;
}

export interface TravelAdvisoriesResponse {
  advisories: TravelAdvisory[];
}

export interface GridLossResponse {
  countries: WorldBankObservation[];
}

export interface EnergyMixResponse {
  countries: OwidEnergyCountry[];
}

export interface FoodPriceIndexResponse {
  index: FaoFoodPriceIndex | null;
}

export interface AirQualityResponse {
  readings: AirQualityReading[];
}

export interface PortCongestionResponse {
  chokepoints: ChokepointTransit[];
}

export interface TradeBalanceResponse {
  countries: CountryTradeSummary[];
}
