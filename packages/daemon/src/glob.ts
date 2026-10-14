import picomatch from "picomatch";

const cache = new Map<string, (p: string) => boolean>();

/** Cached glob matcher (dotfiles included: `.env` must match `**\/.env*`). */
export default function matcher(glob: string): (p: string) => boolean {
  let m = cache.get(glob);
  if (!m) {
    m = picomatch(glob, { dot: true });
    cache.set(glob, m);
  }
  return m;
}
