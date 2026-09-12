import { NextRequest, NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/cronAuth";
import { getKillSwitchStatus, activateKillSwitch, restoreKillSwitch } from "@/lib/killSwitch";

export const maxDuration = 55;

// GET = read-only status (live/killed counts, last activation time) — safe
// to poll from the admin page on load without side effects.
export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const status = await getKillSwitchStatus();
  return NextResponse.json(status);
}

// POST ?action=activate | ?action=restore — the only two mutations this
// route performs. See src/lib/killSwitch.ts for what each actually does
// (a hide, and its exact reverse — never a delete).
export async function POST(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const action = req.nextUrl.searchParams.get("action");
  if (action === "activate") {
    const result = await activateKillSwitch();
    return NextResponse.json(result);
  }
  if (action === "restore") {
    const result = await restoreKillSwitch();
    return NextResponse.json(result);
  }
  return NextResponse.json({ error: "missing or invalid ?action= (expected 'activate' or 'restore')" }, { status: 400 });
}
