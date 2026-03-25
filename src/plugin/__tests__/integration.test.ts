import { describe, expect, it } from "vitest";
import type { IChainPlugin, PaymentEvent, WatcherOpts } from "../interfaces.js";
import { PluginRegistry } from "../registry.js";

describe("plugin integration — registry → watcher → events", () => {
	it("full lifecycle: register → create watcher → poll → events", async () => {
		const mockEvent: PaymentEvent = {
			chain: "test",
			token: "TEST",
			from: "0xsender",
			to: "0xreceiver",
			rawAmount: "1000",
			amountUsdCents: 100,
			txHash: "0xhash",
			blockNumber: 42,
			confirmations: 6,
			confirmationsRequired: 6,
		};

		const plugin: IChainPlugin = {
			pluginId: "test",
			supportedCurve: "secp256k1",
			encoders: {},
			createWatcher: (_opts: WatcherOpts) => ({
				init: async () => {},
				poll: async () => [mockEvent],
				setWatchedAddresses: () => {},
				getCursor: () => 42,
				stop: () => {},
			}),
			createSweeper: () => ({ scan: async () => [], sweep: async () => [] }),
			version: 1,
		};

		const registry = new PluginRegistry();
		registry.register(plugin);

		const resolved = registry.getOrThrow("test");
		const watcher = resolved.createWatcher({
			rpcUrl: "http://localhost:8545",
			rpcHeaders: {},
			oracle: {
				getPrice: async () => ({ priceMicros: 3500_000000 }),
			},
			cursorStore: {
				get: async () => null,
				save: async () => {},
				getConfirmationCount: async () => null,
				saveConfirmationCount: async () => {},
			},
			token: "TEST",
			chain: "test",
			decimals: 18,
			confirmations: 6,
		});

		await watcher.init();
		const events = await watcher.poll();
		expect(events).toHaveLength(1);
		expect(events[0].txHash).toBe("0xhash");
		expect(watcher.getCursor()).toBe(42);
		watcher.stop();
	});
});
