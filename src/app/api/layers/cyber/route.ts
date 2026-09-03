import { NextResponse } from "next/server";
import { fetchCisaKev } from "@/lib/sources/cisakev";
import { withCache } from "@/lib/layerCache";

export async function GET() {
  const vulnerabilities = await withCache("layer:cyber", 30 * 60_000, () =>
    fetchCisaKev(10),
  );
  return NextResponse.json({ vulnerabilities });
}
