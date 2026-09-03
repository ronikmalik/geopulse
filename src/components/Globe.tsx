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
}

export default function GlobeView({
  events,
  onSelect,
  flyToId,
  countryScores = [],
  selectedCountry = null,
  onCountryClick,
  extraPoints = [],
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

  // Selecting a country and a countryScores refresh can each ask for a
  // polygon repaint within the same tick. Firing .polygonsData() twice in
  // quick succession raced three-globe's mesh rebuild — country A's border
  // white-highlight would sometimes only partially apply (some ring
  // segments still red) because a second rebuild interrupted the first
  // mid-flight. Coalescing to one rAF-deferred call per frame means only
  // the latest ref values ever get applied, and only once.
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
        .polygonStrokeColor((d) =>
          polygonCountryCode(d) === selectedCountryRef.current
            ? "#ffffff"
            : RED,
        )
        .polygonAltitude(0.004)
        .polygonLabel((d) => {
          const code = polygonCountryCode(d);
          const score = code ? scoreByCountryRef.current[code] : undefined;
          const threat = code ? threatByCountryRef.current[code] : undefined;
          const name =
            (d as { properties?: { name?: string } }).properties?.name ?? "";
          const threatLine = threat
            ? `<br/>threat level: ${threat.threatLabel} · momentum ${threat.momentum}`
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
    globe.pointsData([...events, ...extraPoints]);

    const latest = [...events]
      .sort(
        (a, b) =>
          new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(),
      )
      .slice(0, 12)
      .filter((e) => e.severity >= 3);
    globe.ringsData(latest);
  }, [events, extraPoints, ready]);

  useEffect(() => {
    const globe = globeRef.current;
    if (!globe || !ready || flyToId == null) return;
    const target = events.find((e) => e.id === flyToId);
    if (!target) return;
    globe.pointOfView({ lat: target.lat, lng: target.lon, altitude: 1.4 }, 1200);
  }, [flyToId, events, ready]);

  return <div ref={containerRef} className="h-full w-full" />;
}
