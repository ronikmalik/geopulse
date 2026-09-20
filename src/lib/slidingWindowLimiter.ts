// Minimal in-process sliding-window rate limiter: at most `maxCalls`
// reservations in any trailing `windowMs`. Reservations are serialised
// through a promise chain so concurrent callers cannot both observe "one
// slot left" and both take it. No dependency, same bar as every other
// small utility in this app. Sole consumer today: geminiAuditClient.ts.
export class SlidingWindowLimiter {
  private readonly times: number[] = [];
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly maxCalls: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  reserve(): Promise<void> {
    const mine = this.chain.then(async () => {
      for (;;) {
        const t = this.now();
        while (this.times.length > 0 && t - this.times[0] >= this.windowMs) this.times.shift();
        if (this.times.length < this.maxCalls) {
          this.times.push(t);
          return;
        }
        await this.sleep(this.windowMs - (t - this.times[0]) + 50);
      }
    });
    this.chain = mine.catch(() => undefined);
    return mine;
  }
}
