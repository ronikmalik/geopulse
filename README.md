# GeoPulse

Real-time global risk intelligence. GeoPulse ingests public data across
conflict, political instability, climate, natural hazards, humanitarian
conditions, infrastructure, and cyber signals, correlates it by country,
and renders it on a live 3D globe with a Threat Level + Momentum
assessment per country and per risk pillar — not a single falsely-precise
"risk score."

Live at: https://geopulse-peach-eight.vercel.app

## How it's organized

- **Eight risk pillars** (`src/lib/pillars.ts`): Geopolitical & Security,
  Political & Governance, Climate & Environment, Natural & Biological
  Hazards, Human & Social, Infrastructure & Connectivity, Supply Chain &
  Resource Security, Cyber & Technology.
- **Threat Level (1–5) + Momentum (0–100, directional)** per country and
  per pillar (`src/lib/threat.ts`, `src/lib/risk.ts`), combined via an
  escalation model rather than an average — see `docs/ROADMAP.md` for the
  full design rationale and what's still ahead.
- **Live event feed**: GDELT + curated RSS for geopolitical/political news,
  USGS/NASA EONET/GDACS for natural hazards and climate events, IODA for
  internet-outage detection — see `src/lib/sources/README.md` for every
  integrated source and `src/lib/sourceRegistry.ts` for each one's
  licensing/commercial-use terms.
- **Live data layers**: flights, weather, satellites, crypto, macro
  indicators, forex, CFTC positioning, and actively-exploited
  vulnerabilities (CISA KEV) — opt-in from the Data Layers tab.

`docs/ROADMAP.md` tracks the full blueprint this is built against and what
phase of it is actually implemented.

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). You'll need a
`DATABASE_URL` (Postgres — this project uses Neon) in `.env.local` for the
event feed and risk panel to have data; see `src/db/schema.ts` for the
schema and `npm run db:push` to apply it.

To pull in fresh events locally: `npm run ingest` (calls the same ingest
pipeline the production cron job runs every ~15 minutes).

## Stack

Next.js (App Router) · Postgres via Drizzle ORM (Neon) · globe.gl / three.js
for the 3D globe · Server-Sent Events for the live feed.
