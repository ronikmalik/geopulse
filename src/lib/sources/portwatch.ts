// IMF PortWatch — daily vessel-transit counts through the world's 28 major
// maritime chokepoints (straits/canals), hosted as a public ArcGIS
// FeatureServer, no key. Verified live 2026-09-08: `allowAnonymousToQuery`
// is true and a real query returns real current data (Kerch Strait
// showing 0 transits, Strait of Hormuz showing single digits vs.
// Malacca's low hundreds, on the day checked) — genuinely current, not a
// stale demo dataset. Updated weekly (Tuesdays, per IMF's own
// methodology page) from satellite AIS ship-tracking, so don't expect
// daily granularity to actually change daily.
//
// This is a raw transit COUNT, not a normalized "congestion index" — IMF
// doesn't publish one at chokepoint granularity, so this file doesn't
// invent one. A meaningful read requires comparing today's count against
// that same chokepoint's own baseline (Magellan Strait naturally sees a
// handful of ships a day; Malacca sees hundreds — comparing the two
// directly is meaningless). No historical baseline is computed here yet;
// this ships the raw current snapshot, sorted low-to-high as a rough
// "quietest chokepoints" hint, with a real trend comparison as a
// natural follow-up once there's a few weeks of snapshots to compare
// against.
//
// License: IMF's own ArcGIS service metadata has no copyrightText set and
// portwatch.imf.org's methodology page didn't surface explicit terms on a
// static fetch (likely JS-rendered) — flagged unclear, same treatment as
// IODA/GDACS elsewhere in this app's registry, not independently
// re-verified as commercially clear.
const PORTWATCH_ENDPOINT =
  "https://services9.arcgis.com/weJ1QsnbMYJlCHdG/ArcGIS/rest/services/Daily_Chokepoints_Data/FeatureServer/0/query";
// `Daily_Chokepoints_Data` is a plain attribute table (portname + daily
// counts) — verified live: requesting returnGeometry=true against it comes
// back with no geometry field at all, no geometryType in the service
// metadata either, i.e. genuinely non-spatial. The actual chokepoint
// locations live in a separate static reference layer, `PortWatch_
// chokepoints_database` (28 rows, real lat/lon columns, esriGeometryPoint),
// joined here by `portname` — the two datasets share that exact string
// value, confirmed live.
const CHOKEPOINT_LOCATIONS_ENDPOINT =
  "https://services9.arcgis.com/weJ1QsnbMYJlCHdG/ArcGIS/rest/services/PortWatch_chokepoints_database/FeatureServer/0/query";
const REQUEST_TIMEOUT_MS = 15_000;

export interface ChokepointTransit {
  name: string;
  totalVessels: number;
  cargoVessels: number;
  tankerVessels: number;
  date: string; // YYYY-MM-DD
  lat: number;
  lon: number;
}

interface ArcGisFeature<T> {
  attributes: T;
}
interface ArcGisResponse<T> {
  features: ArcGisFeature<T>[];
}

async function queryArcGis<T>(
  endpoint: string,
  params: Record<string, string>,
): Promise<ArcGisFeature<T>[]> {
  const url = `${endpoint}?${new URLSearchParams({ f: "json", ...params }).toString()}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": "geopulse-globe/1.0" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`PortWatch request failed: ${err}`);
  }
  if (!res.ok) {
    console.error(`PortWatch fetch failed: ${res.status}`);
    return [];
  }
  const data = (await res.json()) as ArcGisResponse<T>;
  return data.features ?? [];
}

// The location layer is static reference data (chokepoint identity,
// updated basically never) — fetched once per warm serverless instance
// and kept in memory, same treatment comtrade.ts gives its reporter/
// partner reference lists.
let locationCache: Map<string, { lat: number; lon: number }> | null = null;
async function getChokepointLocations(): Promise<Map<string, { lat: number; lon: number }>> {
  if (locationCache) return locationCache;
  const rows = await queryArcGis<{ portname: string; lat: number; lon: number }>(
    CHOKEPOINT_LOCATIONS_ENDPOINT,
    { where: "1=1", outFields: "portname,lat,lon", returnGeometry: "false" },
  );
  locationCache = new Map(
    rows.map((r) => [r.attributes.portname, { lat: r.attributes.lat, lon: r.attributes.lon }]),
  );
  return locationCache;
}

export async function fetchChokepointTransits(): Promise<ChokepointTransit[]> {
  // Two-step query: the dataset is a rolling daily feed, so "the latest
  // date" has to be discovered rather than assumed (weekends/holidays in
  // the satellite pipeline can leave the most recent date a day or two
  // behind "today"). The `date` field is esriFieldTypeDateOnly, which
  // ArcGIS serializes as a plain "YYYY-MM-DD" string over JSON (verified
  // live 2026-09-08) rather than the epoch-millisecond number regular
  // esriFieldTypeDate columns use elsewhere in Esri's APIs — no Date
  // parsing needed/safe to do here.
  const [latest, locations] = await Promise.all([
    queryArcGis<{ date: string }>(PORTWATCH_ENDPOINT, {
      where: "1=1",
      outFields: "date",
      orderByFields: "date DESC",
      resultRecordCount: "1",
    }),
    getChokepointLocations(),
  ]);
  if (latest.length === 0) return [];
  const latestDateStr = latest[0].attributes.date;

  const rows = await queryArcGis<{
    portname: string;
    n_total: number;
    n_cargo: number;
    n_tanker: number;
  }>(PORTWATCH_ENDPOINT, {
    where: `date = DATE '${latestDateStr}'`,
    outFields: "portname,n_total,n_cargo,n_tanker",
  });

  return rows
    .map((r) => {
      const loc = locations.get(r.attributes.portname);
      if (!loc) return null;
      return {
        name: r.attributes.portname,
        totalVessels: r.attributes.n_total,
        cargoVessels: r.attributes.n_cargo,
        tankerVessels: r.attributes.n_tanker,
        date: latestDateStr,
        lat: loc.lat,
        lon: loc.lon,
      };
    })
    .filter((r): r is ChokepointTransit => r !== null)
    .sort((a, b) => a.totalVessels - b.totalVessels);
}

export interface ChokepointTransitDay {
  name: string;
  date: string; // YYYY-MM-DD
  totalVessels: number;
  cargoVessels: number;
  tankerVessels: number;
}

// One row per chokepoint per day, for a date window (2026-09-22). The
// function above answers "what is happening right now"; this one answers
// "what is normal here", which is the question this data actually needs —
// see this file's header comment, which has said since 2026-09-08 that a
// raw transit count is meaningless without each chokepoint's own baseline
// (Magellan Strait sees a handful of ships a day, Malacca sees hundreds).
//
// The dataset carries daily rows back to 2019-01-01 — 78,960 of them,
// confirmed against the service's own min/max/count statistics — so a
// baseline can be backfilled rather than waited for. `resultRecordCount`
// is capped server-side (2,000 per response by this service's
// maxRecordCount), so this pages with resultOffset until a short page
// comes back, rather than assuming one request returns everything.
//
// No location join here, unlike fetchChokepointTransits: history rows are
// stored against a chokepoint's name and the coordinates are static
// reference data that would be identical on all ~400 rows of each one.
//
// The offset advances by however many rows actually came back, never by
// the page size asked for: this service silently caps a response at its
// own maxRecordCount (1,000, measured — a request for 2,000 returns
// 1,000 with no error and no flag this code reads), so treating a short
// page as "the end" stopped the first backfill at 1,000 of ~11,000 rows.
// Paging ends when a request returns nothing at all.
const HISTORY_PAGE_SIZE = 1000;
const HISTORY_MAX_PAGES = 100; // runaway guard; the whole dataset is ~79k rows

export async function fetchChokepointTransitHistory(sinceDate: string): Promise<ChokepointTransitDay[]> {
  const out: ChokepointTransitDay[] = [];
  let offset = 0;
  for (let page = 0; page < HISTORY_MAX_PAGES; page++) {
    const rows = await queryArcGis<{
      portname: string;
      date: string;
      n_total: number;
      n_cargo: number;
      n_tanker: number;
    }>(PORTWATCH_ENDPOINT, {
      where: `date >= DATE '${sinceDate}'`,
      outFields: "portname,date,n_total,n_cargo,n_tanker",
      orderByFields: "date ASC,portname ASC",
      resultOffset: String(offset),
      resultRecordCount: String(HISTORY_PAGE_SIZE),
    });
    offset += rows.length;
    for (const r of rows) {
      const a = r.attributes;
      // A chokepoint with no reported transits is a real zero, but a row
      // with a null count is a gap in the upstream pipeline — storing it
      // as 0 would teach the baseline that a publishing outage is a
      // blockage, which is exactly the false positive this signal exists
      // to avoid.
      if (a.n_total === null || a.n_total === undefined || !a.date) continue;
      out.push({
        name: a.portname,
        date: a.date,
        totalVessels: a.n_total,
        cargoVessels: a.n_cargo ?? 0,
        tankerVessels: a.n_tanker ?? 0,
      });
    }
    if (rows.length === 0) break;
  }
  return out;
}
