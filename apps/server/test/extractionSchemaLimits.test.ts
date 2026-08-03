import { describe, expect, it } from 'vitest';
import { EXTRACTION_TOOL, UNION_PARAM_LIMIT } from '../src/services/extraction/anthropicExtractor.js';

/**
 * The API caps a tool schema at UNION_PARAM_LIMIT union-typed parameters
 * ("type arrays or anyOf") and rejects the whole request with a 400 beyond it.
 * In July 2026 the schema silently reached 17 — three fields added on the same
 * day — and every extraction failed. Ingestion was independently broken at the
 * time, so nothing reached the extractor and nobody found out for three weeks.
 * This counts the same thing the API counts, so the build fails first.
 */
function countUnionParams(node: unknown): number {
  if (node === null || typeof node !== 'object') return 0;
  if (Array.isArray(node)) return node.reduce<number>((n, child) => n + countUnionParams(child), 0);

  const obj = node as Record<string, unknown>;
  let count = 0;
  // A parameter is union-typed when its `type` is an array of types, or when
  // it uses anyOf. Both carry the exponential compilation cost the cap exists
  // to bound.
  if (Array.isArray(obj.type) || Array.isArray(obj.anyOf)) count += 1;
  for (const [key, value] of Object.entries(obj)) {
    // `required` is a list of names, `enum` a list of values — neither nests
    // schemas, and walking them would double-count nothing but cost clarity.
    if (key === 'required' || key === 'enum') continue;
    count += countUnionParams(value);
  }
  return count;
}

describe('extraction tool schema stays within the API union-parameter cap', () => {
  const schema = (EXTRACTION_TOOL as unknown as { input_schema: unknown }).input_schema;

  it('counts union-typed parameters the way the API does', () => {
    // Sanity-check the counter itself against a schema with a known shape.
    expect(
      countUnionParams({
        type: 'object',
        properties: {
          a: { type: ['string', 'null'] },
          b: { type: 'string' },
          c: { anyOf: [{ type: 'string' }, { type: 'number' }] },
          d: { type: 'object', properties: { e: { type: ['number', 'null'] } } },
        },
        required: ['a', 'b', 'c', 'd'],
      }),
    ).toBe(3);
  });

  it('stays at or under the cap', () => {
    const used = countUnionParams(schema);
    expect(used).toBeLessThanOrEqual(UNION_PARAM_LIMIT);
  });

  it('keeps real headroom, so one new field cannot break extraction', () => {
    // The per-field wrapper is deliberately non-nullable: if this creeps back
    // up toward the cap, the fix is to stop making per-field values nullable,
    // not to raise this number.
    const used = countUnionParams(schema);
    expect(used).toBeLessThanOrEqual(UNION_PARAM_LIMIT - 5);
  });

  it('still models a declined category or approver as genuinely null', () => {
    const props = (schema as { properties: Record<string, { properties: Record<string, { type: unknown }> }> })
      .properties;
    expect(props.proposed_category.properties.name.type).toEqual(['string', 'null']);
    expect(props.proposed_approver.properties.email.type).toEqual(['string', 'null']);
  });

  it('reports an absent header field as an empty string, not null', () => {
    const props = (schema as { properties: Record<string, { properties?: Record<string, { type: unknown }> }> })
      .properties;
    for (const field of ['vendor_name', 'invoice_ref', 'invoice_date', 'due_date', 'net', 'vat', 'gross',
      'vat_rate', 'vat_number', 'po_number', 'billed_to_entity', 'project']) {
      expect(props[field].properties!.value.type, `${field}.value`).toBe('string');
    }
  });
});
