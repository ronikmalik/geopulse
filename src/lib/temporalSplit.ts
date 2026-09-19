export interface TimedExample {
  snapshotAt: Date;
  targetAt: Date;
}

// Hold out whole timestamps, and purge labels unavailable at the first
// held-out prediction time. Sorting inputs alone does not prevent leakage
// when a training example's forecast horizon extends into the test period.
export function splitByAvailableOutcome<T extends TimedExample>(
  examples: T[],
  testFraction: number,
): { train: T[]; test: T[] } {
  if (!(testFraction > 0 && testFraction < 1)) {
    throw new Error("testFraction must be between 0 and 1");
  }
  const sorted = [...examples].sort((a, b) => a.snapshotAt.getTime() - b.snapshotAt.getTime());
  if (sorted.length === 0) return { train: [], test: [] };
  const boundary = sorted[Math.floor(sorted.length * (1 - testFraction))].snapshotAt.getTime();
  return {
    train: sorted.filter((e) => e.snapshotAt.getTime() < boundary && e.targetAt.getTime() < boundary),
    test: sorted.filter((e) => e.snapshotAt.getTime() >= boundary),
  };
}

export function predictionTargetAt(snapshotAt: Date, horizonDays: number): Date {
  return new Date(snapshotAt.getTime() + horizonDays * 86_400_000);
}
