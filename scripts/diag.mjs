import { unzipSync } from "fflate";

const lastupdate = await (await fetch("http://data.gdeltproject.org/gdeltv2/lastupdate.txt")).text();
const url = lastupdate.split(/\r?\n/)[0].trim().split(/\s+/)[2];
console.log("URL:", url);
const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
const unzipped = unzipSync(buf);
const csv = new TextDecoder().decode(Object.values(unzipped)[0]);
const lines = csv.split(/\r?\n/).filter((l) => l.trim());
console.log("Total rows:", lines.length);

let hasUrl = 0,
  hasCountry = 0,
  numSourcesOk = 0,
  all = 0,
  rootCovered = 0;
const covered = new Set(["01","02","03","04","05","06","07","08","10","11","12","13","14","15","16","17","18","19","20"]);
for (const line of lines) {
  const f = line.split("\t");
  if (f.length < 61) continue;
  const sourceUrl = f[60]?.trim();
  const hasRealUrl = sourceUrl && /^https?:\/\//.test(sourceUrl);
  if (hasRealUrl) hasUrl++;
  const numSources = Number(f[32]);
  if (numSources >= 2) numSourcesOk++;
  const cc = f[53]?.trim();
  if (cc) hasCountry++;
  const root = f[28]?.trim();
  if (covered.has(root)) rootCovered++;
  if (hasRealUrl && numSources >= 2 && cc && covered.has(root)) all++;
}
console.log({ hasUrl, hasCountry, numSourcesOk, rootCovered, all, total: lines.length });
