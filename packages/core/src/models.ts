/** Model per task size, e.g. { S: "haiku", L: "opus" }. */
export type ModelTiers = Partial<Record<"S" | "M" | "L", string>>;

/** A model field as typed in setup: one id, or "S=…, M=…, L=…" tiers by task size. */
export function parseModelField(text: string): { model?: string; models?: ModelTiers } {
  const t = text.trim();
  if (!t) return {};
  if (!t.includes("=")) return { model: t };
  const models: ModelTiers = {};
  for (const part of t.split(",")) {
    const m = /^\s*([SML])\s*=\s*(\S+)\s*$/i.exec(part);
    if (m) models[m[1]!.toUpperCase() as "S" | "M" | "L"] = m[2]!;
  }
  return Object.keys(models).length ? { models } : {};
}
