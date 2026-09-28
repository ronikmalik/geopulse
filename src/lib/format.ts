// Display helpers shared by the client panels (2026-09-28: four components
// each carried their own copy of these).

const regionNames =
  typeof Intl !== "undefined"
    ? new Intl.DisplayNames(["en"], { type: "region" })
    : null;

// ISO 3166-1 alpha-2 -> English name; falls back to the code itself.
export function countryName(code: string): string {
  try {
    return regionNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

export function timeAgo(when: string | Date): string {
  const date = typeof when === "string" ? new Date(when) : when;
  const mins = Math.floor((Date.now() - date.getTime()) / 60000);
  if (Number.isNaN(mins)) return "";
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
