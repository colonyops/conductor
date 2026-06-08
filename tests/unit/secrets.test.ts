import { createSecretsClient } from "../../src/sdk/secrets.js";

describe("createSecretsClient", () => {
  describe("env var resolution", () => {
    afterEach(() => {
      process.env.MY_SECRET = undefined;
    });

    it("returns env var value when opts.env matches", async () => {
      process.env.MY_SECRET = "env-value";
      const client = createSecretsClient();
      const val = await client.get("test.key", { env: "MY_SECRET" });
      expect(val).toBe("env-value");
    });

    it("falls through to keychain when env var is unset", async () => {
      // MY_SECRET is not set; keychain will also fail; should throw
      const client = createSecretsClient();
      await expect(client.get("test.key", { env: "MY_SECRET" })).rejects.toThrow('Secret "test.key" not found');
    });
  });

  describe("error when secret is unresolvable", () => {
    it("throws without promptIfMissing when not in env or keychain", async () => {
      const client = createSecretsClient();
      await expect(client.get("definitely-not-set")).rejects.toThrow('Secret "definitely-not-set" not found');
    });

    it("throws for env resolution with no fallback", async () => {
      const client = createSecretsClient();
      await expect(client.get("missing", { env: "CONDUCTOR_TEST_MISSING_12345" })).rejects.toThrow();
    });
  });

  describe("concurrent interactive prompts", () => {
    it("serializes stdin so concurrent prompts do not cross-talk", async () => {
      // keychainGet / keychainSet both go through Bun.spawn; make every spawn
      // report failure so get() falls through to the interactive prompt.
      const failingProc = () =>
        ({
          exited: Promise.resolve(1),
          stdout: new Response("").body,
          stderr: new Response("").body,
        }) as ReturnType<typeof Bun.spawn>;
      jest.spyOn(Bun, "spawn").mockImplementation(failingProc);

      const savedPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

      // Capture each registered once("data") handler instead of touching real stdin.
      const handlers: Array<(chunk: string) => void> = [];
      const onceSpy = jest
        .spyOn(process.stdin, "once")
        .mockImplementation((event: string | symbol, handler: (...args: unknown[]) => void) => {
          if (event === "data") handlers.push(handler as (chunk: string) => void);
          return process.stdin;
        });
      const resumeSpy = jest.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
      const pauseSpy = jest.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
      const encodingSpy = jest.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
      const stdoutSpy = jest.spyOn(process.stdout, "write").mockReturnValue(true);

      const tick = () => new Promise((r) => setTimeout(r, 0));

      try {
        const client = createSecretsClient();
        const a = client.get("key.a", { promptIfMissing: true });
        const b = client.get("key.b", { promptIfMissing: true });

        // Both started, but serialization means only one listener is live.
        await tick();
        expect(handlers.length).toBe(1);

        handlers[0]?.("secret-a");

        // After the first settles, the second prompt registers its listener.
        await tick();
        await tick();
        expect(handlers.length).toBe(2);

        handlers[1]?.("secret-b");

        expect(await a).toBe("secret-a");
        expect(await b).toBe("secret-b");
      } finally {
        onceSpy.mockRestore();
        resumeSpy.mockRestore();
        pauseSpy.mockRestore();
        encodingSpy.mockRestore();
        stdoutSpy.mockRestore();
        Object.defineProperty(process, "platform", { value: savedPlatform, configurable: true });
        jest.restoreAllMocks();
      }
    });
  });

  describe("keychain mock", () => {
    it("resolves from macOS keychain when security command succeeds", async () => {
      // Spy on Bun.spawn to simulate a successful keychain lookup
      const original = Bun.spawn;
      const mockProc = {
        exited: Promise.resolve(0),
        stdout: new Response("keychain-secret\n").body,
        stderr: new Response("").body,
      };
      jest.spyOn(Bun, "spawn").mockReturnValueOnce(mockProc as ReturnType<typeof Bun.spawn>);

      const savedPlatform = process.platform;
      // Temporarily override platform
      Object.defineProperty(process, "platform", {
        value: "darwin",
        configurable: true,
      });

      try {
        const client = createSecretsClient();
        const val = await client.get("test.key");
        expect(val).toBe("keychain-secret");
      } finally {
        Object.defineProperty(process, "platform", {
          value: savedPlatform,
          configurable: true,
        });
        jest.restoreAllMocks();
      }
    });

    it("set() passes the secret via stdin, not as a CLI arg, on macOS", async () => {
      const writes: string[] = [];
      const mockProc = {
        exited: Promise.resolve(0),
        stdin: { write: (chunk: string) => writes.push(chunk), end: () => {} },
        stdout: new Response("").body,
        stderr: new Response("").body,
      };
      let capturedArgs: string[] = [];
      jest.spyOn(Bun, "spawn").mockImplementation(((args: string[]) => {
        capturedArgs = args;
        return mockProc as ReturnType<typeof Bun.spawn>;
      }) as typeof Bun.spawn);

      const savedPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

      try {
        const client = createSecretsClient();
        await client.set("test.key", "super-secret");

        // The secret must not appear anywhere in the process argument list.
        expect(capturedArgs).not.toContain("super-secret");
        expect(capturedArgs.join(" ")).not.toContain("super-secret");
        // `-w` must be the final arg (no inline value following it).
        expect(capturedArgs[capturedArgs.length - 1]).toBe("-w");
        // The secret is delivered via stdin, written twice for confirmation.
        expect(writes.join("")).toBe("super-secret\nsuper-secret\n");
      } finally {
        Object.defineProperty(process, "platform", { value: savedPlatform, configurable: true });
        jest.restoreAllMocks();
      }
    });

    it("falls through when keychain returns non-zero exit code", async () => {
      const mockProc = {
        exited: Promise.resolve(1),
        stdout: new Response("").body,
        stderr: new Response("not found").body,
      };
      jest.spyOn(Bun, "spawn").mockReturnValueOnce(mockProc as ReturnType<typeof Bun.spawn>);

      const savedPlatform = process.platform;
      Object.defineProperty(process, "platform", {
        value: "darwin",
        configurable: true,
      });

      try {
        const client = createSecretsClient();
        await expect(client.get("missing-in-keychain")).rejects.toThrow("not found");
      } finally {
        Object.defineProperty(process, "platform", {
          value: savedPlatform,
          configurable: true,
        });
        jest.restoreAllMocks();
      }
    });
  });
});
