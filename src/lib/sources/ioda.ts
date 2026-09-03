import { COUNTRY_CENTROIDS } from "@/lib/countryCentroids";
import type { DirectItem } from "./direct";

// IODA (Internet Outage Detection and Analysis), Georgia Tech / CAIDA —
// country-level internet outage signal derived from active probing +
// BGP + darknet traffic, no API key required.
// https://ioda.inetintel.cc.gatech.edu/ · https://api.ioda.inetintel.cc.gatech.edu
const IODA_ENDPOINT = "https://api.ioda.inetintel.cc.gatech.edu/v2/outages/summary";

// IODA reports outage magnitude as an unbounded, per-country-baseline
// score that isn't comparable across countries (a small country's total
// traffic is a fraction of a large one's) — so severity here is driven by
// `event_cnt` (the count of distinct detected outage events in the
// window), a discrete, source-attested number, rather than the raw score.
function eventCountSeverity(eventCount: number): number {
  if (eventCount >= 8) return 4;
  if (eventCount >= 4) return 3;
  if (eventCount >= 2) return 2;
  return 1;
}

interface IodaEntity {
  code: string;
  name: string;
  type: string;
}

interface IodaSummaryRow {
  scores: Record<string, number>;
  event_cnt: number;
  entity: IodaEntity;
}

interface IodaSummaryResponse {
  error: { message?: string } | null;
  data: IodaSummaryRow[] | null;
}

const LOOKBACK_SECONDS = 24 * 60 * 60;

export async function fetchIodaOutages(): Promise<DirectItem[]> {
  const until = Math.floor(Date.now() / 1000);
  const from = until - LOOKBACK_SECONDS;
  const params = new URLSearchParams({
    from: String(from),
    until: String(until),
    entityType: "country",
    limit: "25",
  });

  let res: Response;
  try {
    res = await fetch(`${IODA_ENDPOINT}?${params.toString()}`, {
      headers: { "User-Agent": "geopulse-globe/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new Error(`IODA request failed: ${err}`);
  }

  if (!res.ok) {
    console.error(`IODA fetch failed: ${res.status}`);
    return [];
  }

  const data = (await res.json()) as IodaSummaryResponse;
  if (data.error || !data.data) return [];

  // Ingest runs every ~15 minutes (see ingest.ts) but this is a rolling
  // 24h summary, not a discrete new event each time — without a stable
  // dedup key, a single ongoing outage would re-insert as a "new" row
  // every cycle and blow up a country's decayed risk score. Bucketing
  // the dedup URL by UTC day caps it at one row per country per day;
  // `events.url` is the unique constraint ingest.ts dedupes on.
  const dayBucket = new Date().toISOString().slice(0, 10);

  return data.data
    .filter((row) => row.event_cnt > 0)
    .map((row): DirectItem | null => {
      const code = row.entity.code?.toUpperCase();
      const centroid = code ? COUNTRY_CENTROIDS[code] : undefined;
      if (!centroid) return null;

      const severity = eventCountSeverity(row.event_cnt);
      return {
        source: "ioda",
        // IODA has no per-event permalink; link to the country's live
        // dashboard page, which shows exactly the events this summarizes.
        url: `https://ioda.inetintel.cc.gatech.edu/country/${code}?from=${from}&until=${until}#${dayBucket}`,
        title: `${row.entity.name}: internet connectivity disruption`,
        summary: `IODA detected ${row.event_cnt} distinct outage signal${row.event_cnt === 1 ? "" : "s"} for ${row.entity.name} in the last 24h (BGP/active-probing/darknet traffic anomaly).`,
        category: "infrastructure-outage",
        location: row.entity.name,
        country: code,
        lat: centroid.lat,
        lon: centroid.lon,
        severity,
        publishedAt: new Date(),
      };
    })
    .filter((item): item is DirectItem => item !== null);
}
