import { MAJOR_PORTS, MAJOR_PORTS_SOURCE } from "@/lib/ports";

// Static reference data (NGA World Port Index snapshot), built into the
// deployment: no upstream call, no database, served from the CDN.
export const dynamic = "force-static";

export function GET() {
  return Response.json({ source: MAJOR_PORTS_SOURCE, ports: MAJOR_PORTS });
}
