"use client";

import type { CftcResponse, ForexResponse } from "@/lib/dataLayerTypes";

interface ForexPanelProps {
  data: ForexResponse | null;
  cftc: CftcResponse | null;
}

function formatContracts(n: number): string {
  const abs = Math.abs(n);
  const formatted = abs >= 1000 ? `${(abs / 1000).toFixed(1)}K` : String(abs);
  return `${n >= 0 ? "+" : "-"}${formatted}`;
}

export default function ForexPanel({ data, cftc }: ForexPanelProps) {
  const rates = data?.rates ?? [];
  const positionsByCurrency = new Map(
    (cftc?.positions ?? []).map((p) => [p.currency, p]),
  );

  return (
    <div className="flex flex-col">
      <div className="p-3">
        <h2 className="mb-1 font-mono text-xs uppercase tracking-[0.2em] text-red-500">
          Forex
        </h2>
        <p className="mb-3 font-mono text-[10px] text-red-800">
          USD vs. major and geopolitically exposed currencies — Frankfurter / ECB
        </p>

        {rates.length === 0 && (
          <p className="p-1 font-mono text-xs text-neutral-600">
            Loading live rates…
          </p>
        )}

        {rates.map((r) => {
          const up = r.changePct >= 0;
          const currency = r.pair.split("/")[1];
          const position = positionsByCurrency.get(currency);
          return (
            <div
              key={r.pair}
              className="mb-1.5 rounded border border-neutral-800 px-3 py-2"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="font-mono text-xs text-red-300">{r.pair}</span>
                <span className="font-mono text-xs text-neutral-300">
                  {r.rate < 1 ? r.rate.toFixed(4) : r.rate.toFixed(2)}
                </span>
                <span
                  className={`w-16 shrink-0 text-right font-mono text-[11px] ${
                    up ? "text-emerald-500" : "text-red-500"
                  }`}
                >
                  {up ? "+" : ""}
                  {r.changePct.toFixed(2)}%
                </span>
              </div>
              {position && (
                <div className="mt-1 flex items-center justify-between text-[10px] text-neutral-500">
                  <span>
                    CFTC spec. net{" "}
                    <span
                      className={
                        position.netSpeculativePosition >= 0
                          ? "text-emerald-500"
                          : "text-red-500"
                      }
                    >
                      {position.netSpeculativePosition >= 0 ? "LONG" : "SHORT"}{" "}
                      {formatContracts(position.netSpeculativePosition)}
                    </span>
                  </span>
                  <span>{position.reportDate}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
