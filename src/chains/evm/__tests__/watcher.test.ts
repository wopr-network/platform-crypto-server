import { describe, expect, it, vi } from "vitest";
import { EvmWatcher } from "../watcher.js";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function mockTransferLog(to: string, amount: bigint, blockNumber: number) {
	return {
		address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
		topics: [
			TRANSFER_TOPIC,
			`0x${"00".repeat(12)}${"ab".repeat(20)}`, // from (padded)
			`0x${"00".repeat(12)}${to.slice(2).toLowerCase()}`, // to (padded)
		],
		data: `0x${amount.toString(16).padStart(64, "0")}`,
		blockNumber: `0x${blockNumber.toString(16)}`,
		transactionHash: `0x${"ff".repeat(32)}`,
		logIndex: "0x0",
	};
}

describe("EvmWatcher", () => {
	it("parses Transfer log into EvmPaymentEvent", async () => {
		const toAddr = `0x${"cc".repeat(20)}`;
		const events: { amountUsdCents: number; to: string }[] = [];
		const mockRpc = vi
			.fn()
			.mockResolvedValueOnce(`0x${(102).toString(16)}`)
			.mockResolvedValueOnce([mockTransferLog(toAddr, 10_000_000n, 99)]);

		const watcher = new EvmWatcher({
			chain: "base",
			token: "USDC",
			contractAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
			decimals: 6,
			confirmations: 1,
			rpcCall: mockRpc,
			fromBlock: 99,
			watchedAddresses: [toAddr],
			onPayment: (evt) => {
				events.push(evt);
			},
		});

		await watcher.poll();

		expect(events).toHaveLength(1);
		expect(events[0].amountUsdCents).toBe(1000);
		expect(events[0].to).toMatch(/^0x/);
	});

	it("advances cursor after processing", async () => {
		const mockRpc = vi
			.fn()
			.mockResolvedValueOnce(`0x${(200).toString(16)}`)
			.mockResolvedValueOnce([]);

		const watcher = new EvmWatcher({
			chain: "base",
			token: "USDC",
			contractAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
			decimals: 6,
			confirmations: 1,
			rpcCall: mockRpc,
			fromBlock: 100,
			watchedAddresses: ["0xdeadbeef"],
			onPayment: vi.fn(),
		});

		await watcher.poll();
		expect(watcher.cursor).toBeGreaterThan(100);
	});

	it("skips blocks not yet confirmed", async () => {
		const events: unknown[] = [];
		// latest = 50, cursor = 50 → latest < cursor is false, but range is empty (50..50)
		// With intermediate confirmations, we still scan the range but find no logs
		const mockRpc = vi
			.fn()
			.mockResolvedValueOnce(`0x${(50).toString(16)}`) // eth_blockNumber
			.mockResolvedValueOnce([]); // eth_getLogs (empty)

		const watcher = new EvmWatcher({
			chain: "base",
			token: "USDC",
			contractAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
			decimals: 6,
			confirmations: 1,
			rpcCall: mockRpc,
			fromBlock: 50,
			watchedAddresses: ["0xdeadbeef"],
			onPayment: (evt) => {
				events.push(evt);
			},
		});

		await watcher.poll();
		expect(events).toHaveLength(0);
	});

	it("processes multiple logs in one poll", async () => {
		const addr1 = `0x${"aa".repeat(20)}`;
		const addr2 = `0x${"bb".repeat(20)}`;
		const events: { amountUsdCents: number }[] = [];
		const mockRpc = vi
			.fn()
			.mockResolvedValueOnce(`0x${(110).toString(16)}`)
			.mockResolvedValueOnce([mockTransferLog(addr1, 5_000_000n, 105), mockTransferLog(addr2, 20_000_000n, 107)]);

		const watcher = new EvmWatcher({
			chain: "base",
			token: "USDC",
			contractAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
			decimals: 6,
			confirmations: 1,
			rpcCall: mockRpc,
			fromBlock: 100,
			watchedAddresses: [addr1, addr2],
			onPayment: (evt) => {
				events.push(evt);
			},
		});

		await watcher.poll();

		expect(events).toHaveLength(2);
		expect(events[0].amountUsdCents).toBe(500);
		expect(events[1].amountUsdCents).toBe(2000);
	});

	it("does nothing when no new blocks", async () => {
		const mockRpc = vi.fn().mockResolvedValueOnce(`0x${(99).toString(16)}`);

		const watcher = new EvmWatcher({
			chain: "base",
			token: "USDC",
			contractAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
			decimals: 6,
			confirmations: 1,
			rpcCall: mockRpc,
			fromBlock: 100,
			watchedAddresses: ["0xdeadbeef"],
			onPayment: vi.fn(),
		});

		await watcher.poll();
		expect(watcher.cursor).toBe(100);
		expect(mockRpc).toHaveBeenCalledTimes(1);
	});

	it("early-returns when no watched addresses are set", async () => {
		const mockRpc = vi.fn();

		const watcher = new EvmWatcher({
			chain: "base",
			token: "USDC",
			contractAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
			decimals: 6,
			confirmations: 1,
			rpcCall: mockRpc,
			fromBlock: 0,
			onPayment: vi.fn(),
		});

		await watcher.poll();
		expect(mockRpc).not.toHaveBeenCalled(); // no RPC calls at all
	});
});
