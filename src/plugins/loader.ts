import type { ConductorConfig } from "../config.js";
import type { Plugin, PluginModule } from "../types.js";

export interface LoadedPlugin {
  plugin: Plugin;
  hash: string;
}

export async function loadPlugins(
  _config: ConductorConfig,
): Promise<LoadedPlugin[]> {
  // Phase 4 implementation
  return [];
}
