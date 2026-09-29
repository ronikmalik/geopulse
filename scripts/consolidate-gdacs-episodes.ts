// One-time repair (2026-09-29): folds the GDACS rows stored one per
// episode into one row per disaster — see src/lib/gdacsEvents.ts.
// Dry run by default; --apply writes. Safe to re-run.
//   npx dotenv -e .env.local -- tsx scripts/consolidate-gdacs-episodes.ts [--apply]
import { consolidateGdacsEpisodes } from "../src/lib/gdacsEvents";

const apply = process.argv.includes("--apply");
consolidateGdacsEpisodes(apply)
  .then((result) => console.log(JSON.stringify({ apply, ...result })))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
