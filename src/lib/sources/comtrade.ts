// UN Comtrade "preview" tier — no API key, no subscription. Verified live
// 2026-09-08: annual reporter totals exist through period=2025 and monthly
// data through at least 202606 (June 2026), so real lag is roughly 3
// months for monthly figures, not the multi-year lag some UN trade
// products carry. Rate-limited hard enough on rapid-fire requests (a 429
// after 2 back-to-back calls in testing) that this file spaces sequential
// requests rather than firing them concurrently — see fetchTopPartners's
// caller in the route file.
//
// LICENSING — read before expanding this beyond the current use: per UN
// Comtrade's own "FAQs on Use and Re-dissemination" (uncomtrade.org),
// ORIGINAL/raw data is copyrighted and restricted to internal use without
// a paid re-dissemination agreement once redistributed at any real
// volume — but data that's "transformed or substantially different from
// the original" (aggregated, ranked, recombined — not just relabeled) can
// be redistributed without a subscription or fee. What this file exposes
// (a computed "top N trading partners by value" ranking, derived from the
// raw per-partner rows) is designed to sit inside that carve-out, not to
// pass through raw Comtrade rows — this hasn't been independently
// confirmed by counsel, just read carefully against UN Comtrade's own
// published FAQ, same "verified against the primary source, disclosed
// honestly" standard as every other borderline-licensed source in this
// registry (IODA, GDACS, Finnhub, PortWatch).
const COMTRADE_BASE = "https://comtradeapi.un.org/public/v1/preview";
const REPORTERS_ENDPOINT = "https://comtradeapi.un.org/files/v1/app/reference/Reporters.json";
// Partner-side codes include regions/groups ("Other Asia, nes", etc.) that
// aren't valid reporters — a separate reference list, not just the same
// Reporters.json read from the other side, so partner-name resolution
// uses this one instead.
const PARTNER_AREAS_ENDPOINT =
  "https://comtradeapi.un.org/files/v1/app/reference/partnerAreas.json";
const REQUEST_TIMEOUT_MS = 15_000;

export interface TradePartner {
  partnerIso2: string | null;
  partnerName: string;
  exportValueUsd: number;
}

export interface CountryTradeSummary {
  reporterIso2: string;
  reporterName: string;
  period: string;
  topPartners: TradePartner[];
}

interface ReporterRef {
  reporterCode: number;
  reporterDesc: string;
  reporterCodeIsoAlpha2?: string;
}

interface PartnerRef {
  PartnerCode: number;
  PartnerDesc: string;
  PartnerCodeIsoAlpha2?: string;
}

let reporterCache: ReporterRef[] | null = null;
let partnerCache: PartnerRef[] | null = null;

// Both reference lists are essentially static (UN reporter/partner code
// assignments), so each is fetched once per warm serverless instance and
// kept in memory — no TTL needed, unlike the actual trade-value data.
async function getReporters(): Promise<ReporterRef[]> {
  if (reporterCache) return reporterCache;
  const res = await fetch(REPORTERS_ENDPOINT, {
    headers: { "User-Agent": "geopulse-globe/1.0" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Comtrade reporters reference fetch failed: ${res.status}`);
  const data = (await res.json()) as { results: ReporterRef[] };
  reporterCache = data.results;
  return reporterCache;
}

async function getPartnerAreas(): Promise<PartnerRef[]> {
  if (partnerCache) return partnerCache;
  const res = await fetch(PARTNER_AREAS_ENDPOINT, {
    headers: { "User-Agent": "geopulse-globe/1.0" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Comtrade partner-areas reference fetch failed: ${res.status}`);
  const data = (await res.json()) as { results: PartnerRef[] };
  partnerCache = data.results;
  return partnerCache;
}

function iso2ToM49(reporters: ReporterRef[], iso2: string): ReporterRef | null {
  return reporters.find((r) => r.reporterCodeIsoAlpha2 === iso2.toUpperCase()) ?? null;
}

// Most recent full calendar year — annual reporter totals lag less than a
// year (2025 data was already available when checked live in September
// 2026), and annual figures are a steadier "who trades with whom" signal
// than any single month for a ranked-partners display.
function mostRecentAnnualPeriod(): string {
  return String(new Date().getUTCFullYear() - 1);
}

// Some reporters simply have no self-reported data for recent years —
// verified live: Russia (reporterCode 643) has 200 partner rows for 2021
// but zero for 2023 onward, matching the well-documented post-2022 halt
// in Russia's detailed customs trade publishing. This returns an empty
// topPartners array in that case (a real, honestly-reportable "this
// country stopped disclosing its trade data" signal in its own right,
// not a bug) rather than throwing. A future improvement could derive a
// mirror estimate from partner countries' own reported imports FROM this
// reporter instead of the reporter's own figures — not implemented here,
// out of scope for a first integration pass.
export async function fetchTopTradePartners(
  iso2: string,
  limit = 5,
): Promise<CountryTradeSummary | null> {
  const [reporters, partners] = await Promise.all([getReporters(), getPartnerAreas()]);
  const reporter = iso2ToM49(reporters, iso2);
  if (!reporter) return null;

  const period = mostRecentAnnualPeriod();
  const params = new URLSearchParams({
    reporterCode: String(reporter.reporterCode),
    period,
    cmdCode: "TOTAL",
    flowCode: "X", // exports — who a country actually sells to, the more
    // geopolitically legible half of "trade exposure" (imports are a
    // fine follow-up if this proves useful).
    partnerCode: "", // omitted = every partner in one call, not one call
    // per partner — keeps this to a single request per reporter country.
  });

  let res: Response;
  try {
    res = await fetch(`${COMTRADE_BASE}/C/A/HS?${params.toString()}`, {
      headers: { "User-Agent": "geopulse-globe/1.0" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`Comtrade request failed: ${err}`);
  }
  if (!res.ok) {
    console.error(`Comtrade fetch failed for ${iso2}: ${res.status}`);
    return null;
  }

  const body = (await res.json()) as {
    data?: { partnerCode: number; fobvalue: number | null }[];
    error?: string;
  };
  if (body.error) {
    console.error(`Comtrade error for ${iso2}: ${body.error}`);
    return null;
  }

  const topPartners = (body.data ?? [])
    .filter((r) => r.partnerCode !== 0 && r.fobvalue != null) // partnerCode 0 = "World" aggregate, not a real partner
    .sort((a, b) => (b.fobvalue ?? 0) - (a.fobvalue ?? 0))
    .slice(0, limit)
    .map((r) => {
      const partnerRef = partners.find((ref) => ref.PartnerCode === r.partnerCode);
      return {
        partnerIso2: partnerRef?.PartnerCodeIsoAlpha2 ?? null,
        partnerName: partnerRef?.PartnerDesc ?? `Code ${r.partnerCode}`,
        exportValueUsd: r.fobvalue ?? 0,
      };
    });

  return {
    reporterIso2: iso2.toUpperCase(),
    reporterName: reporter.reporterDesc,
    period,
    topPartners,
  };
}
