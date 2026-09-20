"use client";

import { useCallback, useEffect, useState } from "react";
import { CATEGORY_LABELS, type Category } from "@/lib/categories";
import { sourceLabel } from "@/lib/sourceLabels";
import { stripOutletSuffix } from "@/lib/displayText";
import type { GateSample, GateMetrics } from "@/lib/gateReview";

// The human end of the gate's ground-truth channel (see src/lib/
// gateReview.ts). Same admin-secret pattern as /admin/kill-switch: the
// secret is typed once, held in sessionStorage, and sent as a Bearer
// header. Ten cards a day, two buttons each — the whole point is that
// grading takes about a minute, so it actually happens.
const SECRET_KEY = "geopulse_admin_secret";

interface Payload {
  pending: GateSample[];
  metrics: GateMetrics;
}

async function fetchPayload(secret: string): Promise<{ data: Payload | null; error: string | null }> {
  try {
    const res = await fetch("/api/admin/gate-review", { headers: { Authorization: `Bearer ${secret}` } });
    if (!res.ok) {
      return { data: null, error: res.status === 401 ? "Wrong secret." : `Request failed (${res.status}).` };
    }
    return { data: await res.json(), error: null };
  } catch {
    return { data: null, error: "Network error." };
  }
}

function pct(v: number | null): string {
  return v === null ? "-" : `${Math.round(v * 100)}%`;
}

export default function GateReviewPage() {
  const [secret, setSecret] = useState<string>(() =>
    typeof window === "undefined" ? "" : (sessionStorage.getItem(SECRET_KEY) ?? ""),
  );
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [lastResult, setLastResult] = useState<string | null>(null);

  const [refreshKey, setRefreshKey] = useState(0);
  const load = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    if (!secret) return;
    let cancelled = false;
    fetchPayload(secret).then((result) => {
      if (cancelled) return;
      setData(result.data);
      setError(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, [secret, refreshKey]);

  function handleSecretChange(v: string) {
    setSecret(v);
    sessionStorage.setItem(SECRET_KEY, v);
    if (!v) setData(null);
  }

  async function grade(sample: GateSample, verdict: "correct" | "wrong") {
    setBusyId(sample.id);
    setLastResult(null);
    try {
      const res = await fetch("/api/admin/gate-review", {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
        body: JSON.stringify({ id: sample.id, verdict, note: notes[sample.id] ?? "" }),
      });
      const body = (await res.json()) as { note?: string; error?: string };
      if (!res.ok) {
        setError(body.error ?? `Request failed (${res.status}).`);
        return;
      }
      setLastResult(`${verdict === "correct" ? "Confirmed" : "Overruled"} - ${body.note ?? ""}`);
      setData((prev) => (prev ? { ...prev, pending: prev.pending.filter((p) => p.id !== sample.id) } : prev));
      load();
    } catch {
      setError("Network error.");
    } finally {
      setBusyId(null);
    }
  }

  const m = data?.metrics;

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 px-6 py-12 text-neutral-200">
      <div>
        <h1 className="text-xl font-semibold text-white">Gate review</h1>
        <p className="mt-1 text-sm text-neutral-400">
          A daily sample of the pre-publish gate&apos;s decisions. For each item, say whether the gate got it
          right. &ldquo;Wrong&rdquo; reverses the decision on the live feed and teaches the classifier.
        </p>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        Admin secret
        <input
          type="password"
          value={secret}
          onChange={(e) => handleSecretChange(e.target.value)}
          className="rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-neutral-100 outline-none focus:border-neutral-500"
          placeholder="CRON_SECRET"
        />
      </label>

      {error && <p className="text-sm text-red-400">{error}</p>}
      {lastResult && <p className="text-sm text-emerald-400">{lastResult}</p>}

      {m && (
        <div className="grid grid-cols-2 gap-3 rounded border border-neutral-800 bg-neutral-900/50 p-4 text-sm sm:grid-cols-4">
          <div>
            <div className="text-2xl font-semibold text-white tabular-nums">{pct(m.overallAccuracy)}</div>
            <div className="text-neutral-400">Gate accuracy</div>
          </div>
          <div>
            <div className="text-2xl font-semibold text-white tabular-nums">{pct(m.approvalPrecision)}</div>
            <div className="text-neutral-400">Approvals right</div>
          </div>
          <div>
            <div className="text-2xl font-semibold text-white tabular-nums">{pct(m.rejectionPrecision)}</div>
            <div className="text-neutral-400">Rejections right</div>
          </div>
          <div>
            <div className="text-2xl font-semibold text-white tabular-nums">{m.graded}</div>
            <div className="text-neutral-400">Graded ({m.windowDays}d) · {m.pending} pending</div>
          </div>
        </div>
      )}

      {data && data.pending.length === 0 && (
        <p className="text-sm text-neutral-500">Nothing to grade - today&apos;s sample is done. Come back tomorrow.</p>
      )}

      <ul className="flex flex-col gap-3">
        {data?.pending.map((s) => {
          const approved = s.gateDecision === "approved";
          return (
            <li key={s.id} className="rounded border border-neutral-800 bg-neutral-900/40 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span
                  className={`rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
                    approved ? "bg-emerald-950 text-emerald-300" : "bg-red-950 text-red-300"
                  }`}
                >
                  gate {approved ? "published" : "rejected"}
                </span>
                <span className="font-mono text-[10px] text-neutral-500">
                  {CATEGORY_LABELS[s.category as Category] ?? s.category} · {s.country ?? "-"} · sev {s.severity} ·{" "}
                  {sourceLabel(s.source)}
                </span>
              </div>
              <p className="mt-2 text-sm text-neutral-100">{stripOutletSuffix(s.title)}</p>
              {s.summary !== s.title && (
                <p className="mt-1 text-xs text-neutral-400">{stripOutletSuffix(s.summary)}</p>
              )}
              {s.gateReasoning && (
                <p className="mt-2 border-l-2 border-neutral-700 pl-2 text-xs text-neutral-500">
                  Gate&apos;s reason: {s.gateReasoning}
                </p>
              )}
              <a href={s.url} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs text-neutral-500 underline">
                open source article
              </a>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  disabled={busyId === s.id}
                  onClick={() => grade(s, "correct")}
                  className="rounded border border-neutral-700 px-3 py-1.5 text-sm text-neutral-200 transition hover:bg-neutral-800 disabled:opacity-50"
                >
                  Gate was right
                </button>
                <button
                  disabled={busyId === s.id}
                  onClick={() => grade(s, "wrong")}
                  className="rounded bg-red-800 px-3 py-1.5 text-sm text-white transition hover:bg-red-700 disabled:opacity-50"
                >
                  Gate was wrong - {approved ? "should be hidden" : "should be published"}
                </button>
                <input
                  value={notes[s.id] ?? ""}
                  onChange={(e) => setNotes((n) => ({ ...n, [s.id]: e.target.value }))}
                  placeholder="optional note"
                  className="min-w-40 flex-1 rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-xs text-neutral-200 outline-none focus:border-neutral-600"
                />
              </div>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
