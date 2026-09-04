import { NextResponse } from "next/server";
import { fetchCisaKev } from "@/lib/sources/cisakev";
import { withCache } from "@/lib/layerCache";

// See src/app/api/layers/flights/route.ts's 2026-09-04 comment.
export async function GET() {
  try {
    const vulnerabilities = await withCache("layer:cyber", 30 * 60_000, () =>
      fetchCisaKev(10),
    );
    return NextResponse.json({ vulnerabilities });
  } catch (err) {
    console.error(`layer:cyber failed: ${err}`);
    return NextResponse.json({ vulnerabilities: [] });
  }
}
