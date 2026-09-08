import { NextRequest, NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/cronAuth";

// One-off diagnostic, not a product route — calls Google's own ListModels
// endpoint to get the authoritative current Gemini model names/supported
// methods, rather than trusting a hardcoded guess (see the doc comment in
// src/lib/embeddings.ts for why that guess is genuinely uncertain as of
// 2026-09-08). CRON_SECRET-gated like the other /api/admin/* routes, even
// though the response itself is harmless — no reason to expose it
// publicly just because it could be.
export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "GEMINI_API_KEY not configured" }, { status: 400 });
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
  );
  const data = await res.json();
  if (!res.ok) {
    return NextResponse.json({ error: data }, { status: res.status });
  }

  interface ModelInfo {
    name: string;
    supportedGenerationMethods?: string[];
  }
  const models = ((data.models as ModelInfo[]) ?? []).map((m) => ({
    name: m.name,
    methods: m.supportedGenerationMethods,
  }));

  return NextResponse.json({ models });
}
