// STANDALONE / NOT INTEGRATED into the events table — see
// src/lib/sources/README.md. CISA's Known Exploited Vulnerabilities
// catalog, no API key required. This is a global feed (vendor/product, not
// a country), so it can't be geolocated for the country risk model the way
// the other sources are — it's surfaced instead as a "Cyber & Technology"
// ticker layer alongside worldbank.ts's GDP/population layers.
// https://www.cisa.gov/known-exploited-vulnerabilities-catalog
const CISA_KEV_ENDPOINT =
  "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";

export interface KevEntry {
  cveId: string;
  vendorProject: string;
  product: string;
  vulnerabilityName: string;
  dateAdded: string;
  dueDate: string;
  knownRansomwareUse: boolean;
  shortDescription: string;
}

interface CisaKevVulnerability {
  cveID: string;
  vendorProject: string;
  product: string;
  vulnerabilityName: string;
  dateAdded: string;
  dueDate: string;
  knownRansomwareCampaignUse: string;
  shortDescription: string;
}

interface CisaKevResponse {
  catalogVersion: string;
  dateReleased: string;
  count: number;
  vulnerabilities: CisaKevVulnerability[];
}

// Newest-added first, capped — callers decide how many to display.
export async function fetchCisaKev(limit = 15): Promise<KevEntry[]> {
  let res: Response;
  try {
    res = await fetch(CISA_KEV_ENDPOINT, {
      headers: { "User-Agent": "geopulse-globe/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new Error(`CISA KEV request failed: ${err}`);
  }

  if (!res.ok) {
    console.error(`CISA KEV fetch failed: ${res.status}`);
    return [];
  }

  const data = (await res.json()) as CisaKevResponse;

  return [...data.vulnerabilities]
    .sort((a, b) => (a.dateAdded < b.dateAdded ? 1 : -1))
    .slice(0, limit)
    .map((v) => ({
      cveId: v.cveID,
      vendorProject: v.vendorProject,
      product: v.product,
      vulnerabilityName: v.vulnerabilityName,
      dateAdded: v.dateAdded,
      dueDate: v.dueDate,
      knownRansomwareUse: v.knownRansomwareCampaignUse === "Known",
      shortDescription: v.shortDescription,
    }));
}
