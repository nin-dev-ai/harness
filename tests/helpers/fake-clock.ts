export { FakeClock } from "@harness/core";

/** Let pending promise callbacks and I/O run (no timers advanced). */
export async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
}

/** Poll until `cond` is true, in real time (for real child processes). */
export async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 10_000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}
