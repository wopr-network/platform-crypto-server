import { describe, expect, it, vi } from "vitest";
import { EvmWatcher } from "../watcher.js";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function mockTransferLog(to: string, amount: bigint, blockNumber: number) {
	return {
		address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
		topics: [
			TRANSFER_TOPIC,
			`0x${"00".repeat(12)}${"ab".repeat(20)}`,
			`0x${"00".repeat(12)}${to.slice(2).toLowerCase()}`,
		],
		data: `0x${amount.toString(16).padStart(64, "0")}`,
		blockNumber: `0x${blockNumber.toString(16)}`,
		transactionHash: `0x${"ff".repeat(32)}`,
		logIndex: "0x0",
	};
}

function makeCursorStore() {
	const cursors = new Map<string, number>();
	return {
		get: vi.fn().mockImplementation(async (id: string) => cursors.get(id) ?? null),
		save: vi.fn().mockImplementation(async (id: string, val: number) => {
			cursors.set(id, val);
		}),
		hasProcessedTx: vi.fn().mockResolvedValue(false),
		markProcessedTx: vi.fn().mockResolvedValue(undefined),
		getConfirmationCount: vi.fn().mockResolvedValue(null),
		saveConfirmationCount: vi.fn().mockResolvedValue(undefined),
	};
}

describe("EvmWatcher — intermediate confirmations", () => {
	it("emits events with confirmation count", async () => {
		const toAddr = `0x${"cc".repeat(20)}`;
		const events: Array<{ confirmations: number; confirmationsRequired: number }> = [];

		// Base has confirmations: 1. Latest block is 105. Log at block 103 -> 2 confirmations.
		const mockRpc = vi
			.fn()
			.mockResolvedValueOnce(`0x${(105).toString(16)}`) // eth_blockNumber
			.mockResolvedValueOnce([mockTransferLog(toAddr, 10_000_000n, 103)]); // eth_getLogs

		const watcher = new EvmWatcher({
			chain: "base",
			token: "USDC",
			contractAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
			decimals: 6,
			confirmations: 1,
			rpcCall: mockRpc,
			fromBlock: 100,
			watchedAddresses: [toAddr],
			cursorStore: makeCursorStore(),
			onPayment: (evt) => {
				events.push(evt);
			},
		});

		await watcher.poll();

		expect(events).toHaveLength(1);
		expect(events[0].confirmations).toBe(2); // 105 - 103
		expect(events[0].confirmationsRequired).toBe(1); // Base chain config
	});

	it("skips event when confirmation count unchanged", async () => {
		const toAddr = `0x${"cc".repeat(20)}`;
		const events: Array<{ confirmations: number }> = [];
		const cursorStore = makeCursorStore();
		cursorStore.getConfirmationCount.mockResolvedValue(2);

		const mockRpc = vi
			.fn()
			.mockResolvedValueOnce(`0x${(105).toString(16)}`)
			.mockResolvedValueOnce([mockTransferLog(toAddr, 10_000_000n, 103)]);

		const watcher = new EvmWatcher({
			chain: "base",
			token: "USDC",
			contractAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
			decimals: 6,
			confirmations: 1,
			rpcCall: mockRpc,
			fromBlock: 100,
			watchedAddresses: [toAddr],
			cursorStore,
			onPayment: (evt) => {
				events.push(evt);
			},
		});

		await watcher.poll();

		expect(events).toHaveLength(0);
	});

	it("re-emits when confirmations increase", async () => {
		const toAddr = `0x${"cc".repeat(20)}`;
		const events: Array<{ confirmations: number }> = [];
		const cursorStore = makeCursorStore();
		cursorStore.getConfirmationCount.mockResolvedValue(1);

		const mockRpc = vi
			.fn()
			.mockResolvedValueOnce(`0x${(105).toString(16)}`)
			.mockResolvedValueOnce([mockTransferLog(toAddr, 10_000_000n, 103)]);

		const watcher = new EvmWatcher({
			chain: "base",
			token: "USDC",
			contractAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
			decimals: 6,
			confirmations: 1,
			rpcCall: mockRpc,
			fromBlock: 100,
			watchedAddresses: [toAddr],
			cursorStore,
			onPayment: (evt) => {
				events.push(evt);
			},
		});

		await watcher.poll();

		expect(events).toHaveLength(1);
		expect(events[0].confirmations).toBe(2);
	});

	it("includes confirmationsRequired from chain config", async () => {
		const toAddr = `0x${"cc".repeat(20)}`;
		const events: Array<{ confirmationsRequired: number }> = [];

		const mockRpc = vi
			.fn()
			.mockResolvedValueOnce(`0x${(110).toString(16)}`)
			.mockResolvedValueOnce([mockTransferLog(toAddr, 10_000_000n, 105)]);

		const watcher = new EvmWatcher({
			chain: "base",
			token: "USDC",
			contractAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
			decimals: 6,
			confirmations: 1,
			rpcCall: mockRpc,
			fromBlock: 100,
			watchedAddresses: [toAddr],
			cursorStore: makeCursorStore(),
			onPayment: (evt) => {
				events.push(evt);
			},
		});

		await watcher.poll();

		expect(events).toHaveLength(1);
		expect(events[0].confirmationsRequired).toBe(1); // Base chain config
	});

	it("saves confirmation count after emitting", async () => {
		const toAddr = `0x${"cc".repeat(20)}`;
		const cursorStore = makeCursorStore();

		const mockRpc = vi
			.fn()
			.mockResolvedValueOnce(`0x${(105).toString(16)}`)
			.mockResolvedValueOnce([mockTransferLog(toAddr, 10_000_000n, 103)]);

		const watcher = new EvmWatcher({
			chain: "base",
			token: "USDC",
			contractAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
			decimals: 6,
			confirmations: 1,
			rpcCall: mockRpc,
			fromBlock: 100,
			watchedAddresses: [toAddr],
			cursorStore,
			onPayment: () => {},
		});

		await watcher.poll();

		expect(cursorStore.saveConfirmationCount).toHaveBeenCalledWith(
			expect.any(String),
			expect.stringContaining("0x"),
			2,
		);
	});
});
