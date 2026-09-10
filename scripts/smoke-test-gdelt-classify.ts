import { fetchGdeltBulkEvents } from "../src/lib/sources/gdeltBulk";
import { classifyByKeywords } from "../src/lib/classify";

async function main() {
  const items = await fetchGdeltBulkEvents();
  console.log(`Raw items: ${items.length}`);
  let kept = 0;
  for (const item of items) {
    const c = classifyByKeywords(item);
    if (c) {
      kept++;
      console.log(`KEPT  [${c.country} sev${c.severity} ${c.category}] ${item.title}`);
    }
  }
  console.log(`\nKept ${kept} of ${items.length} (${((kept / items.length) * 100).toFixed(1)}%)`);
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
