// Regenerates src/lib/data/majorPorts.json from NGA's World Port Index
// (https://msi.nga.mil, US government work, public domain). Keeps the
// large and medium harbours only, the ones whose disruption matters for
// shipping and supply chains. Run by hand when NGA publishes a new
// edition: npx tsx scripts/build-major-ports.ts
import { writeFileSync } from "node:fs";

interface WpiPort {
  portName: string;
  countryCode: string | null;
  harborSize: string | null;
  ycoord: number;
  xcoord: number;
  unloCode: string | null;
}

async function main() {
  const res = await fetch("https://msi.nga.mil/api/publications/world-port-index?output=json", {
    headers: { "User-Agent": "geopulse-globe/1.0" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`World Port Index: HTTP ${res.status}`);
  const { ports } = (await res.json()) as { ports: WpiPort[] };
  const major = ports
    .filter((p) => (p.harborSize === "L" || p.harborSize === "M") && p.countryCode && Number.isFinite(p.ycoord))
    .map((p) => ({
      name: p.portName.trim(),
      country: p.countryCode!,
      size: p.harborSize as "L" | "M",
      lat: Math.round(p.ycoord * 1000) / 1000,
      lon: Math.round(p.xcoord * 1000) / 1000,
      unlocode: p.unloCode?.trim() || null,
    }))
    .sort((a, b) => a.country.localeCompare(b.country) || a.name.localeCompare(b.name));
  const out = { source: "NGA World Port Index (msi.nga.mil), public domain", generatedAt: new Date().toISOString().slice(0, 10), ports: major };
  writeFileSync("src/lib/data/majorPorts.json", JSON.stringify(out) + "\n");
  console.log(`wrote ${major.length} ports (${major.filter((p) => p.size === "L").length} large)`);
}
main();
