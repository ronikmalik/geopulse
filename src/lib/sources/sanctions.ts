// Sanctions designations from the two lists that are both authoritative
// and genuinely open (2026-09-22): the US Treasury's OFAC SDN list and the
// EU's consolidated financial sanctions list.
//
// Why these two and not OpenSanctions, which aggregates far more: its bulk
// data is free for non-commercial use only, and this project's stated
// direction is institutional. OFAC's list is a US government work in the
// public domain and the EU publishes its consolidated list for public
// reuse, so neither creates a licence problem later. The cost of that
// choice is coverage (no UK, UN, or national lists yet) and it is recorded
// here rather than papered over.
//
// Both are fetched whole and diffed against stored membership — see
// src/lib/sanctions.ts. Neither publisher offers a "what changed" feed,
// which is precisely why the diff has to live here.

const OFAC_SDN_CSV = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV";
// Documented public download. The token in the query string is a fixed
// public constant that has been part of the published URL for years, not
// a credential: the same URL is what the EU's own sanctions map links to.
const EU_CONSOLIDATED_CSV =
  "https://webgate.ec.europa.eu/fsd/fsf/public/files/csvFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw";

const FETCH_TIMEOUT_MS = 90_000;

export type SanctionsList = "ofac" | "eu";

export interface SanctionsEntry {
  // Stable per-list identifier. The diff is only as trustworthy as this
  // is: if a publisher renumbered its entries, every row would read as a
  // removal plus an addition. Both publishers treat these as permanent.
  entryId: string;
  name: string;
  // "person" | "entity" | "vessel" | "aircraft" | "unknown" — normalized
  // across the two lists, which spell these differently.
  entityType: string;
  // The publisher's own programme label, verbatim ("CUBA", "SDGT",
  // "RUS"). Not interpreted beyond the country mapping below.
  program: string | null;
}

export interface SanctionsSnapshot {
  list: SanctionsList;
  publishedAt: string | null; // YYYY-MM-DD when the publisher states one
  entries: SanctionsEntry[];
}

async function fetchText(url: string, label: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, {
      // Both endpoints redirect (OFAC to a signed S3 object), so redirects
      // must be followed rather than treated as the response.
      redirect: "follow",
      headers: { "User-Agent": "geopulse-globe/1.0" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`${label} request failed: ${err}`);
  }
  if (!res.ok) throw new Error(`${label} fetch failed: ${res.status}`);
  return await res.text();
}

// Minimal CSV field splitter for one line, handling the quoted fields and
// doubled quotes both publishers emit. Not a general CSV parser: neither
// of these two files embeds a newline inside a quoted field (checked
// against the live files), and pulling in a parser dependency for two
// fixed formats would not clear this project's bar for adding one.
function splitCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

// OFAC writes "-0-" where a field is absent, in every column.
function ofacField(v: string | undefined): string | null {
  const t = (v ?? "").trim();
  if (!t || t === "-0-") return null;
  return t;
}

// An entry under several programmes arrives as one field with the extra
// ones bracket-joined: "IRAN] [SDGT] [IFSR". Normalized to a plain
// comma-separated list so the stored value reads as what it is.
function normalizeOfacProgram(raw: string | null): string | null {
  if (!raw) return null;
  const parts = raw
    .split(/\]\s*\[/)
    .map((p) => p.replace(/[[\]]/g, "").trim())
    .filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
}

function normalizeOfacType(raw: string | null): string {
  if (!raw) return "entity"; // OFAC leaves the type blank for organisations
  const t = raw.toLowerCase();
  if (t.includes("individual")) return "person";
  if (t.includes("vessel")) return "vessel";
  if (t.includes("aircraft")) return "aircraft";
  return "entity";
}

// SDN.CSV is headerless and positional:
// ent_num, SDN_Name, SDN_Type, Program, Title, Call_Sign, Vess_type, ...
export async function fetchOfacSdn(): Promise<SanctionsSnapshot> {
  const text = await fetchText(OFAC_SDN_CSV, "OFAC SDN");
  const entries: SanctionsEntry[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const c = splitCsvLine(line, ",");
    const entryId = ofacField(c[0]);
    const name = ofacField(c[1]);
    // The file ends with a footer row ("-0- ... more info at ...") that has
    // no numeric id; requiring a numeric id drops it without special-casing.
    if (!entryId || !name || !/^\d+$/.test(entryId)) continue;
    if (seen.has(entryId)) continue;
    seen.add(entryId);
    entries.push({
      entryId,
      name,
      entityType: normalizeOfacType(ofacField(c[2])),
      program: normalizeOfacProgram(ofacField(c[3])),
    });
  }
  if (entries.length === 0) throw new Error("OFAC SDN parsed to zero entries");
  // OFAC does not state a publication date inside SDN.CSV itself.
  return { list: "ofac", publishedAt: null, entries };
}

function normalizeEuType(raw: string): string {
  const t = raw.trim().toLowerCase();
  if (t === "person") return "person";
  if (t === "enterprise") return "entity";
  return t || "unknown";
}

// DD/MM/YYYY in the file's own fileGenerationDate column.
function parseEuDate(raw: string | undefined): string | null {
  const m = (raw ?? "").trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

// The EU file is semicolon-delimited with a header row, and carries one
// row per name-alias rather than per entity — ~44k rows collapsing to
// ~6.2k entities. The first alias seen for an entity wins as its display
// name, which is the primary name in the published ordering.
export async function fetchEuConsolidated(): Promise<SanctionsSnapshot> {
  const text = (await fetchText(EU_CONSOLIDATED_CSV, "EU consolidated")).replace(/^﻿/, "");
  const lines = text.split(/\r?\n/);
  const header = splitCsvLine(lines[0] ?? "", ";");
  const col = (name: string) => header.indexOf(name);
  const iId = col("Entity_LogicalId");
  const iName = col("NameAlias_WholeName");
  const iType = col("Entity_SubjectType_ClassificationCode");
  const iProgram = col("Entity_Regulation_Programme");
  const iGenerated = col("fileGenerationDate");
  if (iId < 0 || iName < 0) throw new Error("EU consolidated list: unexpected header layout");

  const byId = new Map<string, SanctionsEntry>();
  let publishedAt: string | null = null;
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const c = splitCsvLine(lines[i], ";");
    const entryId = (c[iId] ?? "").trim();
    if (!entryId) continue;
    if (publishedAt === null && iGenerated >= 0) publishedAt = parseEuDate(c[iGenerated]);
    if (byId.has(entryId)) continue;
    const name = (c[iName] ?? "").trim();
    if (!name) continue;
    byId.set(entryId, {
      entryId,
      name,
      entityType: normalizeEuType(c[iType] ?? ""),
      program: (c[iProgram] ?? "").trim() || null,
    });
  }
  if (byId.size === 0) throw new Error("EU consolidated list parsed to zero entities");
  return { list: "eu", publishedAt, entries: [...byId.values()] };
}
