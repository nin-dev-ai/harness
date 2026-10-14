const HOUR = 3_600_000;

export interface QuietHours {
  startMin: number;
  endMin: number;
}

/** Parse "HH:MM-HH:MM" (local time). The range may wrap midnight. */
export function parseQuietHours(s: string | undefined): QuietHours | undefined {
  if (!s) return undefined;
  const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(s);
  if (!m) return undefined;
  return { startMin: Number(m[1]) * 60 + Number(m[2]), endMin: Number(m[3]) * 60 + Number(m[4]) };
}

/** Is `t` inside the quiet range (local time)? */
export function inQuietHours(t: Date, q: QuietHours | undefined): boolean {
  if (!q || q.startMin === q.endMin) return false;
  const m = t.getHours() * 60 + t.getMinutes();
  return q.startMin < q.endMin ? m >= q.startMin && m < q.endMin : m >= q.startMin || m < q.endMin;
}

/** Hours between now and `until` that fall outside quiet hours (15-minute resolution). */
export function activeHoursUntil(now: Date, until: Date, q: QuietHours | undefined): number {
  const step = 15 * 60_000;
  let active = 0;
  for (let t = now.getTime(); t < until.getTime(); t += step) if (!inQuietHours(new Date(t), q)) active += Math.min(step, until.getTime() - t);
  return active / HOUR;
}

/** 5-hour windows left before the 7-day reset, counting only active (non-quiet) hours. At least 1. */
export function remaining5hWindows(now: Date, weeklyResetsAt: Date, q: QuietHours | undefined): number {
  return Math.max(1, Math.ceil(activeHoursUntil(now, weeklyResetsAt, q) / 5));
}

/** Share of the weekly allowance one 5h window may spend, after the weekly reserve. */
export function weeklyPerWindow(used7d: number, cap7d: number, weeklyReservePct: number, windowsLeft: number): number {
  return (Math.min(cap7d, 100 - weeklyReservePct) - used7d) / windowsLeft;
}
