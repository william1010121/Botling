// Startup timing (botlingd.log): one line per phase of a long construction, and the slowest few of many repeated steps.
// Timing only: it changes nothing about what the phases do. Without an `out` it does nothing at all.

/** Laps a sequence of phases: `lap("name")` writes `timing: <label>: <name> N ms` (N since the previous lap) and returns N. */
export class PhaseMarks {
  private last: number;
  private readonly began: number;

  constructor(
    private readonly out: ((line: string) => void) | undefined,
    private readonly label: string,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.began = this.last = this.now();
  }

  lap(what: string): number {
    const t = this.now();
    const ms = Math.round(t - this.last);
    this.last = t;
    this.out?.(`timing: ${this.label}: ${what} ${ms} ms`);
    return ms;
  }

  /** The last lap's end, as a total since the marks were made. */
  total(what = "total"): number {
    const ms = Math.round(this.now() - this.began);
    this.out?.(`timing: ${this.label}: ${what} ${ms} ms`);
    return ms;
  }
}

/** Keeps the `limit` slowest of the items it is told about, for one summary line (not one line per item). */
export class Slowest {
  private items: Array<{ name: string; ms: number }> = [];

  constructor(private readonly limit = 5) {}

  add(name: string, ms: number): void {
    this.items.push({ name, ms });
    this.items.sort((a, b) => b.ms - a.ms);
    if (this.items.length > this.limit) this.items.length = this.limit;
  }

  /** `3 slowest of 68: "name" 120 ms, …`; names are quoted with JSON.stringify and cut, so a name is one clean line. */
  line(total: number): string {
    const shown = this.items.map((item) => `${JSON.stringify(item.name.slice(0, 40))} ${Math.round(item.ms)} ms`).join(", ");
    return `${this.items.length} slowest of ${total}: ${shown || "none"}`;
  }
}
