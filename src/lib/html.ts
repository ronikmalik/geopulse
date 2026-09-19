// Auto-escaping HTML tagged template (2026-09-19 security pass).
//
// globe.gl renders pointLabel/polygonLabel return values via innerHTML, and
// this app builds those strings from data it does not control: article
// headlines and locations from any RSS feed or GDELT-crawled page, aircraft
// callsigns and registrations from ADS-B, air-quality station names, trade-
// partner names from Comtrade. A headline containing `<img src=x
// onerror=…>` would have executed in every viewer's browser on hover — and
// next.config.ts's CSP allows inline script (Next's own RSC payload needs
// it), so the CSP would not have caught it. Every tooltip builder now goes
// through this tag: literal template text is trusted markup, every `${}`
// interpolation is escaped. Numbers and other non-strings are stringified
// then escaped too, so there is no way to opt a value out by accident.
const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): string {
  let out = "";
  for (let i = 0; i < strings.length; i++) {
    out += strings[i];
    if (i < values.length) out += escapeHtml(values[i]);
  }
  return out;
}
