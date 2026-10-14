/**
 * Injectable clock. Everything time-dependent (scheduler, quota, backoff,
 * staleness) takes a Clock so tests run with FakeClock and never sleep.
 */
export interface Clock {
  now(): Date;
  /** Run `fn` once after `ms`. Returns a cancel function. */
  setTimeout(fn: () => void, ms: number): () => void;
}

export const systemClock: Clock = {
  now: () => new Date(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
};

export function iso(clock: Clock): string {
  return clock.now().toISOString();
}

interface PendingTimer {
  id: number;
  at: number;
  fn: () => void;
}

/** Deterministic clock for tests. Time only moves when `advance` or `set` is called. */
export class FakeClock implements Clock {
  private t: number;
  private timers: PendingTimer[] = [];
  private nextId = 1;

  constructor(start: Date | string = "2026-01-05T09:00:00.000Z") {
    this.t = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.t);
  }

  setTimeout(fn: () => void, ms: number): () => void {
    const timer = { id: this.nextId++, at: this.t + Math.max(0, ms), fn };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((x) => x.id !== timer.id);
    };
  }

  /** Move time forward, firing due timers in order. */
  advance(ms: number): void {
    this.set(new Date(this.t + ms));
  }

  /** Jump to an absolute time, firing every timer due on the way. */
  set(to: Date | string): void {
    const target = new Date(to).getTime();
    for (;;) {
      const due = this.timers.filter((x) => x.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((x) => x.id !== due.id);
      this.t = Math.max(this.t, due.at);
      due.fn();
    }
    this.t = Math.max(this.t, target);
  }

  pendingTimers(): number {
    return this.timers.length;
  }
}

/** Milliseconds between two ISO times (b - a). */
export function msBetween(a: string | Date, b: string | Date): number {
  return new Date(b).getTime() - new Date(a).getTime();
}

export function addMs(t: string | Date, ms: number): string {
  return new Date(new Date(t).getTime() + ms).toISOString();
}
