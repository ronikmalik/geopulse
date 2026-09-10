import { COUNTRY_CENTROIDS } from "./countryCentroids";

// GDELT 2.0's Actor1Geo_CountryCode/Actor2Geo_CountryCode/ActionGeo_CountryCode
// fields use FIPS 10-4 country codes, NOT ISO 3166-1 alpha-2 — confirmed
// directly against the official GDELT 2.0 Event Codebook ("Actor1Geo_
// CountryCode. (string) This is the 2-character FIPS10-4 country code for
// the location."), no version exception found. This app's entire country
// model (countryCentroids.ts, countryNames.ts, isoCountries.ts) is ISO2, so
// every GDELT-bulk-derived event needs translation through this table
// before it can be attributed to a country anywhere else in the app.
//
// Only the codes where FIPS actually DIFFERS from ISO2 are listed —
// verified 2026-09-10 against the Open Knowledge Foundation's country-codes
// dataset (github.com/datasets/country-codes), which found 152 of ~250
// countries differ. Everything NOT in this table is assumed identical
// (FIPS === ISO2) and then validated against COUNTRY_CENTROIDS before being
// trusted — see fipsToIso2 below. That validation step is the real safety
// net: an unlisted code that ISN'T actually identical would fail centroid
// lookup and resolve to null rather than silently misattributing a country,
// consistent with this app's "use null rather than guessing" country
// standard (see classifierAudit.ts's COUNTRY_GUIDANCE).
export const FIPS_TO_ISO2: Record<string, string> = {
  AG: "DZ", // Algeria
  AQ: "AS", // American Samoa
  AN: "AD", // Andorra
  AV: "AI", // Anguilla
  AY: "AQ", // Antarctica
  AC: "AG", // Antigua and Barbuda
  AA: "AW", // Aruba
  AS: "AU", // Australia
  AU: "AT", // Austria
  AJ: "AZ", // Azerbaijan
  BF: "BS", // Bahamas
  BA: "BH", // Bahrain
  BG: "BD", // Bangladesh
  BO: "BY", // Belarus
  BH: "BZ", // Belize
  BN: "BJ", // Benin
  BD: "BM", // Bermuda
  BL: "BO", // Bolivia
  NL: "BQ", // Bonaire, Sint Eustatius and Saba
  BK: "BA", // Bosnia and Herzegovina
  BC: "BW", // Botswana
  VI: "VG", // British Virgin Islands
  BX: "BN", // Brunei
  BU: "BG", // Bulgaria
  UV: "BF", // Burkina Faso
  BY: "BI", // Burundi
  CB: "KH", // Cambodia
  CJ: "KY", // Cayman Islands
  CT: "CF", // Central African Republic
  CD: "TD", // Chad
  CI: "CL", // Chile
  CH: "CN", // China
  MC: "MO", // Macao
  KT: "CX", // Christmas Island
  CK: "CC", // Cocos Islands
  CN: "KM", // Comoros
  CF: "CG", // Congo
  CW: "CK", // Cook Islands
  CS: "CR", // Costa Rica
  UC: "CW", // Curaçao
  EZ: "CZ", // Czechia
  KN: "KP", // North Korea
  CG: "CD", // DR Congo
  DA: "DK", // Denmark
  DO: "DM", // Dominica
  DR: "DO", // Dominican Republic
  ES: "SV", // El Salvador
  EK: "GQ", // Equatorial Guinea
  EN: "EE", // Estonia
  WZ: "SZ", // Eswatini
  FG: "GF", // French Guiana
  FP: "PF", // French Polynesia
  FS: "TF", // French Southern Territories
  GB: "GA", // Gabon
  GA: "GM", // Gambia
  GG: "GE", // Georgia
  GM: "DE", // Germany
  GJ: "GD", // Grenada
  GQ: "GU", // Guam
  GK: "GG", // Guernsey
  GV: "GN", // Guinea
  PU: "GW", // Guinea-Bissau
  HA: "HT", // Haiti
  VT: "VA", // Holy See
  HO: "HN", // Honduras
  IC: "IS", // Iceland
  IZ: "IQ", // Iraq
  EI: "IE", // Ireland
  IS: "IL", // Israel
  IV: "CI", // Ivory Coast
  JA: "JP", // Japan
  KR: "KI", // Kiribati
  KU: "KW", // Kuwait
  LG: "LV", // Latvia
  LE: "LB", // Lebanon
  LT: "LS", // Lesotho
  LI: "LR", // Liberia
  LS: "LI", // Liechtenstein
  LH: "LT", // Lithuania
  MA: "MG", // Madagascar
  MI: "MW", // Malawi
  RM: "MH", // Marshall Islands
  MB: "MQ", // Martinique
  MP: "MU", // Mauritius
  MF: "YT", // Mayotte
  MN: "MC", // Monaco
  MG: "MN", // Mongolia
  MJ: "ME", // Montenegro
  MH: "MS", // Montserrat
  MO: "MA", // Morocco
  BM: "MM", // Myanmar
  WA: "NA", // Namibia
  NU: "NI", // Nicaragua
  NG: "NE", // Niger
  NI: "NG", // Nigeria
  NE: "NU", // Niue
  CQ: "MP", // Northern Mariana Islands
  MU: "OM", // Oman
  PS: "PW", // Palau
  PM: "PA", // Panama
  PP: "PG", // Papua New Guinea
  PA: "PY", // Paraguay
  RP: "PH", // Philippines
  PC: "PN", // Pitcairn
  PO: "PT", // Portugal
  RQ: "PR", // Puerto Rico
  KS: "KR", // South Korea
  RS: "RU", // Russia
  TB: "BL", // Saint Barthélemy
  SC: "KN", // Saint Kitts and Nevis
  ST: "LC", // Saint Lucia
  RN: "MF", // Saint Martin (French)
  SB: "PM", // Saint Pierre and Miquelon
  TP: "ST", // Sao Tome and Principe
  SG: "SN", // Senegal
  RIKV: "RS", // Serbia (non-standard FIPS entry, kept for completeness)
  SE: "SC", // Seychelles
  SN: "SG", // Singapore
  NN: "SX", // Sint Maarten
  LO: "SK", // Slovakia
  BP: "SB", // Solomon Islands
  SF: "ZA", // South Africa
  SX: "GS", // South Georgia and South Sandwich Islands
  OD: "SS", // South Sudan
  SP: "ES", // Spain
  CE: "LK", // Sri Lanka
  GZWE: "PS", // Palestine (non-standard FIPS entry, kept for completeness)
  SU: "SD", // Sudan
  NS: "SR", // Suriname
  SVJN: "SJ", // Svalbard and Jan Mayen (non-standard FIPS entry, kept for completeness)
  SW: "SE", // Sweden
  SZ: "CH", // Switzerland
  TI: "TJ", // Tajikistan
  TT: "TL", // Timor-Leste
  TO: "TG", // Togo
  TL: "TK", // Tokelau
  TN: "TO", // Tonga
  TD: "TT", // Trinidad and Tobago
  TS: "TN", // Tunisia
  TU: "TR", // Türkiye
  TX: "TM", // Turkmenistan
  TK: "TC", // Turks and Caicos
  UP: "UA", // Ukraine
  UK: "GB", // United Kingdom
  VQ: "VI", // US Virgin Islands
  NH: "VU", // Vanuatu
  VM: "VN", // Vietnam
  WI: "EH", // Western Sahara
  YM: "YE", // Yemen
  ZA: "ZM", // Zambia
  ZI: "ZW", // Zimbabwe
};

// Translates a GDELT FIPS 10-4 geo country code to this app's canonical
// ISO2, validated against COUNTRY_CENTROIDS (the same "is this actually a
// real, placeable country" gate every other country-resolution path in
// this app uses) before being trusted. An unrecognized/blank code, or one
// that maps to something this app doesn't have a centroid for, returns
// null rather than a guess.
export function fipsToIso2(fips: string | undefined | null): string | null {
  if (!fips) return null;
  const code = fips.trim().toUpperCase();
  if (!code) return null;
  const iso2 = FIPS_TO_ISO2[code] ?? code; // unlisted codes are assumed identical to ISO2
  return COUNTRY_CENTROIDS[iso2] ? iso2 : null;
}
