import { NextRequest } from "next/server";
import { getDuplicatesOf } from "@/lib/eventDedup";
import { badRequest, cachedJson, parseIdParam } from "@/lib/apiParams";

// Read-only, unauthenticated like the other feed-serving routes — the
// duplicate rows are the same public news articles the primary event
// already links to. Backs the "N more sources" expansion in FeedPanel: a
// card with sourceCount > 0 (see src/lib/types.ts) calls this on demand
// rather than every event carrying its full duplicate list up front.
// Only approved, non-kill-switched duplicates of an approved, non-kill-
// switched primary are ever returned (see getDuplicatesOf).
export async function GET(req: NextRequest) {
  const id = parseIdParam(req.nextUrl.searchParams.get("id"));
  if (!id) return badRequest("missing or invalid ?id=");
  const sources = await getDuplicatesOf(id);
  return cachedJson({ sources }, 60);
}
