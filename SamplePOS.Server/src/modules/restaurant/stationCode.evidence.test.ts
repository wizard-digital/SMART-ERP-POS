/**
 * Evidence: station code normalization + 2↔002 equivalence for KOT routing.
 */
import {
  normalizePrinterName,
  normalizeStationCode,
  stationCodesEquivalent,
} from './stationCode.js';

describe('stationCode integrity', () => {
  it('normalizes number and string codes without crashing', () => {
    expect(normalizeStationCode(2)).toBe('2');
    expect(normalizeStationCode('002')).toBe('002');
    expect(normalizeStationCode('  bar  ')).toBe('BAR');
    expect(normalizeStationCode(null)).toBe('');
  });

  it('treats digit-only codes as equivalent when numeric values match', () => {
    expect(stationCodesEquivalent('2', '002')).toBe(true);
    expect(stationCodesEquivalent(2, '002')).toBe(true);
    expect(stationCodesEquivalent('1000', 1000)).toBe(true);
    expect(stationCodesEquivalent('2', '3')).toBe(false);
    expect(stationCodesEquivalent('BAR', 'bar')).toBe(true);
    expect(stationCodesEquivalent('BAR', '2')).toBe(false);
  });

  it('normalizes printer names safely', () => {
    expect(normalizePrinterName(' POS-80 ')).toBe('POS-80');
    expect(normalizePrinterName(1000)).toBe('1000');
    expect(normalizePrinterName('')).toBeNull();
    expect(normalizePrinterName(null)).toBeNull();
  });
});
