import type { NextConfig } from "next";

// This app has almost no external runtime dependencies from the browser:
// globe.gl renders without a texture URL (see Globe.tsx — no
// globeImageUrl is ever set), fonts are self-hosted via next/font/google
// (downloaded at build time, never fetched from fonts.googleapis.com at
// request time), and every client-side fetch() call targets this app's
// own /api/* routes (verified across CountryRiskPanel/FeedPanel/
// TrendsPanel/page.tsx). The one real exception is LiveWirePanel's
// embedded YouTube live-broadcast <iframe> (src/lib/liveNews.ts) —
// frame-src has to explicitly allow youtube.com or the browser silently
// drops the embed (frame-src falls back to default-src 'self' when
// unset, and a cross-origin iframe isn't 'self'). Learned this the hard
// way: shipping this CSP without frame-src broke Live Wire in production
// with zero console signal pointing at CSP as the cause.
//
// script-src/style-src need 'unsafe-inline': Next's App Router streams RSC
// payloads to the client via inline `<script>self.__next_f.push(...)</script>`
// tags injected straight into the HTML (not a next/script call this app
// controls) — verified live: `script-src 'self'` with no 'unsafe-inline'
// silently breaks hydration on every page load (React minified error #412,
// stuck "CONNECTING" state, black globe) because those inline scripts never
// run. The clean fix is a per-request nonce via middleware, which is more
// fragile to keep correct across Next upgrades than the risk this weakens:
// nothing in this app renders raw HTML from user/feed content (no
// dangerouslySetInnerHTML anywhere in src/), so there's no injection point
// for an attacker-controlled inline <script> to exploit in the first place.
// The rest of the policy (no external script/style/img/font/connect hosts,
// no plugins, no framing of this site by others) still holds.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-src https://www.youtube.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: CSP },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
