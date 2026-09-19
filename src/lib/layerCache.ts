// Small in-memory TTL cache shared by the /api/layers/* routes. These proxy
// external APIs with tight free-tier rate limits (CISA KEV, OpenSky) or
// slow-changing data (World Bank GDP/population) — caching per warm
// serverless instance avoids re-fetching upstream on every client poll.
const store = new Map<string, { data: unknown; expiresAt: number }>();
const inFlight = new Map<string, Promise<unknown>>();

export async function withCache<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  const hit = store.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    return hit.data as T;
  }
  const pending = inFlight.get(key);
  if (pending) return pending as Promise<T>;
  const request = Promise.resolve().then(fetcher).then((data) => {
    store.set(key, { data, expiresAt: Date.now() + ttlMs });
    return data;
  }).finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
}
