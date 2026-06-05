import { createInterface } from "node:readline";
import type { ConductorConfig } from "../config.js";
import { resolvePath, writeConfig } from "../config.js";

export async function hashPlugin(filePath: string): Promise<string> {
  const content = await Bun.file(resolvePath(filePath)).arrayBuffer();
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(new Uint8Array(content));
  return `sha256:${hasher.digest("hex")}`;
}

export function getStoredHash(config: ConductorConfig, pluginId: string): string | undefined {
  return config.trustedPlugins[pluginId];
}

export type TrustStatus = "trusted" | "changed" | "unknown";

export function checkTrust(pluginId: string, currentHash: string, config: ConductorConfig): TrustStatus {
  const stored = config.trustedPlugins[pluginId];
  if (!stored) return "unknown";
  return stored === currentHash ? "trusted" : "changed";
}

export async function promptTrustApproval(
  pluginMeta: { name: string; id: string; path: string; hash: string },
  reason: "new" | "changed",
  readLineFn?: (question: string) => Promise<string>,
): Promise<boolean> {
  const reasonText = reason === "new" ? "New plugin" : "Plugin file changed";
  const msg = `\n${reasonText}: ${pluginMeta.name}\n  ID:   ${pluginMeta.id}\n  Path: ${pluginMeta.path}\n  Hash: ${pluginMeta.hash}\n\nAllow this plugin? [y/N]: `;

  let answer: string;
  if (readLineFn) {
    answer = await readLineFn(msg);
  } else {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    answer = await new Promise<string>((resolve) => {
      rl.question(msg, (ans) => {
        rl.close();
        resolve(ans.trim().toLowerCase());
      });
    });
  }
  return answer === "y" || answer === "yes";
}

export async function persistTrustedPlugins(
  approvals: Array<{ pluginId: string; hash: string }>,
  config: ConductorConfig,
  configPath: string,
): Promise<void> {
  const updated: ConductorConfig = {
    ...config,
    trustedPlugins: { ...config.trustedPlugins },
  };
  for (const { pluginId, hash } of approvals) {
    updated.trustedPlugins[pluginId] = hash;
  }
  await writeConfig(updated, configPath);
}
