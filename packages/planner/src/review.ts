import { z } from "zod";
import { extractJson } from "./validate.js";

export const FindingSchema = z.object({
  severity: z.enum(["blocker", "major", "nit"]),
  file: z.string().nullable().optional().transform((v) => v ?? null),
  line: z.number().int().nullable().optional().transform((v) => v ?? null),
  message: z.string().min(1),
});
export type Finding = z.infer<typeof FindingSchema>;

export const ReviewOutputSchema = z.object({
  summary: z.string().default(""),
  findings: z.array(FindingSchema),
});
export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;

/** JSON Schema handed to vendors that support structured output. */
export const REVIEW_JSON_SCHEMA = {
  type: "object",
  required: ["summary", "findings"],
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["severity", "file", "line", "message"],
        additionalProperties: false,
        properties: {
          severity: { type: "string", enum: ["blocker", "major", "nit"] },
          file: { type: ["string", "null"] },
          line: { type: ["integer", "null"] },
          message: { type: "string" },
        },
      },
    },
  },
} as const;

export type ParsedReview = { ok: true; review: ReviewOutput } | { ok: false; errors: string[] };

/** Validate reviewer output from the structured field, or JSON found in its text. */
export function parseReview(structured: unknown, text: string): ParsedReview {
  const candidate = structured ?? extractJson(text);
  if (candidate === undefined) return { ok: false, errors: ["no JSON object in reviewer output"] };
  const r = ReviewOutputSchema.safeParse(candidate);
  return r.success ? { ok: true, review: r.data } : { ok: false, errors: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
}
