"use client";

import { useEffect, useState } from "react";

interface Status {
  liveCount: number;
  killedCount: number;
  lastActivatedAt: string | null;
}

const SECRET_KEY = "geopulse_admin_secret";
const CONFIRM_TEXT = "KILL";

async function loadStatus(secret: string): Promise<{ status: Status | null; error: string | null }> {
  try {
    const res = await fetch("/api/admin/kill-switch", {
      headers: { Authorization: `Bearer ${secret}` },
    });
    if (!res.ok) {
      return { status: null, error: res.status === 401 ? "Wrong secret." : `Request failed (${res.status}).` };
    }
    return { status: await res.json(), error: null };
  } catch {
    return { status: null, error: "Network error." };
  }
}

export default function KillSwitchPage() {
  const [secret, setSecret] = useState<string>(() =>
    typeof window === "undefined" ? "" : (sessionStorage.getItem(SECRET_KEY) ?? ""),
  );
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!secret) return;
    let cancelled = false;
    loadStatus(secret).then((result) => {
      if (cancelled) return;
      setStatus(result.status);
      setError(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, [secret, refreshKey]);

  function handleSecretChange(v: string) {
    setSecret(v);
    sessionStorage.setItem(SECRET_KEY, v);
    if (!v) setStatus(null);
  }

  async function runAction(action: "activate" | "restore") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/kill-switch?action=${action}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}` },
      });
      if (!res.ok) {
        setError(res.status === 401 ? "Wrong secret." : `Request failed (${res.status}).`);
        return;
      }
      setRefreshKey((k) => k + 1);
      setConfirmText("");
    } catch {
      setError("Network error.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col gap-6 px-6 py-16 text-neutral-200">
      <div>
        <h1 className="text-xl font-semibold text-white">Feed Kill Switch</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Hides every currently-live event from the feed, risk scores, and anomaly
          signals. Nothing is deleted — hidden rows stay in the database, and can be
          restored at any time.
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

      {status && (
        <div className="grid grid-cols-2 gap-3 rounded border border-neutral-800 bg-neutral-900/50 p-4 text-sm">
          <div>
            <div className="text-2xl font-semibold text-white tabular-nums">{status.liveCount}</div>
            <div className="text-neutral-400">Live events</div>
          </div>
          <div>
            <div className="text-2xl font-semibold text-white tabular-nums">{status.killedCount}</div>
            <div className="text-neutral-400">Hidden events</div>
          </div>
          <div className="col-span-2 text-neutral-500">
            Last activated:{" "}
            {status.lastActivatedAt ? new Date(status.lastActivatedAt).toLocaleString() : "never"}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-3 rounded border border-red-900/50 bg-red-950/20 p-4">
        <p className="text-sm text-neutral-300">
          Type <span className="font-mono font-semibold text-red-300">{CONFIRM_TEXT}</span> to
          activate the kill switch.
        </p>
        <input
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          className="rounded border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-neutral-100 outline-none focus:border-neutral-500"
          placeholder={CONFIRM_TEXT}
        />
        <button
          disabled={busy || confirmText !== CONFIRM_TEXT || !secret}
          onClick={() => runAction("activate")}
          className="rounded bg-red-700 px-4 py-2 text-sm font-medium text-white transition disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
        >
          {busy ? "Working…" : "Activate kill switch"}
        </button>
      </div>

      <button
        disabled={busy || !secret || !status || status.killedCount === 0}
        onClick={() => runAction("restore")}
        className="rounded border border-neutral-700 px-4 py-2 text-sm font-medium text-neutral-200 transition hover:bg-neutral-900 disabled:cursor-not-allowed disabled:text-neutral-600"
      >
        {busy ? "Working…" : "Restore hidden events"}
      </button>
    </main>
  );
}
