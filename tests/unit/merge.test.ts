import { mergeWithDefaults } from "../../src/merge.js";

describe("mergeWithDefaults", () => {
  it("returns a copy of defaults when overrides is undefined", () => {
    const defaults = { a: 1, b: "hello" };
    const result = mergeWithDefaults(defaults, undefined);
    expect(result).toEqual({ a: 1, b: "hello" });
    expect(result).not.toBe(defaults);
  });

  it("applies defined override values over defaults", () => {
    const defaults = { a: 1, b: 2, c: 3 };
    const result = mergeWithDefaults(defaults, { b: 99 });
    expect(result).toEqual({ a: 1, b: 99, c: 3 });
  });

  it("ignores runtime-undefined override values, preserving defaults", () => {
    const defaults = { a: 1, b: 2 };
    // Cast to simulate a JSON-parsed object where some fields are absent at runtime.
    const overrides = { b: undefined } as unknown as Partial<typeof defaults>;
    const result = mergeWithDefaults(defaults, overrides);
    expect(result.b).toBe(2);
  });

  it("adds keys present in overrides but absent from defaults", () => {
    const defaults = { a: 1 } as Record<string, unknown>;
    const result = mergeWithDefaults(defaults, { b: "extra" } as Partial<typeof defaults>);
    expect(result).toEqual({ a: 1, b: "extra" });
  });

  it("replaces array values wholesale", () => {
    const defaults = { tags: ["x", "y"] } as Record<string, unknown>;
    const result = mergeWithDefaults(defaults, { tags: ["z"] } as Partial<typeof defaults>);
    expect(result).toEqual({ tags: ["z"] });
  });

  it("does not mutate the defaults object", () => {
    const defaults = { a: 1, b: 2 };
    mergeWithDefaults(defaults, { a: 99 });
    expect(defaults.a).toBe(1);
  });

  it("returns all default keys when overrides is empty", () => {
    const defaults = { x: 10, y: 20, z: 30 };
    const result = mergeWithDefaults(defaults, {});
    expect(result).toEqual(defaults);
  });
});
