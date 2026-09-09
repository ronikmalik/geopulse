"use client";

import { useEffect, useRef, useState } from "react";
import * as topojson from "topojson-client";
import countries110m from "world-atlas/countries-110m.json";
import type { GeoEvent } from "@/lib/types";
import type { GlobeInstance } from "globe.gl";
import type { Topology, GeometryCollection } from "topojson-specification";
import type * as THREE from "three";
import { ISO_NUMERIC_TO_ALPHA2 } from "@/lib/isoCountries";
import type { CountryRiskScore } from "@/lib/useCountryRisk";
import type { ExtraMapPoint } from "@/lib/mapPoints";

type GlobePoint = GeoEvent | ExtraMapPoint;

function isExtraPoint(d: GlobePoint): d is ExtraMapPoint {
  return "kind" in d;
}

const RED = "#ff2d2d";

const countryFeatures = topojson.feature(
  countries110m as unknown as Topology,
  (countries110m as unknown as Topology).objects
    .countries as GeometryCollection,
).features;

interface CountryPolygon {
  id?: string;
}

function polygonCountryCode(feature: unknown): string | null {
  const id = (feature as CountryPolygon).id;
  return id ? (ISO_NUMERIC_TO_ALPHA2[id] ?? null) : null;
}

// Multiple events can legitimately land on the exact same coordinate —
// pre-backfill RSS/Telegram events still sitting at classify.ts's
// country-centroid fallback (see geocodeBackfill.ts), two real stories
// about the same city, or independent Gemini geocode calls landing on
// slightly different points for the same place. Rather than stack
// indistinguishable markers where whichever one three-globe's raycaster
// happens to hit first "wins" the click (2026-09-09 user report: a
// Russia click landed on an 18-hour-old avalanche story instead of a
// 49-minute-old update sitting at the exact same point), only the single
// most recent event at each coordinate is actually plotted as a
// clickable/hoverable point on the globe — every event stays fully
// visible in the Feed panel regardless, this only thins out what
// competes for the same globe pixel. Rounded to 2 decimal degrees
// (~1.1km) rather than an exact match so near-identical-but-not-quite
// coordinates still collapse to one marker instead of two dots a user
// can't visually tell apart at globe scale.
function dedupeByCoordinateKeepingNewest(items: GeoEvent[]): GeoEvent[] {
  const byKey = new Map<string, GeoEvent>();
  for (const item of items) {
    const key = `${item.lat.toFixed(2)},${item.lon.toFixed(2)}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, item);
      continue;
    }
    // publishedAt travels over JSON (SSE/fetch) as a plain string, same
    // as usePulsingEvents.ts's identical cast-and-parse.
    const itemTime = new Date(item.publishedAt as unknown as string).getTime();
    const existingTime = new Date(existing.publishedAt as unknown as string).getTime();
    if (itemTime > existingTime || (itemTime === existingTime && item.id > existing.id)) {
      byKey.set(key, item);
    }
  }
  return [...byKey.values()];
}

function severityColor(severity: number): string {
  if (severity >= 5) return "#ff0000";
  if (severity >= 4) return "#ff3b3b";
  if (severity >= 3) return "#ff6b3b";
  return "#ff9a3b";
}

// Highest observed decayed score maps to full intensity; tuned for the
// current 3-day-half-life scoring in src/lib/risk.ts.
const SCORE_SATURATION = 15;

function scoreFillColor(score: number | undefined): string {
  if (!score) return "rgba(0,0,0,0)";
  const t = Math.min(score / SCORE_SATURATION, 1);
  return `rgba(255,45,45,${0.08 + t * 0.42})`;
}

interface GlobeViewProps {
  events: GeoEvent[];
  onSelect: (event: GeoEvent) => void;
  flyToId?: number | null;
  countryScores?: CountryRiskScore[];
  selectedCountry?: string | null;
  onCountryClick?: (country: string) => void;
  extraPoints?: ExtraMapPoint[];
  // Event ids that should currently render a pulsing ring, at their exact
  // plotted lat/lon — every event still within its recent-age window
  // ripples continuously, regardless of whether it arrived via live SSE
  // or the initial backfill (see src/lib/usePulsingEvents.ts). Not
  // provided → no rings, same as before this existed.
  pulsingIds?: Set<number>;
}

export default function GlobeView({
  events,
  onSelect,
  flyToId,
  countryScores = [],
  selectedCountry = null,
  onCountryClick,
  extraPoints = [],
  pulsingIds,
}: GlobeViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const globeRef = useRef<GlobeInstance | null>(null);
  const onSelectRef = useRef(onSelect);
  const onCountryClickRef = useRef(onCountryClick);
  const scoreByCountryRef = useRef<Record<string, number>>({});
  const threatByCountryRef = useRef<
    Record<string, { threatLabel: string; momentum: number }>
  >({});
  const selectedCountryRef = useRef(selectedCountry);
  const refreshScheduledRef = useRef(false);
  const [ready, setReady] = useState(false);

  // Selecting a country and a countryScores refresh can each ask for a
  // polygon repaint within the same tick. Firing .polygonsData() twice in
  // quick succession raced three-globe's mesh rebuild — country A's border
  // white-highlight would sometimes only partially apply (some ring
  // segments still red) because a second rebuild interrupted the first
  // mid-flight. Coalescing to one rAF-deferred call per frame means only
  // the latest ref values ever get applied, and only once.
  //
  // Declared here (above the effects that call it) rather than after them
  // — function declarations hoist either way, but the React Compiler
  // linter's dependency analysis wants call sites to follow the
  // declaration in source order.
  function refreshPolygons() {
    if (refreshScheduledRef.current) return;
    refreshScheduledRef.current = true;
    requestAnimationFrame(() => {
      refreshScheduledRef.current = false;
      const globeExt = globeRef.current as unknown as {
        polygonsData?: (d: unknown[]) => void;
      } | null;
      // New array reference forces three-globe to re-evaluate every accessor.
      globeExt?.polygonsData?.([...countryFeatures]);
    });
  }

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    onCountryClickRef.current = onCountryClick;
  }, [onCountryClick]);

  useEffect(() => {
    selectedCountryRef.current = selectedCountry;
    refreshPolygons();
  }, [selectedCountry]);

  useEffect(() => {
    const map: Record<string, number> = {};
    const threatMap: Record<string, { threatLabel: string; momentum: number }> = {};
    for (const s of countryScores) {
      map[s.country] = s.score;
      threatMap[s.country] = { threatLabel: s.threatLabel, momentum: s.momentum };
    }
    scoreByCountryRef.current = map;
    threatByCountryRef.current = threatMap;
    refreshPolygons();
  }, [countryScores]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;

    import("globe.gl").then(({ default: Globe }) => {
      if (disposed) return;

      const globe = new Globe(container, {
        animateIn: true,
      })
        .backgroundColor("rgba(0,0,0,0)")
        .showAtmosphere(true)
        .atmosphereColor(RED)
        .atmosphereAltitude(0.18)
        .pointsMerge(false)
        .pointLat((d) => (d as GlobePoint).lat)
        .pointLng((d) => (d as GlobePoint).lon)
        .pointAltitude((d) => {
          const p = d as GlobePoint;
          return isExtraPoint(p) ? 0.012 : 0.015 + p.severity * 0.008;
        })
        .pointRadius((d) => {
          const p = d as GlobePoint;
          return isExtraPoint(p) ? p.radius : 0.35 + p.severity * 0.12;
        })
        .pointColor((d) => {
          const p = d as GlobePoint;
          return isExtraPoint(p) ? p.color : severityColor(p.severity);
        })
        .pointLabel((d) => {
          const p = d as GlobePoint;
          const body = isExtraPoint(p)
            ? p.label
            : `<b>${p.location}</b><br/>${p.summary}`;
          return `<div style="font-family:monospace;color:#ff5555;background:#0a0000;border:1px solid #ff2d2d;padding:6px 8px;border-radius:2px;max-width:260px">
              ${body}
            </div>`;
        })
        .onPointClick((d) => {
          const p = d as GlobePoint;
          if (!isExtraPoint(p)) onSelectRef.current(p);
        })
        .ringsData([])
        .ringLat((d) => (d as GeoEvent).lat)
        .ringLng((d) => (d as GeoEvent).lon)
        // three-globe's ring layer defaults to altitude 0.0015 — below this
        // globe's polygonAltitude(0.004) country-fill layer below, so every
        // ring was rendering underneath that semi-opaque surface and never
        // actually visible, regardless of pulsingIds. Found while verifying
        // the 2026-09-05 "I want the pulses to ripple" fix live: the hook
        // logic was correct, but nothing had ever been able to render on
        // top of the country fill. 0.006 sits above the polygon layer and
        // below the lowest point-marker altitude (~0.012), so a ripple
        // reads as "on the ground," not floating above the markers.
        .ringAltitude(0.006)
        .ringColor(() => (t: number) => `rgba(255,45,45,${1 - t})`)
        .ringMaxRadius(4)
        .ringPropagationSpeed(2.2)
        .ringRepeatPeriod(900);

      // three-globe's raw GeoJSON polygon layer (borders only, no h3 hexbinning)
      // isn't in globe.gl's shipped .d.ts, so it's accessed via a permissive cast.
      const globeExt = globe as unknown as {
        polygonsData: (d: unknown[]) => typeof globe;
        polygonCapColor: (fn: (d: unknown) => string) => typeof globe;
        polygonSideColor: (fn: () => string) => typeof globe;
        polygonStrokeColor: (fn: (d: unknown) => string) => typeof globe;
        polygonAltitude: (n: number) => typeof globe;
        polygonLabel: (fn: (d: unknown) => string) => typeof globe;
        onPolygonClick: (fn: (d: unknown) => void) => typeof globe;
        polygonsTransitionDuration: (n: number) => typeof globe;
      };
      globeExt
        .polygonsTransitionDuration(0)
        .polygonsData(countryFeatures)
        .polygonCapColor((d) =>
          scoreFillColor(
            scoreByCountryRef.current[polygonCountryCode(d) ?? ""],
          ),
        )
        .polygonSideColor(() => "rgba(255,20,20,0.04)")
        .polygonStrokeColor((d) => {
          // polygonCountryCode returns null for territories with no ISO
          // alpha-2 mapping in world-atlas's data (Somaliland, Kosovo,
          // Northern Cyprus, etc. — Natural Earth encodes these with a
          // sentinel id, not a real ISO 3166-1 numeric code). With no
          // guard here, "nothing selected" (selectedCountryRef.current
          // === null) made every one of those null === null, so all of
          // them lit up white as if selected. Requiring a real code before
          // comparing means "unselected" only ever matches a null
          // selection, not a null code.
          const code = polygonCountryCode(d);
          return code !== null && code === selectedCountryRef.current
            ? "#ffffff"
            : RED;
        })
        .polygonAltitude(0.004)
        .polygonLabel((d) => {
          const code = polygonCountryCode(d);
          const score = code ? scoreByCountryRef.current[code] : undefined;
          const threat = code ? threatByCountryRef.current[code] : undefined;
          const name =
            (d as { properties?: { name?: string } }).properties?.name ?? "";
          const threatLine = threat
            ? `<br/>pulse: ${threat.threatLabel} · momentum ${threat.momentum}`
            : "";
          return `<div style="font-family:monospace;color:#ff5555;background:#0a0000;border:1px solid #ff2d2d;padding:6px 8px;border-radius:2px">
              <b>${name}</b>${score ? threatLine : ""}
            </div>`;
        })
        .onPolygonClick((d) => {
          const code = polygonCountryCode(d);
          if (code) onCountryClickRef.current?.(code);
        });

      globe.pointOfView({ lat: 25, lng: 30, altitude: 2.3 });

      const globeMaterial = globe.globeMaterial() as THREE.MeshPhongMaterial;
      globeMaterial.color = new (globeMaterial.color.constructor as new (
        c: string,
      ) => typeof globeMaterial.color)("#000000");
      globeMaterial.emissive = new (
        globeMaterial.emissive!.constructor as new (
          c: string,
        ) => typeof globeMaterial.emissive
      )("#1a0000");
      globeMaterial.emissiveIntensity = 0.3;
      globeMaterial.shininess = 8;

      const controls = globe.controls() as {
        autoRotate: boolean;
        autoRotateSpeed: number;
        enableDamping: boolean;
      };
      controls.autoRotate = true;
      controls.autoRotateSpeed = 0.35;
      controls.enableDamping = true;

      const handleResize = () => {
        globe.width(container.clientWidth).height(container.clientHeight);
      };
      window.addEventListener("resize", handleResize);
      handleResize();

      globeRef.current = globe;
      (
        globeRef.current as unknown as { __cleanup?: () => void }
      ).__cleanup = () => window.removeEventListener("resize", handleResize);
      if (!disposed) setReady(true);
    });

    return () => {
      disposed = true;
      const g = globeRef.current as unknown as {
        __cleanup?: () => void;
      } | null;
      g?.__cleanup?.();
      globeRef.current = null;
      container.innerHTML = "";
    };
  }, []);

  useEffect(() => {
    const globe = globeRef.current;
    if (!globe || !ready) return;
    const visibleEvents = dedupeByCoordinateKeepingNewest(events);
    globe.pointsData([...visibleEvents, ...extraPoints]);

    // Every still-recent event pulses at its exact plotted location
    // (regardless of severity/category) — see usePulsingEvents. Filtered
    // against `events` (the already-category-filtered list), not
    // `visibleEvents` — an older event a coordinate collision hid from
    // the point layer should still ripple when it first arrives; the
    // ring renders at the same lat/lon as whichever point is currently
    // showing there either way, so this reads as "something just
    // happened here," not a stray ring with nothing under it.
    globe.ringsData(
      pulsingIds ? events.filter((e) => pulsingIds.has(e.id)) : [],
    );
  }, [events, extraPoints, ready, pulsingIds]);

  useEffect(() => {
    const globe = globeRef.current;
    if (!globe || !ready || flyToId == null) return;
    const target = events.find((e) => e.id === flyToId);
    if (!target) return;
    globe.pointOfView({ lat: target.lat, lng: target.lon, altitude: 1.4 }, 1200);
  }, [flyToId, events, ready]);

  return <div ref={containerRef} className="h-full w-full" />;
}
