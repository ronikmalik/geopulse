import { resolveCountryFromText } from "../src/lib/countryNames";

const cases: [string, string | null][] = [
  ["Three women were injured in the blast near the market", null],
  ["Ottoman-era relics discovered during excavation", null],
  ["Romania's president met with EU officials in Brussels", "RO"],
  ["Oman signed a new trade deal with the United States", "OM"],
  ["Omani officials condemned the attack on the tanker", "OM"],
  ["Kenyan police arrested a suspect in Nairobi", "KE"],
  ["Roman ruins found beneath the city square", null],
  ["A Romanian court ruled against the opposition leader", "RO"],
  ["Businesswoman detained at the airport over fraud charges", null],
];

let failures = 0;
for (const [text, expected] of cases) {
  const got = resolveCountryFromText(text);
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} "${text}" -> ${got} (expected ${expected})`);
}
console.log(failures === 0 ? "\nAll passed." : `\n${failures} FAILURE(S).`);
