"use client";

import { useEffect, useState } from "react";
import {
  LIVE_CHANNELS,
  suggestLiveChannel,
  liveEmbedUrl,
  DEFAULT_LIVE_CHANNEL,
  type LiveChannelId,
} from "@/lib/liveNews";
import ForexPanel from "./ForexPanel";
import type { CftcResponse, ForexResponse } from "@/lib/dataLayerTypes";

interface LiveWirePanelProps {
  selectedCountry: string | null;
  forex: ForexResponse | null;
  cftc: CftcResponse | null;
}

const regionNames =
  typeof Intl !== "undefined"
    ? new Intl.DisplayNames(["en"], { type: "region" })
    : null;

function countryName(code: string): string {
  try {
    return regionNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

export default function LiveWirePanel({
  selectedCountry,
  forex,
  cftc,
}: LiveWirePanelProps) {
  const [channelId, setChannelId] = useState<LiveChannelId>(DEFAULT_LIVE_CHANNEL);
  const [manualOverride, setManualOverride] = useState(false);

  // Follow the selected country's suggested broadcaster — unless the user
  // has manually picked a different one, in which case their choice sticks
  // until they clear the country selection.
  // react-hooks/set-state-in-effect flags both effects below. They're
  // genuinely syncing internal state to the selectedCountry prop (with a
  // manual-override escape hatch), which react.dev/learn/you-might-not-
  // need-an-effect's "adjust state when a prop changes" pattern would
  // normally replace with a render-time comparison — but that pattern
  // doesn't compose cleanly with two independent triggers (country change
  // and override-cleared) feeding the same state. Left as effects rather
  // than restructured without being able to verify the UI live.
  useEffect(() => {
    if (manualOverride) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setChannelId(suggestLiveChannel(selectedCountry));
  }, [selectedCountry, manualOverride]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!selectedCountry) setManualOverride(false);
  }, [selectedCountry]);

  const channel = LIVE_CHANNELS[channelId];
  const isAuto = !manualOverride;

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="border-b border-red-950 p-3">
        <div className="mb-1.5 flex items-center justify-between">
          <h2 className="font-mono text-xs uppercase tracking-[0.2em] text-red-500">
            Live Wire
          </h2>
          {isAuto ? (
            <span className="font-mono text-[9px] uppercase tracking-wider text-neutral-600">
              auto
            </span>
          ) : (
            <button
              onClick={() => setManualOverride(false)}
              className="font-mono text-[9px] uppercase tracking-wider text-neutral-500 hover:text-red-400"
            >
              reset to auto
            </button>
          )}
        </div>
        <p className="mb-2 font-mono text-[10px] text-red-800">
          {selectedCountry
            ? `Suggested for ${countryName(selectedCountry)}: ${channel.region}`
            : "No country selected — showing global coverage."}
        </p>

        <div className="aspect-video w-full overflow-hidden rounded border border-neutral-800 bg-black">
          <iframe
            key={channel.id}
            src={liveEmbedUrl(channel.id)}
            title={`${channel.name} live`}
            className="h-full w-full"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
          />
        </div>

        <div className="mt-2 flex flex-wrap gap-1.5">
          {Object.entries(LIVE_CHANNELS).map(([id, c]) => (
            <button
              key={id}
              onClick={() => {
                setChannelId(id as LiveChannelId);
                setManualOverride(true);
              }}
              className={`rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider transition ${
                channelId === id
                  ? "border-red-500 bg-red-950/60 text-red-300"
                  : "border-neutral-800 text-neutral-600 hover:border-red-900 hover:text-red-700"
              }`}
              title={c.region}
            >
              {c.name}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1">
        <ForexPanel data={forex} cftc={cftc} />
      </div>
    </div>
  );
}
