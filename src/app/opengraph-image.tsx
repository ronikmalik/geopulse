import { ImageResponse } from "next/og";

// Link-preview image for chat apps and social sites. No request-time data,
// so Next renders it once at build time and serves the static PNG.
export const alt = "GeoPulse - live global risk intelligence on a 3D globe";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          background: "#000000",
          padding: "0 80px",
          fontFamily: "monospace",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
          <div style={{ fontSize: 88, fontWeight: 700, letterSpacing: 18, color: "#ef4444" }}>
            GEOPULSE
          </div>
          <div style={{ fontSize: 26, letterSpacing: 8, color: "#991b1b", marginTop: 8 }}>
            GLOBAL RISK INTELLIGENCE
          </div>
          <div style={{ fontSize: 30, color: "#d4d4d4", marginTop: 48, lineHeight: 1.4, maxWidth: 620 }}>
            Conflict, instability, hazards, infrastructure and cyber signals, scored per country and
            shown live on a globe.
          </div>
        </div>
        <div
          style={{
            width: 360,
            height: 360,
            borderRadius: 9999,
            border: "3px solid #ff2d2d",
            background: "radial-gradient(circle at 40% 35%, #3b0000 0%, #120000 55%, #000000 100%)",
            boxShadow: "0 0 90px 20px rgba(255, 30, 30, 0.35)",
            display: "flex",
          }}
        />
      </div>
    ),
    size,
  );
}
