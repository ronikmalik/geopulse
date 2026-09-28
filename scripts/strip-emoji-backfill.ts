// One-time cleanup: strips emoji out of title/summary text already sitting
// in the DB from before src/lib/textSanitize.ts's stripEmoji was wired
// into the RSS/GDELT/Telegram source adapters. Without this, already-
// ingested rows (PressTV, Telegram channels, etc.) would keep showing
// emoji in the live feed until they naturally aged out of the 24h window.
// Not meant to be run again — remove once confirmed applied.
import { sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { events, feedArchive } from "../src/db/schema";
import { stripEmoji } from "../src/lib/textSanitize";

async function backfillTable(
  table: typeof events | typeof feedArchive,
  label: string,
) {
  const db = getDb();
  const rows = await db
    .select({ id: table.id, title: table.title, summary: table.summary })
    .from(table);

  let updated = 0;
  for (const row of rows) {
    const cleanTitle = stripEmoji(row.title);
    const cleanSummary = stripEmoji(row.summary);
    if (cleanTitle === row.title && cleanSummary === row.summary) continue;
    await db
      .update(table)
      .set({ title: cleanTitle, summary: cleanSummary })
      .where(sql`${table.id} = ${row.id}`);
    updated++;
  }
  console.log(`${label}: ${updated} of ${rows.length} rows updated`);
}

async function main() {
  await backfillTable(events, "events");
  await backfillTable(feedArchive, "feed_archive");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
