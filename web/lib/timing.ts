/** Collects request phase durations for Server-Timing headers and structured logs. */
export class Timing {
  private readonly started = performance.now();
  readonly phases: Record<string, number> = {};
  readonly counts: Record<string, number> = {};
  async measure<T>(name: string, task: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await task();
    } finally {
      this.phases[name] = (this.phases[name] ?? 0) + performance.now() - start;
    }
  }
  count(name: string, value: number) {
    this.counts[name] = (this.counts[name] ?? 0) + value;
  }
  get total() {
    return performance.now() - this.started;
  }
  header() {
    return [
      ...Object.entries(this.phases).map(([name, ms]) => `${name};dur=${ms.toFixed(1)}`),
      `total;dur=${this.total.toFixed(1)}`,
    ].join(", ");
  }
  log(event: string) {
    const round = (values: Record<string, number>) =>
      Object.fromEntries(Object.entries(values).map(([k, v]) => [k, Math.round(v * 10) / 10]));
    console.log(
      JSON.stringify({
        event,
        region: process.env.VERCEL_REGION,
        ms: { ...round(this.phases), total: Math.round(this.total * 10) / 10 },
        ...this.counts,
      }),
    );
  }
}
