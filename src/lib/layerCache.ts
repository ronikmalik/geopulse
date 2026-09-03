// Small in-memory TTL cache shared by the /api/layers/* routes. These proxy
// external APIs with tight free-tier rate limits (CISA KEV, OpenSky) or
// slow-changing data (World Bank GDP/population) — caching per warm
// serverless instance avoids re-fetching upstream on every client poll.
const store = new Map<string, { data: unknown; expiresAt: number }>();

export async function withCache<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  const hit = store.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    return hit.data as T;
  }
  const data = await fetcher();
  store.set(key, { data, expiresAt: Date.now() + ttlMs });
  return data;
}
