import { fetchSubmarineCableSummary } from "../src/lib/sources/submarineCables";

fetchSubmarineCableSummary(200)
  .then((summary) => {
    const matched = summary!.topCountries.reduce((a, c) => a + c.landingPointCount, 0);
    console.log(
      "countries matched:",
      summary!.topCountries.length,
      "landing points matched:",
      matched,
      "of",
      summary!.totalLandingPoints,
      "unmatched:",
      summary!.totalLandingPoints - matched,
    );
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
