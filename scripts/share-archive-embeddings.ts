// One-time conversion (2026-10-13): give every feed_archive row the vector
// of its classification_archive row (same url), so the feed corpus is one
// embedding style from now on — see archiveEmbeddingText in
// src/lib/classificationArchiveEmbeddingBackfill.ts for why the two
// archives now share one Gemini call per item. Costs no Gemini calls.
//
// Dry run by default (counts only). With --apply it first writes every
// feed vector it is about to overwrite to a local JSONL backup, then
// swaps them in id pages. Idempotent: rows already sharing the vector are
// skipped, so a re-run after a partial failure only does what is left.
//
//   npx tsx --env-file=.env.local scripts/share-archive-embeddings.ts [--apply] [--backup <file>]
import { createWriteStream } from "node:fs";
import { sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { STRUCTURAL_SOURCES } from "../src/lib/structuralSources";

// Neon's HTTP driver rejects responses over 64 MB; a 768-dim vector as
// text is ~8 KB, so 1,000 rows a page stays far below it.
const PAGE = 1_000;

async function main() {
  const apply = process.argv.includes("--apply");
  const backupArg = process.argv.indexOf("--backup");
  const backupPath =
    backupArg >= 0 ? process.argv[backupArg + 1] : `feed-archive-embeddings-backup-${new Date().toISOString().slice(0, 10)}.jsonl`;
  const db = getDb();
  const structural = sql.raw([...STRUCTURAL_SOURCES].map((s) => `'${s}'`).join(", "));
  const pending = sql`
    from feed_archive f join classification_archive c on c.url = f.url
    where c.embedding is not null and f.embedding is distinct from c.embedding
      and f.source not in (${structural})`;

  const [{ n }] = (await db.execute(sql`select count(*)::int n ${pending}`)).rows as { n: number }[];
  console.log(`${n} feed_archive rows would take their classification_archive vector.`);
  if (!apply || n === 0) return;

  const out = createWriteStream(backupPath);
  let afterId = 0;
  let backedUp = 0;
  for (;;) {
    const rows = (
      await db.execute(sql`select f.id, f.url, f.embedding::text embedding ${pending} and f.id > ${afterId} order by f.id limit ${PAGE}`)
    ).rows as { id: number; url: string; embedding: string | null }[];
    if (rows.length === 0) break;
    for (const r of rows) out.write(`${JSON.stringify(r)}\n`);
    backedUp += rows.length;
    afterId = rows[rows.length - 1].id;
  }
  await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  console.log(`Backed up ${backedUp} existing vectors to ${backupPath}.`);

  let swapped = 0;
  for (;;) {
    const res = await db.execute(sql`
      update feed_archive f set embedding = c.embedding
      from classification_archive c
      where f.id in (select f.id ${pending} order by f.id limit ${PAGE})
        and c.url = f.url
      returning f.id`);
    if (res.rows.length === 0) break;
    swapped += res.rows.length;
    console.log(`  swapped ${swapped}/${n}`);
  }
  console.log(`Done: ${swapped} feed_archive rows now share their classification_archive vector.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
