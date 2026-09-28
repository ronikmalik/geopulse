// One-time fix for the misclassified event discussed with the user
// (2026-09-09): GDELT article id 2668 was tagged category=israel-palestine
// due to the classifyGdeltItem bug just fixed in src/lib/classify.ts (an
// unrelated "Israel strikes South Lebanon" sub-story bundled on the same
// livemint.com live-blog page tripped the israel-palestine GDELT query's
// full-text match). The real headline is pure US-Iran. Not meant to be run
// again — remove once confirmed applied.
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { events } from "../src/db/schema";

async function main() {
  const db = getDb();
  const result = await db
    .update(events)
    .set({ category: "us-iran" })
    .where(eq(events.id, 2668))
    .returning({ id: events.id, category: events.category, title: events.title });
  console.log(JSON.stringify(result, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
