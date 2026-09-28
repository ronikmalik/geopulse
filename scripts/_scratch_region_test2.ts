import { assessIncidentSeverity } from "../src/lib/classify";
import { resolveCountryFromText } from "../src/lib/countryNames";
import { isCountryInSourceRegion } from "../src/lib/regionScope";

const title = "Clashes erupt as protesters clash with police in Delhi";
const snippet = "Police used tear gas as protesters clashed near the capital.";
const text = `${title} ${snippet}`;

console.log("severity:", assessIncidentSeverity(text));
console.log("country from title:", resolveCountryFromText(title));
console.log("country from snippet:", resolveCountryFromText(snippet));
const country = resolveCountryFromText(title) ?? resolveCountryFromText(snippet);
if (country) {
  console.log("region check (the-hindu):", isCountryInSourceRegion("rss:the-hindu", country));
}
