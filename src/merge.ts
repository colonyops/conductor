// mergeWithDefaults returns a new object with all keys from `defaults`, overridden by any
// defined (non-undefined) keys from `overrides`. Array values are replaced wholesale, not merged.
export function mergeWithDefaults<T extends object>(defaults: T, overrides: Partial<T> | undefined): T {
  if (!overrides) return { ...defaults };
  const result = { ...defaults } as Record<string, unknown>;
  for (const [key, val] of Object.entries(overrides)) {
    if (val !== undefined) {
      result[key] = val;
    }
  }
  return result as T;
}
