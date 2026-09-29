import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseTsunamiAtom,
  withTsunamiStatus,
  matchBulletinToQuake,
  type TsunamiBulletin,
} from "../src/lib/sources/tsunami";
import { summarizeOoni } from "../src/lib/sources/ooni";
import { parseRadarOutages, radarOutagesToItems } from "../src/lib/sources/cloudflareRadar";
import { nearestMajorPort, MAJOR_PORTS } from "../src/lib/ports";
import { COUNTRY_CENTROIDS } from "../src/lib/countryCentroids";
import { internetCensorshipToPoints } from "../src/lib/mapPoints";
import { DATA_LAYERS, DATA_LAYER_GROUPS } from "../src/lib/dataLayers";
import { canonicalGdacsUrl, fetchGdacsAlerts } from "../src/lib/sources/gdacs";

// Trimmed from the live NTWC and PTWC feeds (tsunami.gov, 2026-09-28).
const NTWC = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:geo="http://www.w3.org/2003/01/geo/wgs84_pos#">
<title>Tsunami Information Statement Number 1</title>
<entry>
<title>95 miles W of Port Alice, British Columbia</title><updated>2026-09-28T09:20:44Z</updated>
<geo:lat>50.327</geo:lat>
<geo:long>-129.358</geo:long>
<summary type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">
<strong>Category:</strong> Information<br/><strong>Bulletin Issue Time: </strong> 2026.09.28 09:20:44 UTC <br/><strong>Preliminary Magnitude: </strong>5.0(mb)<br/><strong>Lat/Lon: </strong>50.327 / -129.358<br/><strong>Affected Region: </strong>95 miles W of Port Alice, British Columbia<br/><b>Note:</b>  * There is NO tsunami danger from this earthquake.<br/><strong>Definition: </strong>An information statement indicates...</div></summary>
</entry>
</feed>`;
const PTWC = `<feed><entry>
<title>ABOUT 83 MILES WEST OF ISLA MONA</title><updated>2026-09-27T21:56:18Z</updated>
<geo:lat>18.483</geo:lat>
<geo:long>-69.134</geo:long>
<summary type="xhtml"><div><strong>Category:</strong> Information<br/><strong>Bulletin Issue Time: </strong> 2026.09.27 21:56:18 UTC <br/><strong>Preliminary Magnitude: </strong>5.2(Mwp)<br/><strong>Lat/Lon: </strong>18.483 / -69.134<br/><strong>Affected Region: </strong>ABOUT 83 MILES WEST OF ISLA MONA<br/><b>Note:</b>  <br/></div></summary>
</entry></feed>`;

test("NOAA tsunami bulletins parse category, time, place, magnitude and NOAA's own note", () => {
  const [ntwc] = parseTsunamiAtom(NTWC, "NTWC");
  assert.equal(ntwc.category, "Information");
  assert.equal(ntwc.issuedAt.toISOString(), "2026-09-28T09:20:44.000Z");
  assert.equal(ntwc.lat, 50.327);
  assert.equal(ntwc.lon, -129.358);
  assert.equal(ntwc.magnitude, 5.0);
  assert.equal(ntwc.note, "* There is NO tsunami danger from this earthquake.");
  const [ptwc] = parseTsunamiAtom(PTWC, "PTWC");
  assert.equal(ptwc.note, null);
  assert.equal(ptwc.region, "ABOUT 83 MILES WEST OF ISLA MONA");
});

test("the tsunami status quotes NOAA and replaces rather than stacks", () => {
  const [b] = parseTsunamiAtom(NTWC, "NTWC");
  const base = "Magnitude 5.4 earthquake 231 km WSW of Port McNeill, Canada.";
  const once = withTsunamiStatus(base, b);
  assert.equal(
    once,
    `${base} Tsunami status (NOAA NTWC): information bulletin - "There is NO tsunami danger from this earthquake."`,
  );
  assert.equal(withTsunamiStatus(once, b), once);
  const cancel: TsunamiBulletin = { ...b, category: "Cancellation", note: null };
  assert.equal(withTsunamiStatus(once, cancel), `${base} Tsunami status (NOAA NTWC): cancellation bulletin.`);
});

test("a bulletin matches the nearest quake shortly before it, and nothing outside the window", () => {
  const [b] = parseTsunamiAtom(NTWC, "NTWC"); // 09:20:44 UTC at 50.327, -129.358
  const at = (iso: string) => new Date(iso);
  const quakes = [
    { id: 1, lat: 50.4, lon: -129.2, publishedAt: at("2026-09-28T09:05:00Z") }, // ~14 km, 16 min before
    { id: 2, lat: 49.0, lon: -128.0, publishedAt: at("2026-09-28T09:10:00Z") }, // ~180 km
    { id: 3, lat: 50.33, lon: -129.36, publishedAt: at("2026-09-28T04:00:00Z") }, // 5 h before
    { id: 4, lat: 18.5, lon: -69.1, publishedAt: at("2026-09-28T09:15:00Z") }, // Caribbean
  ];
  assert.equal(matchBulletinToQuake(b, quakes), 1);
  assert.equal(matchBulletinToQuake(b, [quakes[2], quakes[3]]), null);
});

test("OONI rates keep confirmed blocking and possible interference apart and skip thin samples", () => {
  const rows = summarizeOoni(
    [
      { probe_cc: "IR", measurement_count: 1000, confirmed_count: 300, anomaly_count: 120 },
      { probe_cc: "CN", measurement_count: 2000, confirmed_count: 2, anomaly_count: 1100 },
      { probe_cc: "VA", measurement_count: 12, confirmed_count: 12, anomaly_count: 0 },
      { probe_cc: "ZZ", measurement_count: 5000, confirmed_count: 50, anomaly_count: 50 },
    ],
    [{ probe_cc: "IR", measurement_count: 900, confirmed_count: 90, anomaly_count: 90 }],
  );
  assert.deepEqual(rows.map((r) => r.country), ["IR", "CN"]);
  assert.equal(rows[0].confirmedRate, 0.3);
  assert.equal(rows[0].confirmedRatePrev, 0.1);
  assert.equal(rows[1].anomalyRate, 0.55);
  assert.equal(rows[1].confirmedRatePrev, null);
  // China is plotted on interference even though confirmed blocking is ~0.
  assert.deepEqual(internetCensorshipToPoints(rows).map((p) => p.id), ["ooni-IR", "ooni-CN"]);
});

test("Cloudflare Radar outages keep only country-attributed ones and read cause and type as words", () => {
  const outages = parseRadarOutages({
    success: true,
    result: {
      annotations: [
        {
          id: "a1",
          startDate: "2026-09-26T04:00:00Z",
          endDate: null,
          locations: ["IQ"],
          locationsDetails: [{ code: "IQ", name: "Iraq" }],
          outage: { outageCause: "GOVERNMENT_DIRECTED", outageType: "NATIONWIDE" },
          description: "Exam-related shutdown",
        },
        { id: "a2", startDate: "2026-09-20T00:00:00Z", endDate: "2026-09-20T06:00:00Z", locations: [], asns: [123] },
      ],
    },
  });
  assert.equal(outages.length, 1);
  assert.deepEqual(outages[0].countries, [{ code: "IQ", name: "Iraq" }]);
  assert.equal(outages[0].cause, "Government directed");
  assert.equal(outages[0].type, "Nationwide");
  // As a feed event: infrastructure-outage, at the capital, severity by scope.
  const [item] = radarOutagesToItems(outages);
  assert.equal(item.source, "cloudflare-radar");
  assert.equal(item.category, "infrastructure-outage");
  assert.equal(item.country, "IQ");
  assert.equal(item.severity, 4);
  assert.equal(item.url, "https://radar.cloudflare.com/outage-center#a1-IQ");
  assert.equal(item.title, "Internet outage in Iraq: government directed");
  assert.equal(item.summary, "Exam-related shutdown. Cloudflare Radar confirmed a nationwide internet outage in Iraq, cause: government directed, since 2026-09-26 04:00 UTC.");
});

test("a port is named only for precisely placed events within 50 km", () => {
  assert.ok(MAJOR_PORTS.length > 300);
  const odesa = MAJOR_PORTS.find((p) => p.country === "UA" && /odes/i.test(p.name));
  assert.ok(odesa, "the snapshot includes Odesa");
  const near = nearestMajorPort({ lat: odesa.lat + 0.1, lon: odesa.lon, country: "UA" });
  assert.equal(near?.port.name, odesa.name);
  assert.ok(near && near.km > 10 && near.km < 12);
  assert.equal(nearestMajorPort({ lat: 0, lon: -30, country: null }), null);
  // An event still on its country's placeholder position gets no port.
  const lisbon = COUNTRY_CENTROIDS.PT;
  assert.equal(nearestMajorPort({ lat: lisbon.lat, lon: lisbon.lon, country: "PT" }), null);
});

test("every context layer is in exactly one Layers-panel group", () => {
  const grouped = DATA_LAYER_GROUPS.flatMap((g) => g.layers);
  assert.equal(new Set(grouped).size, grouped.length, "no layer listed twice");
  assert.deepEqual([...grouped].sort(), [...DATA_LAYERS].sort());
});

test("a GDACS disaster keeps one URL across its episodes", async (t) => {
  assert.equal(
    canonicalGdacsUrl("https://www.gdacs.org/report.aspx?eventid=1001325&episodeid=36&eventtype=TC"),
    "https://www.gdacs.org/report.aspx?eventid=1001325&eventtype=TC",
  );
  assert.equal(canonicalGdacsUrl("https://www.gdacs.org/report.aspx?eventid=1001325&eventtype=TC"), "https://www.gdacs.org/report.aspx?eventid=1001325&eventtype=TC");
  assert.equal(canonicalGdacsUrl("https://www.gdacs.org/report.aspx?eventid=abc&eventtype=TC"), null);
  assert.equal(canonicalGdacsUrl("https://example.invalid/report.aspx?eventid=1&eventtype=TC"), null);

  // Shape trimmed from the live geteventlist response (2026-09-29).
  const feature = (episodeid: number, alertlevel: string) => ({
    geometry: { type: "Point", coordinates: [-107.1, 19.2] },
    properties: {
      eventtype: "TC", eventid: 1001325, episodeid, name: "Tropical Cyclone POLO-26", description: "POLO-26",
      alertlevel, fromdate: "2026-09-21T03:00:00", affectedcountries: [{ iso2: "MX", countryname: "Mexico" }],
      url: { report: `https://www.gdacs.org/report.aspx?eventid=1001325&episodeid=${episodeid}&eventtype=TC` },
    },
  });
  let episode = feature(35, "Orange");
  t.mock.method(globalThis, "fetch", async () => Response.json({ features: [episode] }));
  const first = await fetchGdacsAlerts();
  episode = feature(36, "Red");
  const second = await fetchGdacsAlerts();
  assert.equal(first[0].url, "https://www.gdacs.org/report.aspx?eventid=1001325&eventtype=TC");
  assert.equal(second[0].url, first[0].url);
  assert.deepEqual([first[0].severity, second[0].severity], [3, 5]);
});
