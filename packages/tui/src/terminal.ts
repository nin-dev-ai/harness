/** Keep Ink's final frame off the shell's scrollback. */
export async function withAlternateScreen<T>(
  stdout: { isTTY?: boolean; write(chunk: string): unknown },
  run: () => Promise<T>,
): Promise<T> {
  if (!stdout.isTTY) return run();
  stdout.write("\u001b[?1049h");
  try {
    return await run();
  } finally {
    stdout.write("\u001b[?1049l");
  }
}
