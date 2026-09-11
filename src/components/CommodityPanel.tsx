"use client";

import type { CommodityResponse } from "@/lib/dataLayerTypes";

interface CommodityPanelProps {
  data: CommodityResponse | null;
}

function formatPrice(price: number, unit: string): string {
  if (unit === "$/oz") {
    return `$${price.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  }
  return `$${price.toFixed(2)}`;
}

export default function CommodityPanel({ data }: CommodityPanelProps) {
  const commodities = data?.commodities ?? [];

  return (
    <div className="flex flex-col border-t border-red-950/50">
      <div className="p-3">
        <h2 className="mb-1 font-mono text-xs uppercase tracking-[0.2em] text-red-500">
          Commodities
        </h2>
        <p className="mb-3 font-mono text-[10px] text-red-800">
          Energy (EIA) &amp; precious metals (community FX mirror) — supply-shock and
          safe-haven barometers
        </p>

        {commodities.length === 0 && (
          <p className="p-1 font-mono text-xs text-neutral-600">
            Loading live prices…
          </p>
        )}

        {commodities.map((c) => {
          const up = (c.changePct ?? 0) >= 0;
          return (
            <div
              key={c.id}
              className="mb-1.5 flex items-center justify-between gap-3 rounded border border-neutral-800 px-3 py-2"
            >
              <span className="font-mono text-xs text-red-300">{c.label}</span>
              <span className="font-mono text-xs text-neutral-300">
                {formatPrice(c.price, c.unit)}
                <span className="ml-1 text-neutral-600">{c.unit}</span>
              </span>
              <span
                className={`w-16 shrink-0 text-right font-mono text-[11px] ${
                  c.changePct == null
                    ? "text-neutral-600"
                    : up
                      ? "text-emerald-500"
                      : "text-red-500"
                }`}
              >
                {c.changePct == null ? "—" : `${up ? "+" : ""}${c.changePct.toFixed(2)}%`}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
