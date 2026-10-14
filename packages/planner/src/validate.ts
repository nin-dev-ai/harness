/**
 * Find the JSON object in model output: the whole text, a fenced ```json block,
 * or the outermost {...} span. Returns undefined if none parses.
 */
export function extractJson(text: string): unknown {
  const tries: string[] = [text.trim()];
  const fence = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(text);
  if (fence?.[1]) tries.push(fence[1].trim());
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) tries.push(text.slice(start, end + 1));
  for (const t of tries) {
    try {
      const v = JSON.parse(t);
      if (v && typeof v === "object") return v;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}
