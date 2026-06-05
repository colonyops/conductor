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
      await expect(
        client.get("test.key", { env: "MY_SECRET" }),
      ).rejects.toThrow('Secret "test.key" not found');
    });
  });

  describe("error when secret is unresolvable", () => {
    it("throws without promptIfMissing when not in env or keychain", async () => {
      const client = createSecretsClient();
      await expect(client.get("definitely-not-set")).rejects.toThrow(
        'Secret "definitely-not-set" not found',
      );
    });

    it("throws for env resolution with no fallback", async () => {
      const client = createSecretsClient();
      await expect(
        client.get("missing", { env: "CONDUCTOR_TEST_MISSING_12345" }),
      ).rejects.toThrow();
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
      jest
        .spyOn(Bun, "spawn")
        .mockReturnValueOnce(mockProc as ReturnType<typeof Bun.spawn>);

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

    it("falls through when keychain returns non-zero exit code", async () => {
      const mockProc = {
        exited: Promise.resolve(1),
        stdout: new Response("").body,
        stderr: new Response("not found").body,
      };
      jest
        .spyOn(Bun, "spawn")
        .mockReturnValueOnce(mockProc as ReturnType<typeof Bun.spawn>);

      const savedPlatform = process.platform;
      Object.defineProperty(process, "platform", {
        value: "darwin",
        configurable: true,
      });

      try {
        const client = createSecretsClient();
        await expect(client.get("missing-in-keychain")).rejects.toThrow(
          "not found",
        );
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
