import { fetchGpsJammingSummary } from "../src/lib/sources/gpsjam";

fetchGpsJammingSummary(10)
  .then((summary) => {
    console.log(JSON.stringify(summary, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
