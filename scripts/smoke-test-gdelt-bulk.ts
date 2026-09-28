import { fetchGdeltBulkEvents } from "../src/lib/sources/gdeltBulk";

async function main() {
  const start = Date.now();
  const items = await fetchGdeltBulkEvents();
  const elapsed = Date.now() - start;
  console.log(`Fetched ${items.length} items in ${elapsed}ms`);
  const countries = new Set(items.map((i) => i.resolvedCountry));
  console.log(`Distinct countries: ${countries.size}`);
  console.log([...countries].sort().join(","));
  console.log("--- sample 15 ---");
  for (const item of items.slice(0, 15)) {
    console.log(`[${item.resolvedCountry}] ${item.title}`);
  }
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
