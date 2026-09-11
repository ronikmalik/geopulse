import { neon } from "@neondatabase/serverless";
import * as fs from "fs";
const env = fs.readFileSync(
  "C:\\Users\\ronik\\AppData\\Local\\Temp\\claude\\C--Users-ronik\\c4380da5-2346-4970-9d7d-7e8f8ba51e01\\scratchpad\\.env.verify",
  "utf8"
);
const dbUrl = env.match(/^DATABASE_URL="(.+)"$/m)?.[1]!;
const sql = neon(dbUrl);

const SURVIVING = ["GeneralStaffZSU","kpszsu","dsns_telegram","DIUkraine","Joint_Forces_Task_Force",
  "V_Zelenskiy_official","mod_russia","rybar","wargonzo","medvedev_telegram","iribnews","farsna","army21ye"];
const SURVIVING_SOURCES = SURVIVING.map((h) => `telegram:${h}`);

async function main() {
  console.log("=== translation-attempt candidates per surviving channel (resolved-translated + still-pending), last 6 days observed ===");
  // "translated" resolved rows = script no longer original (same check as before)
  const NON_LATIN = "[\\u0400-\\u04FF\\u0600-\\u06FF\\u0750-\\u077F\\uFB50-\\uFDFF\\uFE70-\\uFEFF]";
  const translated = await sql`
    SELECT source, COUNT(*) as n FROM classification_archive
    WHERE source = ANY(${SURVIVING_SOURCES}) AND NOT (snippet ~ ${NON_LATIN})
    GROUP BY source
  `;
  console.log("Resolved via real translation:", translated);

  const pending = await sql`
    SELECT handle, COUNT(*) as n FROM pending_translation
    WHERE handle = ANY(${SURVIVING})
    GROUP BY handle
  `;
  console.log("Currently pending:", pending);

  console.log("\n=== avg/typical byte size of a candidate excerpt (post byte-cap+strip fix), sampled from pending_translation discovered after the fix deployed (2026-09-10 20:23 UTC) ===");
  console.log(await sql`
    SELECT AVG(octet_length(excerpt)) as avg_bytes, MAX(octet_length(excerpt)) as max_bytes, COUNT(*) as n
    FROM pending_translation
    WHERE discovered_at > '2026-09-10 20:23:00'
  `);

  console.log("\n=== oldest classification_archive row overall (to compute the real observation window length) ===");
  console.log(await sql`SELECT MIN(archived_at), MAX(archived_at) FROM classification_archive WHERE source LIKE 'telegram:%'`);

  console.log("\n=== current live translation-usage budget snapshot ===");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
