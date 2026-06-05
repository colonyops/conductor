import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openKVDatabase } from "../../src/sdk/kv.js";

const TEST_DIR = join(tmpdir(), `conductor-kv-test-${process.pid}`);
let db: ReturnType<typeof openKVDatabase>;

beforeAll(() => {
  db = openKVDatabase(TEST_DIR);
});

afterAll(() => {
  db.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("BunSqliteKVStore", () => {
  it("get returns undefined for missing key", async () => {
    const store = db.forPlugin("plugin-a");
    expect(await store.get("missing")).toBeUndefined();
  });

  it("set then get round-trips primitives", async () => {
    const store = db.forPlugin("plugin-a");
    await store.set("str", "hello");
    await store.set("num", 42);
    await store.set("bool", true);
    expect(await store.get<string>("str")).toBe("hello");
    expect(await store.get<number>("num")).toBe(42);
    expect(await store.get<boolean>("bool")).toBe(true);
  });

  it("set then get round-trips nested objects", async () => {
    const store = db.forPlugin("plugin-a");
    const obj = { foo: { bar: [1, 2, 3] } };
    await store.set("nested", obj);
    expect(await store.get<typeof obj>("nested")).toEqual(obj);
  });

  it("has returns true for existing key, false otherwise", async () => {
    const store = db.forPlugin("plugin-a");
    await store.set("exists", 1);
    expect(await store.has("exists")).toBe(true);
    expect(await store.has("does-not-exist")).toBe(false);
  });

  it("delete removes the key", async () => {
    const store = db.forPlugin("plugin-a");
    await store.set("temp", "value");
    expect(await store.has("temp")).toBe(true);
    await store.delete("temp");
    expect(await store.has("temp")).toBe(false);
  });

  it("delete is a no-op for missing keys", async () => {
    const store = db.forPlugin("plugin-a");
    await expect(store.delete("never-set")).resolves.toBeUndefined();
  });

  it("keys returns all keys in scope", async () => {
    const store = db.forPlugin("keys-test");
    await store.set("a", 1);
    await store.set("b", 2);
    await store.set("c", 3);
    const keys = await store.keys();
    expect(keys.sort()).toEqual(["a", "b", "c"]);
  });

  it("keys with prefix filters correctly", async () => {
    const store = db.forPlugin("prefix-test");
    await store.set("foo:1", 1);
    await store.set("foo:2", 2);
    await store.set("bar:1", 3);
    const fooKeys = await store.keys("foo:");
    expect(fooKeys.sort()).toEqual(["foo:1", "foo:2"]);
  });

  it("clear removes all keys in scope", async () => {
    const store = db.forPlugin("clear-test");
    await store.set("x", 1);
    await store.set("y", 2);
    await store.clear();
    expect(await store.keys()).toHaveLength(0);
  });

  describe("scope isolation", () => {
    it("two plugins with identical keys are isolated", async () => {
      const a = db.forPlugin("iso-a");
      const b = db.forPlugin("iso-b");
      await a.set("shared", "from-a");
      await b.set("shared", "from-b");
      expect(await a.get<string>("shared")).toBe("from-a");
      expect(await b.get<string>("shared")).toBe("from-b");
    });

    it("clear only deletes keys for that plugin", async () => {
      const a = db.forPlugin("clear-iso-a");
      const b = db.forPlugin("clear-iso-b");
      await a.set("key", "a-value");
      await b.set("key", "b-value");
      await a.clear();
      expect(await a.has("key")).toBe(false);
      expect(await b.get<string>("key")).toBe("b-value");
    });
  });

  describe("concurrent writes", () => {
    it("concurrent set/get do not corrupt data", async () => {
      const store = db.forPlugin("concurrent");
      const writes = Array.from({ length: 20 }, (_, i) => store.set(`key-${i}`, i));
      await Promise.all(writes);
      const reads = await Promise.all(Array.from({ length: 20 }, (_, i) => store.get<number>(`key-${i}`)));
      for (let i = 0; i < 20; i++) {
        expect(reads[i]).toBe(i);
      }
    });
  });
});
