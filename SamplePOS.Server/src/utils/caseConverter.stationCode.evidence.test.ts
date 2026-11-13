/**
 * Evidence: station / kitchen_station codes must stay strings through camelCase.
 * Regression: convertKeysToCamelCase coerced "2"/"1000" to numbers →
 * resolveStation `(code || "").trim is not a function` → KOT unsent.
 */
import { convertKeysToCamelCase } from './caseConverter.js';

describe('caseConverter station-code integrity', () => {
  it('keeps integer-looking station codes as strings', () => {
    const row = convertKeysToCamelCase({
      kitchen_station: '2',
      code: '1000',
      padded: '002',
      qty: '3.00',
    }) as Record<string, unknown>;

    expect(row.kitchenStation).toBe('2');
    expect(typeof row.kitchenStation).toBe('string');
    expect(row.code).toBe('1000');
    expect(typeof row.code).toBe('string');
    expect(row.padded).toBe('002');
    expect(typeof row.padded).toBe('string');
    // Decimal money strings still coerce to number (documented intent).
    expect(row.qty).toBe(3);
  });

  it('resolveStation-safe: String(code).trim works after camelCase', () => {
    const item = convertKeysToCamelCase({
      kitchen_station: '1000',
    }) as { kitchenStation: unknown };

    const normalized = String(item.kitchenStation ?? '')
      .trim()
      .toUpperCase();
    expect(normalized).toBe('1000');
  });
});
