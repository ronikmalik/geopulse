import type { EventRow } from "@/db/schema";

// sourceCount: how many other outlets' reports of this same story were
// merged into it as duplicates (see src/lib/eventDedup.ts) — 0 means no
// other outlet has reported this yet. Every producer of feed-consumed
// events (api/stream's backfill/live rows, risk.ts's getEventsByCountry)
// includes it; a card with sourceCount > 0 fetches the actual duplicate
// list on demand via GET /api/events/duplicates when expanded.
export type GeoEvent = EventRow & { sourceCount: number };
