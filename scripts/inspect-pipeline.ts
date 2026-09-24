// Read-only operational check. Run through dotenv-cli when production
// credentials are needed; never print connection strings or error objects.
import { sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { gatherPipelineMetrics, evaluatePipelineHealth } from "../src/lib/pipelineHealth";
import { getRecentAiUsage } from "../src/lib/aiUsage";

async function main() {
  const db = getDb();
  const metrics = await gatherPipelineMetrics();
  const review = await db.execute(sql`
    select review_status, count(*)::int count, min(created_at) oldest, max(created_at) newest
    from events where source = 'gdelt' and created_at > now() - interval '24 hours'
    group by review_status order by review_status
  `);
  const history = await db.execute(sql`
    select scoring_version, count(distinct snapshot_at::date)::int days, count(*)::int rows
    from country_state_history group by scoring_version order by scoring_version
  `);
  const storage = await db.execute(sql`select pg_database_size(current_database())::bigint bytes`);
  console.log(JSON.stringify({
    asOf: new Date().toISOString(), metrics, warnings: evaluatePipelineHealth(metrics),
    gdeltCreated24h: review.rows, snapshotHistory: history.rows, storage: storage.rows,
    recentAiUsage: await getRecentAiUsage(1),
  }, null, 2));
}

main().catch(() => {
  console.error("Read-only pipeline inspection failed; check connectivity and schema. Credentials omitted.");
  process.exitCode = 1;
});
