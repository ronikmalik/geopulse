import { fetchElevatedAdvisories, fetchTravelAdvisoryFor } from "../src/lib/sources/travelAdvisories";

async function main() {
  const elevated = await fetchElevatedAdvisories(10);
  console.log("ELEVATED:", JSON.stringify(elevated, null, 2));
  const us = await fetchTravelAdvisoryFor("MX");
  console.log("MX lookup:", JSON.stringify(us));
  const jp = await fetchTravelAdvisoryFor("JP");
  console.log("JP lookup:", JSON.stringify(jp));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
