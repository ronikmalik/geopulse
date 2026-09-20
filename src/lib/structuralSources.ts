// The "direct"/structural sources: machine-generated records (a quake, an
// outage signal, a satellite thermal cluster, a disaster alert) rather than
// journalist-written text. They skip the pre-publish review gate (see
// ingest.ts) because there's no editorial judgment in "a magnitude-6
// earthquake happened here" — and, since 2026-09-20, they also skip the
// embedding pipeline: their text is templated ("Large thermal anomaly
// cluster detected (satellite) near -11.05, -54.07"), so every row of a
// source embeds to nearly the same vector. That made "similar events" for
// a FIRMS cluster return other FIRMS clusters, gave narrative clustering a
// giant meaningless "satellite fire" blob, could never produce a novelty
// hit, and spent 13% of the embedding budget (786 of 5,867 rows in the 14
// days to 2026-09-20) doing it. Their "related" lookup is structured
// instead — see relatedStructuralEvents in similarEvents.ts.
export const STRUCTURAL_SOURCES = ["usgs", "eonet", "gdacs", "ioda", "firms"] as const;

export type StructuralSource = (typeof STRUCTURAL_SOURCES)[number];

export function isStructuralSource(source: string): source is StructuralSource {
  return (STRUCTURAL_SOURCES as readonly string[]).includes(source);
}
