import { getDb } from "@/db";
import { sanctionsEntry, sanctionsDelta } from "@/db/schema";
import { eq, sql, desc, and, gte, inArray } from "drizzle-orm";
import { ALPHA2_TO_ALPHA3 } from "@/lib/iso3";
import {
  fetchOfacSdn,
  fetchEuConsolidated,
  type SanctionsList,
  type SanctionsSnapshot,
} from "@/lib/sources/sanctions";

// Sanctions designation deltas (2026-09-22).
//
// Neither OFAC nor the EU publishes a "what changed" feed, so the change
// IS the product here: each run fetches the full list, diffs it against
// the membership stored from last time, records what was added and
// removed, and replaces the membership. A designation is the cleanest
// signal this whole system handles — hard, dated, attributable, and
// requiring no interpretation — which is exactly why it is worth the
// round trip through a 25 MB file.
//
// Storage shape follows from that. `sanctions_entry` holds only (list,
// entry_id) for the ~25,600 current designations, because membership is
// all the diff needs: two short text columns, not a mirror of someone
// else's database. Names and programmes are captured on the DELTA rows,
// where they describe a specific change at a specific time and stay
// correct even after the publisher revises the entry.
//
// Not wired into country risk scoring. Doing that means a new event
// category, which changes every country's score and touches the
// classifier, the pillars and the risk model's features — a deliberate
// separate change, not a side effect of adding a source. This ships as
// context, the same way travel advisories, chokepoint transits and trade
// balances did before being scored.

// OFAC programme code -> ISO 3166-1 alpha-2, for the country-specific
// programmes. Thematic programmes (SDGT, SDNT, CYBER2, TCO, NPWMD) have
// no country by design and stay null rather than being forced onto one:
// a global terrorism designation is not a signal about the United States.
//
// Matched by prefix, because OFAC suffixes programmes with the executive
// order that authorised them ("UKRAINE-EO13662", "IRAN-EO13902").
const OFAC_PROGRAM_COUNTRY: [string, string][] = [
  ["BALKANS", "RS"],
  ["BELARUS", "BY"],
  ["BURMA", "MM"],
  ["CAR", "CF"],
  ["CUBA", "CU"],
  ["DARFUR", "SD"],
  ["DRCONGO", "CD"],
  ["ETHIOPIA", "ET"],
  ["HK-EO13936", "HK"],
  ["IFSR", "IR"],
  ["IRAN", "IR"],
  ["IRAQ", "IQ"],
  ["LEBANON", "LB"],
  ["LIBYA", "LY"],
  ["MALI", "ML"],
  ["NICARAGUA", "NI"],
  ["DPRK", "KP"],
  ["RUSSIA", "RU"],
  ["SOMALIA", "SO"],
  ["SOUTH SUDAN", "SS"],
  ["SUDAN", "SD"],
  ["SYRIA", "SY"],
  ["UKRAINE", "UA"],
  ["VENEZUELA", "VE"],
  ["YEMEN", "YE"],
  ["ZIMBABWE", "ZW"],
];

const ALPHA3_TO_ALPHA2: Record<string, string> = Object.fromEntries(
  Object.entries(ALPHA2_TO_ALPHA3).map(([a2, a3]) => [a3, a2]),
);

// The EU labels most programmes with an ISO3 country code (IRQ, BLR, IRN)
// and the rest thematically (TERR, TAQA, CYB) — the same distinction OFAC
// draws, in a different alphabet.
function euProgramCountry(program: string | null): string | null {
  if (!program) return null;
  const code = program.trim().toUpperCase();
  return ALPHA3_TO_ALPHA2[code] ?? null;
}

function ofacProgramCountry(program: string | null): string | null {
  if (!program) return null;
  const upper = program.toUpperCase();
  // An entry can sit under several programmes; the first country-bearing
  // one wins, and a purely thematic entry stays null.
  for (const part of upper.split(",").map((p) => p.trim())) {
    for (const [prefix, iso2] of OFAC_PROGRAM_COUNTRY) {
      if (part.startsWith(prefix)) return iso2;
    }
  }
  return null;
}

export function programCountry(list: SanctionsList, program: string | null): string | null {
  return list === "ofac" ? ofacProgramCountry(program) : euProgramCountry(program);
}

// A publication that changes more of a list than this is treated as a
// format change or a truncated download, not as news: the deltas are
// discarded and the membership is left alone for a human to look at.
// Without this, one upstream schema change would write tens of thousands
// of phantom "removed" rows and they would read as a real event.
const MAX_PLAUSIBLE_CHURN = 0.25;

export interface SanctionsSyncResult {
  list: SanctionsList;
  fetched: number;
  added: number;
  removed: number;
  firstRun: boolean;
  skippedImplausibleChurn: boolean;
  publishedAt: string | null;
}

async function syncOne(snapshot: SanctionsSnapshot): Promise<SanctionsSyncResult> {
  const db = getDb();
  const { list, entries, publishedAt } = snapshot;

  const previous = await db
    .select({ entryId: sanctionsEntry.entryId })
    .from(sanctionsEntry)
    .where(eq(sanctionsEntry.list, list));
  const previousIds = new Set(previous.map((r) => r.entryId));
  const currentIds = new Set(entries.map((e) => e.entryId));
  const firstRun = previousIds.size === 0;

  const added = entries.filter((e) => !previousIds.has(e.entryId));
  const removedIds = [...previousIds].filter((id) => !currentIds.has(id));

  // A first run has nothing to compare against: record the membership and
  // report no changes, rather than announcing 19,393 new designations.
  if (!firstRun) {
    const churn = (added.length + removedIds.length) / Math.max(previousIds.size, 1);
    if (churn > MAX_PLAUSIBLE_CHURN) {
      return {
        list,
        fetched: entries.length,
        added: 0,
        removed: 0,
        firstRun: false,
        skippedImplausibleChurn: true,
        publishedAt,
      };
    }
  }

  const detectedAt = new Date();
  const deltaRows = firstRun
    ? []
    : [
        ...added.map((e) => ({
          list,
          entryId: e.entryId,
          change: "added" as const,
          name: e.name,
          entityType: e.entityType,
          program: e.program,
          country: programCountry(list, e.program),
          publishedAt,
          detectedAt,
        })),
        // A removal is known only by its id — the entry is gone from the
        // file, so its name has to come from what was last seen. The
        // membership table deliberately does not store names, so a removal
        // records the id and leaves the name null rather than inventing
        // one. Delisting matters less than listing and is rare.
        ...removedIds.map((id) => ({
          list,
          entryId: id,
          change: "removed" as const,
          name: null,
          entityType: null,
          program: null,
          country: null,
          publishedAt,
          detectedAt,
        })),
      ];

  const CHUNK = 500;
  for (let i = 0; i < deltaRows.length; i += CHUNK) {
    await db.insert(sanctionsDelta).values(deltaRows.slice(i, i + CHUNK));
  }

  // Replace membership: insert what is new, delete what is gone. Cheaper
  // and less destructive than clearing the list and rewriting 19k rows
  // every week, and it leaves the table intact if a later step fails.
  for (let i = 0; i < added.length; i += CHUNK) {
    await db
      .insert(sanctionsEntry)
      .values(added.slice(i, i + CHUNK).map((e) => ({ list, entryId: e.entryId })))
      .onConflictDoNothing();
  }
  for (let i = 0; i < removedIds.length; i += CHUNK) {
    const batch = removedIds.slice(i, i + CHUNK);
    await db
      .delete(sanctionsEntry)
      .where(and(eq(sanctionsEntry.list, list), inArray(sanctionsEntry.entryId, batch)));
  }

  return {
    list,
    fetched: entries.length,
    added: firstRun ? 0 : added.length,
    removed: firstRun ? 0 : removedIds.length,
    firstRun,
    skippedImplausibleChurn: false,
    publishedAt,
  };
}

// Each list is independent: OFAC being unreachable must not stop the EU
// list syncing, the same posture ingest.ts takes with its own sources.
export async function syncSanctions(): Promise<{
  results: SanctionsSyncResult[];
  errors: string[];
}> {
  const errors: string[] = [];
  const results: SanctionsSyncResult[] = [];
  for (const [label, fetcher] of [
    ["ofac", fetchOfacSdn],
    ["eu", fetchEuConsolidated],
  ] as const) {
    try {
      results.push(await syncOne(await fetcher()));
    } catch (err) {
      errors.push(`${label}: ${err}`);
    }
  }
  return { results, errors };
}

export interface SanctionsDeltaView {
  list: string;
  change: string;
  name: string | null;
  entityType: string | null;
  program: string | null;
  country: string | null;
  detectedAt: string;
}

const RECENT_WINDOW_DAYS = 120;

export async function getRecentSanctionsDeltas(limit = 200): Promise<SanctionsDeltaView[]> {
  const db = getDb();
  const since = new Date(Date.now() - RECENT_WINDOW_DAYS * 24 * 60 * 60_000);
  const rows = await db
    .select({
      list: sanctionsDelta.list,
      change: sanctionsDelta.change,
      name: sanctionsDelta.name,
      entityType: sanctionsDelta.entityType,
      program: sanctionsDelta.program,
      country: sanctionsDelta.country,
      detectedAt: sanctionsDelta.detectedAt,
    })
    .from(sanctionsDelta)
    .where(gte(sanctionsDelta.detectedAt, since))
    .orderBy(desc(sanctionsDelta.detectedAt), desc(sanctionsDelta.id))
    .limit(limit);
  return rows.map((r) => ({ ...r, detectedAt: r.detectedAt.toISOString() }));
}
