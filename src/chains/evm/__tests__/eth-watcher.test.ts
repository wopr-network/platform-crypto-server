import { describe, expect, it, vi } from "vitest";
import { EthWatcher } from "../eth-watcher.js";

function makeRpc(responses: Record<string, unknown>) {
	return vi.fn(async (method: string) => responses[method]);
}

const mockOracle = { getPrice: vi.fn().mockResolvedValue({ priceMicros: 3_500_000_000, updatedAt: new Date() }) };

describe("EthWatcher", () => {
	it("detects native ETH transfer to watched address", async () => {
		const onPayment = vi.fn();
		// latest = 0xa (10), fromBlock = 10 → scans exactly block 10
		const rpc = makeRpc({
			eth_blockNumber: "0xa",
			eth_getBlockByNumber: {
				transactions: [
					{
						hash: "0xabc",
						from: "0xsender",
						to: "0xdeposit",
						value: "0xDE0B6B3A7640000", // 1 ETH = 10^18 wei
						blockNumber: "0xa",
					},
				],
			},
		});

		const watcher = new EthWatcher({
			chain: "base",
			rpcCall: rpc,
			oracle: mockOracle,
			fromBlock: 10,
			confirmations: 1,
			onPayment,
			watchedAddresses: ["0xDeposit"],
		});

		await watcher.poll();

		expect(onPayment).toHaveBeenCalledOnce();
		const event = onPayment.mock.calls[0][0];
		expect(event.to).toBe("0xdeposit");
		expect(event.valueWei).toBe("1000000000000000000");
		expect(event.amountUsdCents).toBe(350_000); // 1 ETH × $3,500 = $3,500 = 350,000 cents
		expect(event.txHash).toBe("0xabc");
		expect(event.confirmations).toBe(0);
		expect(event.confirmationsRequired).toBe(1);
	});

	it("skips transactions not to watched addresses", async () => {
		const onPayment = vi.fn();
		const rpc = makeRpc({
			eth_blockNumber: "0xb",
			eth_getBlockByNumber: {
				transactions: [{ hash: "0xabc", from: "0xa", to: "0xother", value: "0xDE0B6B3A7640000", blockNumber: "0xa" }],
			},
		});

		const watcher = new EthWatcher({
			chain: "base",
			rpcCall: rpc,
			oracle: mockOracle,
			fromBlock: 10,
			confirmations: 1,
			onPayment,
			watchedAddresses: ["0xDeposit"],
		});

		await watcher.poll();
		expect(onPayment).not.toHaveBeenCalled();
	});

	it("skips zero-value transactions", async () => {
		const onPayment = vi.fn();
		const rpc = makeRpc({
			eth_blockNumber: "0xb",
			eth_getBlockByNumber: {
				transactions: [{ hash: "0xabc", from: "0xa", to: "0xdeposit", value: "0x0", blockNumber: "0xa" }],
			},
		});

		const watcher = new EthWatcher({
			chain: "base",
			rpcCall: rpc,
			oracle: mockOracle,
			fromBlock: 10,
			confirmations: 1,
			onPayment,
			watchedAddresses: ["0xDeposit"],
		});

		await watcher.poll();
		expect(onPayment).not.toHaveBeenCalled();
	});

	it("does not double-process same txid", async () => {
		const onPayment = vi.fn();
		const confirmations = new Map<string, number>();
		const cursorStore = {
			get: vi.fn().mockResolvedValue(null),
			save: vi.fn().mockResolvedValue(undefined),
			hasProcessedTx: vi.fn().mockResolvedValue(false),
			markProcessedTx: vi.fn().mockResolvedValue(undefined),
			getConfirmationCount: vi
				.fn()
				.mockImplementation(async (_: string, txId: string) => confirmations.get(txId) ?? null),
			saveConfirmationCount: vi.fn().mockImplementation(async (_: string, txId: string, count: number) => {
				confirmations.set(txId, count);
			}),
		};
		const rpc = makeRpc({
			eth_blockNumber: "0xb",
			eth_getBlockByNumber: {
				transactions: [{ hash: "0xabc", from: "0xa", to: "0xdeposit", value: "0xDE0B6B3A7640000", blockNumber: "0xa" }],
			},
		});

		const watcher = new EthWatcher({
			chain: "base",
			rpcCall: rpc,
			oracle: mockOracle,
			fromBlock: 10,
			confirmations: 1,
			onPayment,
			watchedAddresses: ["0xDeposit"],
			cursorStore,
		});

		await watcher.poll();
		// Second poll — same block, same confirmations → no duplicate emission
		await watcher.poll();

		expect(onPayment).toHaveBeenCalledOnce();
	});

	it("skips poll when no watched addresses", async () => {
		const onPayment = vi.fn();
		const rpc = vi.fn();

		const watcher = new EthWatcher({
			chain: "base",
			rpcCall: rpc,
			oracle: mockOracle,
			fromBlock: 10,
			confirmations: 1,
			onPayment,
			watchedAddresses: [],
		});

		await watcher.poll();
		expect(rpc).not.toHaveBeenCalled();
	});

	it("does not mark txid as processed if onPayment throws", async () => {
		const onPayment = vi.fn().mockRejectedValueOnce(new Error("db fail")).mockResolvedValueOnce(undefined);
		const cursorStore = {
			get: vi.fn().mockResolvedValue(null),
			save: vi.fn().mockResolvedValue(undefined),
			hasProcessedTx: vi.fn().mockResolvedValue(false),
			markProcessedTx: vi.fn().mockResolvedValue(undefined),
			getConfirmationCount: vi.fn().mockResolvedValue(null),
			saveConfirmationCount: vi.fn().mockResolvedValue(undefined),
		};
		// latest = 0xa (10) = fromBlock → exactly one block to scan
		const rpc = makeRpc({
			eth_blockNumber: "0xa",
			eth_getBlockByNumber: {
				transactions: [{ hash: "0xabc", from: "0xa", to: "0xdeposit", value: "0xDE0B6B3A7640000", blockNumber: "0xa" }],
			},
		});

		const watcher = new EthWatcher({
			chain: "base",
			rpcCall: rpc,
			oracle: mockOracle,
			fromBlock: 10,
			confirmations: 1,
			onPayment,
			watchedAddresses: ["0xDeposit"],
			cursorStore,
		});

		await expect(watcher.poll()).rejects.toThrow("db fail");

		// Retry — should process the same tx again since confirmationCount wasn't saved (error before save)
		await watcher.poll();
		expect(onPayment).toHaveBeenCalledTimes(2);
	});
});
