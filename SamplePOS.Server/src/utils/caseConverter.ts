// Case Converter Utility
// Converts database snake_case to frontend camelCase
// Handles nested objects, arrays, and numeric string parsing

/**
 * Convert snake_case string to camelCase
 */
export function snakeToCamel(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

/**
 * Convert camelCase string to snake_case
 */
export function camelToSnake(str: string): string {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * Check if value is a decimal numeric string (PostgreSQL NUMERIC/DECIMAL money).
 * Integer-looking strings (station codes "1000", "002", kitchen_station "2")
 * must stay strings — coercing them to numbers breaks .trim() / code lookups.
 */
function isNumericString(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  // Match patterns like "1000.00", "0.50", "-123.45" — require a decimal point.
  return /^-?\d+\.\d+$/.test(value);
}

/**
 * Parse numeric strings to numbers, leave other values unchanged
 */
function parseNumericValue(value: unknown): unknown {
  if (isNumericString(value)) {
    return parseFloat(value);
  }
  return value;
}

/**
 * Convert object keys from snake_case to camelCase
 * Recursively handles nested objects and arrays
 * Parses numeric strings to numbers
 */
export function convertKeysToCamelCase(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map((item) => convertKeysToCamelCase(item));
  }

  // Handle objects
  if (typeof obj === 'object' && (obj as object).constructor === Object) {
    const converted: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(obj)) {
      const camelKey = snakeToCamel(key);

      // Recursively convert nested objects/arrays
      if (value !== null && typeof value === 'object') {
        converted[camelKey] = convertKeysToCamelCase(value);
      } else {
        // Parse numeric strings to numbers
        converted[camelKey] = parseNumericValue(value);
      }
    }

    return converted;
  }

  // Return primitives as-is (with numeric parsing)
  return parseNumericValue(obj);
}

/**
 * Convert object keys from camelCase to snake_case
 * Used for incoming request data that needs to match database schema
 */
export function convertKeysToSnakeCase(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map((item) => convertKeysToSnakeCase(item));
  }

  // Handle objects
  if (typeof obj === 'object' && (obj as object).constructor === Object) {
    const converted: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(obj)) {
      const snakeKey = camelToSnake(key);

      // Recursively convert nested objects/arrays
      if (value !== null && typeof value === 'object') {
        converted[snakeKey] = convertKeysToSnakeCase(value);
      } else {
        converted[snakeKey] = value;
      }
    }

    return converted;
  }

  // Return primitives as-is
  return obj;
}

/**
 * Normalize API response data
 * Converts snake_case to camelCase and parses numeric strings
 * Use this before sending responses to frontend
 */
export function normalizeResponse<T = unknown>(data: unknown): T {
  return convertKeysToCamelCase(data) as T;
}

/**
 * Normalize paginated response
 * Handles common pagination structure with data array
 */
export function normalizePaginatedResponse<T = unknown>(response: {
  data: unknown[];
  pagination: Record<string, unknown>;
}): {
  data: T[];
  pagination: Record<string, unknown>;
} {
  return {
    data: response.data.map((item) => normalizeResponse<T>(item)),
    pagination: response.pagination,
  };
}
