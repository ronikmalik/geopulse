import { getDb } from "@/db";
import { anomalyFindings, type NewAnomalyFindingRow } from "@/db/schema";
import { getAircraftAnomalyOutcomes } from "@/lib/flightBaseline";
import { getGpsJammingAnomalyOutcomes } from "@/lib/gpsJammingHistory";
import {
  getEventVolumeAnomalyOutcomes,
  getEventVolumeByCategoryAnomalyOutcomes,
} from "@/lib/eventVolumeAnomaly";
import type { AnomalyOutcome } from "@/lib/anomalyBaseline";

// The daily anomaly scan — reads every signal's current outcomes (aircraft
// military/commercial, GPS jamming, event volume by country and by
// country×category), writes qualifying findings into anomaly_findings, and
// reports a per-signal tally including non-anomaly outcomes (insufficient
// baseline, stale) — not just findings. Called by /api/admin/snapshot-flights
// right after that route's own snapshot writes, so aircraft/GPS-jamming
// data for today already exists by the time this runs. Zero new cron
// entries: see that route for why (Vercel's Hobby tier caps cron count,
// this rides the one cron this project already has budget for).
//
// One shared `detectedAt` timestamp for every row this run inserts — see
// the doc comment on anomalyFindings in src/db/schema.ts for why "current
// findings" needs to be read as MAX(detectedAt), not a time window: this
// table has no idempotency guard (a re-run just inserts again, matching
// every other snapshot table's existing posture), and a window would let
// two runs' findings overlap with no way to prefer the newer one.
//
// No transactions: this codebase's Neon driver (neon-http) has none
// anywhere (confirmed via full-repo grep before this was written) — every
// existing write path here does sequential single-table inserts,
// accepting partial-failure risk rather than atomicity. This follows that
// same convention rather than introducing a new pattern.
export interface SignalTally {
  anomalies: number;
  insufficientBaseline: number;
  stale: number;
  normal: number;
}

export interface AnomalyScanResult {
  detectedAt: string;
  findingsInserted: number;
  perSignal: Record<string, SignalTally>;
  errors: string[];
}

function emptyTally(): SignalTally {
  return { anomalies: 0, insufficientBaseline: 0, stale: 0, normal: 0 };
}

function tallyOutcome(tally: SignalTally, outcome: AnomalyOutcome): void {
  if (outcome.status === "anomaly") tally.anomalies++;
  else if (outcome.status === "insufficient-baseline") tally.insufficientBaseline++;
  else if (outcome.status === "stale") tally.stale++;
  else tally.normal++;
}

export async function runAnomalyScan(): Promise<AnomalyScanResult> {
  const detectedAt = new Date();
  const perSignal: Record<string, SignalTally> = {};
  const rows: NewAnomalyFindingRow[] = [];
  const errors: string[] = [];

  // Each signal is independently try/caught — one failing fetch (a source
  // temporarily down, a query timeout) shouldn't block every other
  // signal's scan for the day, same resilience posture as ingest.ts's own
  // Promise.allSettled-style handling of its several sources.
  async function runSignal(
    signalType: string,
    fetchOutcomes: () => Promise<{ country: string; category?: string | null; outcome: AnomalyOutcome }[]>,
  ): Promise<void> {
    const tally = emptyTally();
    perSignal[signalType] = tally;
    try {
      const results = await fetchOutcomes();
      for (const { country, category, outcome } of results) {
        tallyOutcome(tally, outcome);
        if (outcome.status === "anomaly") {
          rows.push({
            detectedAt,
            signalType,
            country,
            category: category ?? null,
            observedValue: outcome.data.observedValue,
            baselineMean: outcome.data.baselineMean,
            baselineStdDev: outcome.data.baselineStdDev,
            sampleSize: outcome.data.sampleSize,
            jump: outcome.data.jump,
            zScore: outcome.data.zScore,
          });
        }
      }
    } catch (err) {
      errors.push(`${signalType}: ${err}`);
    }
  }

  await runSignal("aircraft-military", async () =>
    (await getAircraftAnomalyOutcomes("military")).map((o) => ({ country: o.country, outcome: o.outcome })),
  );
  await runSignal("aircraft-commercial", async () =>
    (await getAircraftAnomalyOutcomes("commercial")).map((o) => ({ country: o.country, outcome: o.outcome })),
  );
  await runSignal("gps-jamming", async () =>
    (await getGpsJammingAnomalyOutcomes()).map((o) => ({ country: o.country, outcome: o.outcome })),
  );
  await runSignal("event-volume", async () =>
    (await getEventVolumeAnomalyOutcomes()).map((o) => ({ country: o.country, outcome: o.outcome })),
  );
  await runSignal("event-volume-category", async () =>
    (await getEventVolumeByCategoryAnomalyOutcomes()).map((o) => ({
      country: o.country,
      category: o.category,
      outcome: o.outcome,
    })),
  );

  let findingsInserted = 0;
  if (rows.length > 0) {
    try {
      const db = getDb();
      const result = await db.insert(anomalyFindings).values(rows).returning({ id: anomalyFindings.id });
      findingsInserted = result.length;
    } catch (err) {
      errors.push(`insert: ${err}`);
    }
  }

  return { detectedAt: detectedAt.toISOString(), findingsInserted, perSignal, errors };
}
