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
// Thresholds are deliberately high: IODA flags routine background noise
// (an ISP maintenance window, a transient BGP blip) as an "event" far more
// readily than it flags an actual government-imposed shutdown or targeted
// disruption, and this pillar was drowning out real signal from the other
// pillars by reporting on nearly every country nearly every day at a
// nonzero severity for exactly that reason.
const MIN_REPORTABLE_EVENT_COUNT = 5;

function eventCountSeverity(eventCount: number): number {
  if (eventCount >= 20) return 4;
  if (eventCount >= 10) return 3;
  return 2;
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

  // Ingest can now run every ~10 minutes (see the stream route's
  // background trigger) but this is a rolling 24h summary, not a discrete
  // new event each time. The dedup key MUST be stable across calls within
  // the same day — it previously embedded `from`/`until`, which change on
  // every single call (they're derived from Date.now() above), so despite
  // intending a once-per-day cap, every ingest run was generating a
  // "new" URL and re-inserting the same ongoing signal, compounding a
  // country's decayed risk score upward indefinitely. The dedup URL now
  // carries nothing but the country and the UTC day, so it's byte-for-byte
  // identical across every call on the same day and `onConflictDoNothing`
  // (on `events.url`, see ingest.ts) actually catches the repeat.
  const dayBucket = new Date().toISOString().slice(0, 10);

  return data.data
    .filter((row) => row.event_cnt >= MIN_REPORTABLE_EVENT_COUNT)
    .map((row): DirectItem | null => {
      const code = row.entity.code?.toUpperCase();
      const centroid = code ? COUNTRY_CENTROIDS[code] : undefined;
      if (!centroid) return null;

      const severity = eventCountSeverity(row.event_cnt);
      return {
        source: "ioda",
        // IODA has no per-event permalink; link to the country's live
        // dashboard page. Deliberately excludes `from`/`until` — see the
        // dedup-stability comment above.
        url: `https://ioda.inetintel.cc.gatech.edu/country/${code}?date=${dayBucket}`,
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
