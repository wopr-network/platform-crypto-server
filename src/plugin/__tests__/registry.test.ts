import { describe, expect, it } from "vitest";
import type { IChainPlugin } from "../interfaces.js";
import { PluginRegistry } from "../registry.js";

function mockPlugin(id: string, curve: "secp256k1" | "ed25519" = "secp256k1"): IChainPlugin {
	return {
		pluginId: id,
		supportedCurve: curve,
		encoders: {},
		createWatcher: () => ({
			init: async () => {},
			poll: async () => [],
			setWatchedAddresses: () => {},
			getCursor: () => 0,
			stop: () => {},
		}),
		createSweeper: () => ({ scan: async () => [], sweep: async () => [] }),
		version: 1,
	};
}

describe("PluginRegistry", () => {
	it("registers and retrieves a plugin", () => {
		const reg = new PluginRegistry();
		reg.register(mockPlugin("evm"));
		expect(reg.get("evm")).toBeDefined();
		expect(reg.get("evm")?.pluginId).toBe("evm");
	});

	it("throws on duplicate registration", () => {
		const reg = new PluginRegistry();
		reg.register(mockPlugin("evm"));
		expect(() => reg.register(mockPlugin("evm"))).toThrow("already registered");
	});

	it("returns undefined for unknown plugin", () => {
		const reg = new PluginRegistry();
		expect(reg.get("unknown")).toBeUndefined();
	});

	it("lists all registered plugins", () => {
		const reg = new PluginRegistry();
		reg.register(mockPlugin("evm"));
		reg.register(mockPlugin("solana", "ed25519"));
		expect(reg.list()).toHaveLength(2);
		expect(
			reg
				.list()
				.map((p) => p.pluginId)
				.sort(),
		).toEqual(["evm", "solana"]);
	});

	it("getOrThrow throws for unknown plugin", () => {
		const reg = new PluginRegistry();
		expect(() => reg.getOrThrow("nope")).toThrow("not registered");
	});
});
