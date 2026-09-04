import { NextRequest, NextResponse } from "next/server";
import { runIngest } from "@/lib/ingest";
import { isCronAuthorized } from "@/lib/cronAuth";

export const maxDuration = 300;

export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await runIngest();
  return NextResponse.json(result);
}

export async function POST(req: NextRequest) {
  return GET(req);
}
