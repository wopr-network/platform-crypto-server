import { describe, expect, it, vi } from "vitest";
import { ChainlinkOracle } from "../chainlink.js";

/**
 * Encode a mock latestRoundData() response.
 * Chainlink returns 5 × 32-byte ABI-encoded words:
 *   roundId, answer, startedAt, updatedAt, answeredInRound
 */
function encodeRoundData(answer: bigint, updatedAtSec: number): string {
	const pad = (v: bigint) => v.toString(16).padStart(64, "0");
	return (
		"0x" +
		pad(1n) + // roundId
		pad(answer) + // answer (price × 10^8)
		pad(BigInt(updatedAtSec)) + // startedAt
		pad(BigInt(updatedAtSec)) + // updatedAt
		pad(1n) // answeredInRound
	);
}

describe("ChainlinkOracle", () => {
	const nowSec = Math.floor(Date.now() / 1000);

	it("decodes ETH/USD price from latestRoundData", async () => {
		// ETH at $3,500.00 → answer = 3500 × 10^8 = 350_000_000_000
		const rpc = vi.fn().mockResolvedValue(encodeRoundData(350_000_000_000n, nowSec));
		const oracle = new ChainlinkOracle({ rpcCall: rpc });

		const result = await oracle.getPrice("ETH");

		expect(result.priceMicros).toBe(3_500_000_000); // $3,500.00
		expect(result.updatedAt).toBeInstanceOf(Date);
		expect(rpc).toHaveBeenCalledWith("eth_call", [
			{ to: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70", data: "0xfeaf968c" },
			"latest",
		]);
	});

	it("decodes BTC/USD price from latestRoundData", async () => {
		// BTC at $65,000.00 → answer = 65000 × 10^8 = 6_500_000_000_000
		const rpc = vi.fn().mockResolvedValue(encodeRoundData(6_500_000_000_000n, nowSec));
		const oracle = new ChainlinkOracle({ rpcCall: rpc });

		const result = await oracle.getPrice("BTC");

		expect(result.priceMicros).toBe(65_000_000_000); // $65,000.00
	});

	it("handles fractional dollar prices correctly", async () => {
		// ETH at $3,456.78 → answer = 345_678_000_000
		const rpc = vi.fn().mockResolvedValue(encodeRoundData(345_678_000_000n, nowSec));
		const oracle = new ChainlinkOracle({ rpcCall: rpc });

		const result = await oracle.getPrice("ETH");

		expect(result.priceMicros).toBe(3_456_780_000); // $3,456.78
	});

	it("rejects stale prices", async () => {
		const staleTime = nowSec - 7200; // 2 hours ago
		const rpc = vi.fn().mockResolvedValue(encodeRoundData(350_000_000_000n, staleTime));
		const oracle = new ChainlinkOracle({ rpcCall: rpc, maxStalenessMs: 3600_000 });

		await expect(oracle.getPrice("ETH")).rejects.toThrow("stale");
	});

	it("rejects zero price", async () => {
		const rpc = vi.fn().mockResolvedValue(encodeRoundData(0n, nowSec));
		const oracle = new ChainlinkOracle({ rpcCall: rpc });

		await expect(oracle.getPrice("ETH")).rejects.toThrow("Invalid price");
	});

	it("rejects malformed response", async () => {
		const rpc = vi.fn().mockResolvedValue("0xdead");
		const oracle = new ChainlinkOracle({ rpcCall: rpc });

		await expect(oracle.getPrice("ETH")).rejects.toThrow("Malformed");
	});

	it("accepts custom feed addresses", async () => {
		const customFeed = "0x1234567890abcdef1234567890abcdef12345678" as `0x${string}`;
		const rpc = vi.fn().mockResolvedValue(encodeRoundData(350_000_000_000n, nowSec));
		const oracle = new ChainlinkOracle({
			rpcCall: rpc,
			feedAddresses: { ETH: customFeed },
		});

		await oracle.getPrice("ETH");

		expect(rpc).toHaveBeenCalledWith("eth_call", [{ to: customFeed, data: "0xfeaf968c" }, "latest"]);
	});

	it("respects custom staleness threshold", async () => {
		const thirtyMinAgo = nowSec - 1800;
		const rpc = vi.fn().mockResolvedValue(encodeRoundData(350_000_000_000n, thirtyMinAgo));

		// 20-minute threshold → stale
		const strict = new ChainlinkOracle({ rpcCall: rpc, maxStalenessMs: 20 * 60 * 1000 });
		await expect(strict.getPrice("ETH")).rejects.toThrow("stale");

		// 60-minute threshold → fresh
		const relaxed = new ChainlinkOracle({ rpcCall: rpc, maxStalenessMs: 60 * 60 * 1000 });
		const result = await relaxed.getPrice("ETH");
		expect(result.priceMicros).toBe(3_500_000_000);
	});
});
