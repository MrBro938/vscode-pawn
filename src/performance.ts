import { performance } from "perf_hooks";

export interface PerformanceTiming {
  count: number;
  totalMs: number;
  averageMs: number;
  maxMs: number;
  p95Ms: number;
}

export interface PerformanceSnapshot {
  enabled: boolean;
  collectedSince?: number;
  elapsedMs: number;
  counters: Record<string, number>;
  timings: Record<string, PerformanceTiming>;
}

interface MutableTiming {
  count: number;
  totalMs: number;
  maxMs: number;
  samples: number[];
}

export class PerformanceMonitor {
  private enabled = false;
  private collectedSince: number | undefined;
  private readonly counters = new Map<string, number>();
  private readonly timings = new Map<string, MutableTiming>();
  private static readonly MAX_SAMPLES = 256;

  get isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    if (enabled && !this.enabled && this.collectedSince === undefined) {
      this.collectedSince = Date.now();
    }
    this.enabled = enabled;
  }

  count(name: string, amount = 1): void {
    if (!this.enabled || !amount) return;
    this.counters.set(name, (this.counters.get(name) || 0) + amount);
  }

  record(name: string, durationMs: number): void {
    if (!this.enabled || !Number.isFinite(durationMs) || durationMs < 0) return;

    let timing = this.timings.get(name);
    if (!timing) {
      timing = { count: 0, totalMs: 0, maxMs: 0, samples: [] };
      this.timings.set(name, timing);
    }

    timing.count++;
    timing.totalMs += durationMs;
    timing.maxMs = Math.max(timing.maxMs, durationMs);
    timing.samples.push(durationMs);
    if (timing.samples.length > PerformanceMonitor.MAX_SAMPLES) {
      timing.samples.shift();
    }
  }

  measure<T>(name: string, operation: () => T): T {
    if (!this.enabled) return operation();
    const startedAt = performance.now();
    try {
      return operation();
    } finally {
      this.record(name, performance.now() - startedAt);
    }
  }

  async measureAsync<T>(name: string, operation: () => PromiseLike<T>): Promise<T> {
    if (!this.enabled) return await operation();
    const startedAt = performance.now();
    try {
      return await operation();
    } finally {
      this.record(name, performance.now() - startedAt);
    }
  }

  reset(): void {
    this.counters.clear();
    this.timings.clear();
    this.collectedSince = this.enabled ? Date.now() : undefined;
  }

  snapshot(): PerformanceSnapshot {
    const timings: Record<string, PerformanceTiming> = {};
    this.timings.forEach((timing, name) => {
      const sorted = [...timing.samples].sort((left, right) => left - right);
      const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
      timings[name] = {
        count: timing.count,
        totalMs: timing.totalMs,
        averageMs: timing.count > 0 ? timing.totalMs / timing.count : 0,
        maxMs: timing.maxMs,
        p95Ms: sorted.length > 0 ? sorted[p95Index] : 0,
      };
    });

    return {
      enabled: this.enabled,
      collectedSince: this.collectedSince,
      elapsedMs: this.collectedSince === undefined
        ? 0
        : Math.max(0, Date.now() - this.collectedSince),
      counters: Object.fromEntries(this.counters),
      timings,
    };
  }
}

export const formatPerformanceSnapshot = (
  title: string,
  snapshot: PerformanceSnapshot
): string => {
  const lines = [
    `========== ${title.toUpperCase()} ==========`,
    `Status: ${snapshot.enabled ? "ON" : "OFF"}`,
    snapshot.collectedSince
      ? `Collected since: ${new Date(snapshot.collectedSince).toLocaleString()}`
      : "Collected since: —",
    `Elapsed: ${(snapshot.elapsedMs / 1000).toFixed(1)} s`,
    "",
    "Counters:",
  ];

  const counterEntries = Object.entries(snapshot.counters).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  if (counterEntries.length === 0) lines.push("  No counters collected.");
  counterEntries.forEach(([name, value]) => {
    lines.push(`  ${name.padEnd(36)} ${value.toLocaleString()}`);
  });

  lines.push("", "Timings (average / P95 / max):");
  const timingEntries = Object.entries(snapshot.timings).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  if (timingEntries.length === 0) lines.push("  No timings collected.");
  timingEntries.forEach(([name, timing]) => {
    lines.push(
      `  ${name.padEnd(36)} ${timing.averageMs.toFixed(2)} / ${timing.p95Ms.toFixed(2)} / ${timing.maxMs.toFixed(2)} ms  (n=${timing.count})`
    );
  });

  lines.push("========================================");
  return lines.join("\n");
};
