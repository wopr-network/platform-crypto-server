import { describe, expect, it, vi } from "vitest";
import { BtcWatcher } from "../watcher.js";

function makeCursorStore() {
	const processed = new Set<string>();
	const confirmationCounts = new Map<string, number>();
	return {
		get: vi.fn().mockResolvedValue(null),
		save: vi.fn().mockResolvedValue(undefined),
		hasProcessedTx: vi.fn().mockImplementation(async (_: string, txId: string) => processed.has(txId)),
		markProcessedTx: vi.fn().mockImplementation(async (_: string, txId: string) => {
			processed.add(txId);
		}),
		getConfirmationCount: vi
			.fn()
			.mockImplementation(async (_: string, txId: string) => confirmationCounts.get(txId) ?? null),
		saveConfirmationCount: vi.fn().mockImplementation(async (_: string, txId: string, count: number) => {
			confirmationCounts.set(txId, count);
		}),
		_processed: processed,
		_confirmationCounts: confirmationCounts,
	};
}

function makeOracle() {
	return { getPrice: vi.fn().mockResolvedValue({ priceMicros: 65_000_000_000 }) };
}

describe("BtcWatcher — intermediate confirmations", () => {
	it("fires onPayment at 0 confirmations when tx first detected", async () => {
		const events: Array<{ confirmations: number; confirmationsRequired: number }> = [];
		const cursorStore = makeCursorStore();
		const rpc = vi
			.fn()
			.mockResolvedValueOnce([{ address: "bc1qtest", amount: 0.0005, confirmations: 0, txids: ["tx1"] }])
			.mockResolvedValueOnce({
				details: [{ address: "bc1qtest", amount: 0.0005, category: "receive" }],
				confirmations: 0,
			});

		const watcher = new BtcWatcher({
			config: { rpcUrl: "http://localhost", rpcUser: "u", rpcPassword: "p", network: "regtest", confirmations: 3 },
			rpcCall: rpc,
			watchedAddresses: ["bc1qtest"],
			oracle: makeOracle(),
			cursorStore,
			onPayment: (evt) => {
				events.push(evt);
			},
		});

		await watcher.poll();

		expect(events).toHaveLength(1);
		expect(events[0].confirmations).toBe(0);
		expect(events[0].confirmationsRequired).toBe(3);
	});

	it("fires onPayment on each confirmation increment", async () => {
		const events: Array<{ confirmations: number }> = [];
		const cursorStore = makeCursorStore();
		cursorStore._confirmationCounts.set("tx1", 1);

		const rpc = vi
			.fn()
			.mockResolvedValueOnce([{ address: "bc1qtest", amount: 0.0005, confirmations: 2, txids: ["tx1"] }])
			.mockResolvedValueOnce({
				details: [{ address: "bc1qtest", amount: 0.0005, category: "receive" }],
				confirmations: 2,
			});

		const watcher = new BtcWatcher({
			config: { rpcUrl: "http://localhost", rpcUser: "u", rpcPassword: "p", network: "regtest", confirmations: 3 },
			rpcCall: rpc,
			watchedAddresses: ["bc1qtest"],
			oracle: makeOracle(),
			cursorStore,
			onPayment: (evt) => {
				events.push(evt);
			},
		});

		await watcher.poll();

		expect(events).toHaveLength(1);
		expect(events[0].confirmations).toBe(2);
	});

	it("does not fire when confirmation count unchanged", async () => {
		const events: Array<{ confirmations: number }> = [];
		const cursorStore = makeCursorStore();
		cursorStore._confirmationCounts.set("tx1", 2);

		const rpc = vi
			.fn()
			.mockResolvedValueOnce([{ address: "bc1qtest", amount: 0.0005, confirmations: 2, txids: ["tx1"] }])
			.mockResolvedValueOnce({
				details: [{ address: "bc1qtest", amount: 0.0005, category: "receive" }],
				confirmations: 2,
			});

		const watcher = new BtcWatcher({
			config: { rpcUrl: "http://localhost", rpcUser: "u", rpcPassword: "p", network: "regtest", confirmations: 3 },
			rpcCall: rpc,
			watchedAddresses: ["bc1qtest"],
			oracle: makeOracle(),
			cursorStore,
			onPayment: (evt) => {
				events.push(evt);
			},
		});

		await watcher.poll();

		expect(events).toHaveLength(0);
	});

	it("marks tx as processed once confirmations reach threshold", async () => {
		const events: Array<{ confirmations: number }> = [];
		const cursorStore = makeCursorStore();
		cursorStore._confirmationCounts.set("tx1", 2);

		const rpc = vi
			.fn()
			.mockResolvedValueOnce([{ address: "bc1qtest", amount: 0.0005, confirmations: 3, txids: ["tx1"] }])
			.mockResolvedValueOnce({
				details: [{ address: "bc1qtest", amount: 0.0005, category: "receive" }],
				confirmations: 3,
			});

		const watcher = new BtcWatcher({
			config: { rpcUrl: "http://localhost", rpcUser: "u", rpcPassword: "p", network: "regtest", confirmations: 3 },
			rpcCall: rpc,
			watchedAddresses: ["bc1qtest"],
			oracle: makeOracle(),
			cursorStore,
			onPayment: (evt) => {
				events.push(evt);
			},
		});

		await watcher.poll();

		expect(events).toHaveLength(1);
		expect(events[0].confirmations).toBe(3);
		expect(cursorStore.markProcessedTx).toHaveBeenCalledWith(expect.any(String), "tx1");
	});

	it("skips fully-processed txids", async () => {
		const events: unknown[] = [];
		const cursorStore = makeCursorStore();
		cursorStore._processed.add("tx1");

		const rpc = vi
			.fn()
			.mockResolvedValueOnce([{ address: "bc1qtest", amount: 0.0005, confirmations: 6, txids: ["tx1"] }]);

		const watcher = new BtcWatcher({
			config: { rpcUrl: "http://localhost", rpcUser: "u", rpcPassword: "p", network: "regtest", confirmations: 3 },
			rpcCall: rpc,
			watchedAddresses: ["bc1qtest"],
			oracle: makeOracle(),
			cursorStore,
			onPayment: (evt) => {
				events.push(evt);
			},
		});

		await watcher.poll();

		expect(events).toHaveLength(0);
	});

	it("includes confirmationsRequired in event", async () => {
		const events: Array<{ confirmationsRequired: number }> = [];
		const cursorStore = makeCursorStore();

		const rpc = vi
			.fn()
			.mockResolvedValueOnce([{ address: "bc1qtest", amount: 0.001, confirmations: 0, txids: ["txNew"] }])
			.mockResolvedValueOnce({
				details: [{ address: "bc1qtest", amount: 0.001, category: "receive" }],
				confirmations: 0,
			});

		const watcher = new BtcWatcher({
			config: { rpcUrl: "http://localhost", rpcUser: "u", rpcPassword: "p", network: "regtest", confirmations: 6 },
			rpcCall: rpc,
			watchedAddresses: ["bc1qtest"],
			oracle: makeOracle(),
			cursorStore,
			onPayment: (evt) => {
				events.push(evt);
			},
		});

		await watcher.poll();

		expect(events[0].confirmationsRequired).toBe(6);
	});
});
