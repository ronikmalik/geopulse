"use client";

import { useEffect, useState } from "react";
import type { ModelRegistrySummary, ModelSummaryEntry, LiveHorizonTrack } from "@/lib/modelRegistry";

// The trust page (ML roadmap phase 1, 2026-09-20): every model the
// pipeline trains, shown next to the naive alternative it had to beat on
// the same held-out rows, plus the live graded track record and the human
// gate-grading numbers. Deliberately plain — a table a sceptic can read,
// not a dashboard that hides how thin the evidence still is.

const FAMILY_LABEL: Record<string, string> = {
  "risk-score-delta": "Country risk-score forecast (change over horizon)",
  "text-classifier": "Shadow text classifier (k-NN on embeddings)",
  "narrative-clusters": "Narrative clusters (k-means on embeddings)",
};

const FAMILY_BLURB: Record<string, string> = {
  "risk-score-delta":
    "Predicts how much a country's risk score will move over 1-14 days. Baseline is persistence (no change). A model is promoted only when its held-out MAE beats persistence on at least 30 examples; nothing here is shown to users until then.",
  "text-classifier":
    "A k-nearest-neighbour classifier over article embeddings, trained on every kept/dropped decision. It can only be promoted after beating the live Gemini gate on at least 50 human-graded decisions - the one feedback channel that is not Gemini judging Gemini.",
  "narrative-clusters":
    "Groups embedded articles into narratives for the novelty signal. Silhouette near 0 means the clusters are barely better than random; that number is reported as-is.",
};

function num(v: unknown, digits = 2): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "-";
  return Number.isInteger(v) ? v.toLocaleString() : v.toFixed(digits);
}

function pct(v: number | null): string {
  return v === null ? "-" : `${Math.round(v * 100)}%`;
}

function MetricPairs({ m }: { m: Record<string, unknown> | null }) {
  if (!m) return <span className="text-neutral-500">{"-"}</span>;
  const entries = Object.entries(m).filter(([k]) => k !== "name" && k !== "note");
  if (entries.length === 0) return <span className="text-neutral-500">{"-"}</span>;
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1">
      {entries.map(([k, v]) => (
        <span key={k}>
          <span className="text-neutral-500">{k} </span>
          <span className="text-neutral-200">{typeof v === "number" ? num(v, 3) : String(v)}</span>
        </span>
      ))}
    </span>
  );
}

function ModelRow({ m }: { m: ModelSummaryEntry }) {
  return (
    <tr className="border-t border-neutral-800 align-top">
      <td className="py-2 pr-3 font-mono text-xs text-neutral-300">{m.variant}</td>
      <td className="py-2 pr-3 text-xs">
        {!m.trained ? (
          <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-400">not trained</span>
        ) : m.promoted ? (
          <span className="rounded bg-emerald-900/60 px-1.5 py-0.5 text-emerald-300">promoted</span>
        ) : (
          <span className="rounded bg-amber-900/50 px-1.5 py-0.5 text-amber-300">shadow</span>
        )}
      </td>
      <td className="py-2 pr-3 text-xs">
        <MetricPairs m={m.metrics} />
      </td>
      <td className="py-2 pr-3 text-xs">
        {m.baseline ? (
          <>
            <div className="text-neutral-400">{String(m.baseline.name ?? "baseline")}</div>
            <MetricPairs m={m.baseline} />
          </>
        ) : (
          <span className="text-neutral-500">{"-"}</span>
        )}
      </td>
      <td className="py-2 pr-3 text-xs text-neutral-400">
        {m.sampleSize.toLocaleString()} / {m.backtestSampleSize.toLocaleString()}
      </td>
      <td className="py-2 text-xs text-neutral-500">
        {m.trainedAt.slice(0, 10)} · {m.runsRecorded} run{m.runsRecorded === 1 ? "" : "s"}
      </td>
    </tr>
  );
}

function LiveTrack({ rows }: { rows: LiveHorizonTrack[] }) {
  if (rows.length === 0) return <p className="text-sm text-neutral-500">No shadow predictions recorded yet.</p>;
  return (
    <table className="w-full text-left text-sm">
      <thead className="text-xs uppercase tracking-wide text-neutral-500">
        <tr>
          <th className="py-1 pr-3 font-medium">Horizon</th>
          <th className="py-1 pr-3 font-medium">Model</th>
          <th className="py-1 pr-3 font-medium">Predictions</th>
          <th className="py-1 pr-3 font-medium">Graded</th>
          <th className="py-1 pr-3 font-medium">Live MAE</th>
          <th className="py-1 font-medium">Persistence MAE (same rows)</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.horizonDays}-${r.modelType}`} className="border-t border-neutral-800">
            <td className="py-1.5 pr-3 text-neutral-300">{r.horizonDays}d</td>
            <td className="py-1.5 pr-3 font-mono text-xs text-neutral-300">{r.modelType}</td>
            <td className="py-1.5 pr-3 text-neutral-400">{r.predictions}</td>
            <td className="py-1.5 pr-3 text-neutral-400">{r.graded}</td>
            <td className="py-1.5 pr-3 text-neutral-200">{r.liveMae === null ? "-" : num(r.liveMae)}</td>
            <td className="py-1.5 text-neutral-200">{r.livePersistenceMae === null ? "-" : num(r.livePersistenceMae)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function ModelsPage() {
  const [data, setData] = useState<ModelRegistrySummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/models")
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as ModelRegistrySummary;
      })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const families = data ? [...new Set(data.models.map((m) => m.family))] : [];

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-8 px-6 py-12 text-neutral-200">
      <header>
        <h1 className="text-xl font-semibold text-white">Models</h1>
        <p className="mt-1 max-w-3xl text-sm text-neutral-400">
          Every model this system trains, with the held-out numbers the promotion gate sees, next to the naive
          alternative it has to beat on the same rows. &ldquo;Shadow&rdquo; models make predictions that are graded
          against outcomes but never shown to users. Nothing on this page is a language-model opinion; every number is
          computed from stored rows.
        </p>
      </header>

      {error && <p className="text-sm text-red-400">Could not load: {error}</p>}
      {!data && !error && <p className="text-sm text-neutral-500">Loading&hellip;</p>}

      {data && families.length === 0 && (
        <p className="text-sm text-neutral-500">No training runs recorded yet. The weekly trainers write here on Sundays.</p>
      )}

      {data &&
        families.map((family) => (
          <section key={family} className="rounded border border-neutral-800 bg-neutral-900/50 p-4">
            <h2 className="text-base font-medium text-white">{FAMILY_LABEL[family] ?? family}</h2>
            {FAMILY_BLURB[family] && <p className="mt-1 mb-3 max-w-3xl text-xs text-neutral-400">{FAMILY_BLURB[family]}</p>}
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-neutral-500">
                  <tr>
                    <th className="py-1 pr-3 font-medium">Variant</th>
                    <th className="py-1 pr-3 font-medium">Status</th>
                    <th className="py-1 pr-3 font-medium">Held-out metrics</th>
                    <th className="py-1 pr-3 font-medium">Baseline (same rows)</th>
                    <th className="py-1 pr-3 font-medium">Train / test n</th>
                    <th className="py-1 font-medium">Last trained</th>
                  </tr>
                </thead>
                <tbody>
                  {data.models
                    .filter((m) => m.family === family)
                    .map((m) => (
                      <ModelRow key={`${m.family}-${m.variant}`} m={m} />
                    ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}

      {data && (
        <section className="rounded border border-neutral-800 bg-neutral-900/50 p-4">
          <h2 className="text-base font-medium text-white">Live track record: risk-score forecasts</h2>
          <p className="mt-1 mb-3 max-w-3xl text-xs text-neutral-400">
            Predictions made before their outcome was knowable, graded automatically once the horizon resolves. This is
            stronger evidence than any backtest. Persistence MAE is what &ldquo;predict no change&rdquo; would have scored
            on exactly the same graded predictions.
          </p>
          <LiveTrack rows={data.liveTrack} />
        </section>
      )}

      {data && (
        <section className="rounded border border-neutral-800 bg-neutral-900/50 p-4">
          <h2 className="text-base font-medium text-white">Human ground truth: pre-publish gate</h2>
          <p className="mt-1 mb-3 max-w-3xl text-xs text-neutral-400">
            Ten of the gate&rsquo;s decisions are sampled every day for a person to grade. These grades are the only
            feedback in the system that is not a model judging a model, and the shadow classifier cannot be promoted
            until at least 50 exist.
          </p>
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
            <div>
              <div className="text-xs text-neutral-500">Graded (30d)</div>
              <div className="text-neutral-100">{data.gate.graded}</div>
            </div>
            <div>
              <div className="text-xs text-neutral-500">Awaiting grade</div>
              <div className="text-neutral-100">{data.gate.pending}</div>
            </div>
            <div>
              <div className="text-xs text-neutral-500">Approval precision</div>
              <div className="text-neutral-100">{pct(data.gate.approvalPrecision)}</div>
            </div>
            <div>
              <div className="text-xs text-neutral-500">Rejection precision</div>
              <div className="text-neutral-100">{pct(data.gate.rejectionPrecision)}</div>
            </div>
            <div>
              <div className="text-xs text-neutral-500">Overall accuracy</div>
              <div className="text-neutral-100">{pct(data.gate.overallAccuracy)}</div>
            </div>
          </div>
        </section>
      )}

      {data && (
        <p className="text-xs text-neutral-600">
          Generated {data.generatedAt.replace("T", " ").slice(0, 16)} UTC. Cached up to an hour.
        </p>
      )}
    </main>
  );
}
