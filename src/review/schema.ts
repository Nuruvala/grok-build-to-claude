/**
 * Review findings schema. Zod is the single definition; the JSON Schema
 * string passed to `--json-schema` is derived from it.
 */

import { z } from 'zod';

const SeveritySchema = z.enum(['critical', 'high', 'medium', 'low', 'info']);

const FindingSchema = z.object({
  severity: SeveritySchema,
  file: z.string(),
  summary: z.string(),
  rationale: z.string(),
  line: z.number().int().optional(),
});

/**
 * `status` is required so a multi-turn run can emit a working placeholder
 * instead of inventing findings to fill the schema. Verified against grok 1.0.4
 * on 2026-08-16: without the discriminator, a `--max-turns 4` review fabricated
 * findings-shaped progress notes.
 */
export const ReviewFindingsSchema = z.object({
  status: z.enum(['working', 'final']),
  findings: z.array(FindingSchema),
  verdict: z.string().optional(),
});

export type ReviewFindings = z.output<typeof ReviewFindingsSchema>;

/**
 * Serialized JSON Schema for `--json-schema`. This string is both the CLI flag
 * value and the copy embedded in a structured prompt.
 *
 * Derived from {@link ReviewFindingsSchema}. `$schema` is stripped because it
 * is noise on an embedded subschema — the same reason as definitions.ts.
 */
export const REVIEW_FINDINGS_SCHEMA: string = derivedFindingsSchema();

function derivedFindingsSchema(): string {
  const generated: unknown = z.toJSONSchema(ReviewFindingsSchema, {
    target: 'draft-2020-12',
    io: 'input',
    unrepresentable: 'any',
  });
  if (!isJsonObject(generated)) {
    throw new Error('zod produced a non-object JSON Schema for review findings');
  }
  const { $schema: _discarded, ...schema } = generated;
  return JSON.stringify(schema);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
