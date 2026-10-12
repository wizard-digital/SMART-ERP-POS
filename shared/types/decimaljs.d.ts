// Ambient declaration so TypeScript can use Decimal as both a value and a type across projects.
// Runtime dependency is provided by each app (client/server) where decimal.js is installed.
declare module 'decimal.js' {
  export type Rounding = number;

  export default class Decimal {
    constructor(value?: any);

    // Static config
  static set(config: { precision?: number; rounding?: number; toExpNeg?: number; toExpPos?: number; [k: string]: any }): void;

    // Common rounding constants (values don't matter for typing)
    static ROUND_HALF_UP: number;
    static ROUND_HALF_DOWN: number;
    static ROUND_HALF_EVEN: number;
    static ROUND_UP: number;
    static ROUND_DOWN: number;

    // Arithmetic
    plus(n: any): Decimal;
    minus(n: any): Decimal;
  times(n: any): Decimal;
  mul(n: any): Decimal;
    div(n: any): Decimal;
  dividedBy(n: any): Decimal;

    // Comparison helpers
  gt(n: any): boolean;
  gte(n: any): boolean;
  greaterThan(n: any): boolean;
  greaterThanOrEqualTo(n: any): boolean;
  lt(n: any): boolean;
  lte(n: any): boolean;
  lessThan(n: any): boolean;
  lessThanOrEqualTo(n: any): boolean;
  equals(n: any): boolean;
    eq(n: any): boolean;
    comparedTo(n: any): number;

    // Checks
  isFinite(): boolean;
  isZero(): boolean;
  isInteger(): boolean;
    abs(): Decimal;
    negated(): Decimal;

    // Formatting / conversion
    toDecimalPlaces(dp?: number, rm?: number): Decimal;
    toFixed(dp?: number): string;
    toNumber(): number;
    toString(): string;
    valueOf(): string;

    // Static helpers used in codebase
    static min(a: any, b: any): Decimal;
  }
}
