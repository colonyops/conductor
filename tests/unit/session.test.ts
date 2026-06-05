import { resolveSignalInvocation } from "../../src/core/session.js";

describe("resolveSignalInvocation", () => {
  const originalArgv1 = process.argv[1] ?? "";
  const originalExecPath = process.execPath;

  afterEach(() => {
    process.argv[1] = originalArgv1;
    // process.execPath is read-only; restore via Object.defineProperty
    Object.defineProperty(process, "execPath", { value: originalExecPath, writable: true });
  });

  it("returns bun + script path in dev mode (argv[1] ends with .ts)", () => {
    Object.defineProperty(process, "execPath", { value: "/usr/local/bin/bun", writable: true });
    process.argv[1] = "/home/user/conductor/src/index.ts";

    const result = resolveSignalInvocation();

    expect(result).toBe("/usr/local/bin/bun /home/user/conductor/src/index.ts");
  });

  it("returns execPath alone when running as a compiled binary (argv[1] is not .ts)", () => {
    Object.defineProperty(process, "execPath", { value: "/usr/local/bin/conductor", writable: true });
    process.argv[1] = "start";

    const result = resolveSignalInvocation();

    expect(result).toBe("/usr/local/bin/conductor");
  });

  it("returned invocation contains signal subcommand in a full hook command", () => {
    const invocation = resolveSignalInvocation();
    const cmd = `${invocation} signal stop --session abc123`;
    expect(cmd).toContain("signal stop");
    expect(cmd).toContain("--session abc123");
  });
});
