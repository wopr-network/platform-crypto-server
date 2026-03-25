import type { IChainPlugin } from "./interfaces.js";

export class PluginRegistry {
	private plugins = new Map<string, IChainPlugin>();

	register(plugin: IChainPlugin): void {
		if (this.plugins.has(plugin.pluginId)) {
			throw new Error(`Plugin "${plugin.pluginId}" is already registered`);
		}
		this.plugins.set(plugin.pluginId, plugin);
	}

	get(pluginId: string): IChainPlugin | undefined {
		return this.plugins.get(pluginId);
	}

	getOrThrow(pluginId: string): IChainPlugin {
		const plugin = this.plugins.get(pluginId);
		if (!plugin) throw new Error(`Plugin "${pluginId}" is not registered`);
		return plugin;
	}

	list(): IChainPlugin[] {
		return [...this.plugins.values()];
	}
}
