import { describe, expect, it, vi } from "vitest";
import { CompositeOracle } from "../composite.js";
import type { IPriceOracle } from "../types.js";

function mockOracle(priceMicros: number): IPriceOracle {
	return { getPrice: vi.fn().mockResolvedValue({ priceMicros, updatedAt: new Date() }) };
}

function failingOracle(msg = "no feed"): IPriceOracle {
	return { getPrice: vi.fn().mockRejectedValue(new Error(msg)) };
}

describe("CompositeOracle", () => {
	it("uses primary when feedAddress is provided and primary succeeds", async () => {
		const primary = mockOracle(8_500_000);
		const fallback = mockOracle(8_400_000);
		const oracle = new CompositeOracle(primary, fallback);

		const result = await oracle.getPrice("BTC", "0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F");
		expect(result.priceMicros).toBe(8_500_000);
		expect(primary.getPrice).toHaveBeenCalledWith("BTC", "0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F");
		expect(fallback.getPrice).not.toHaveBeenCalled();
	});

	it("falls back when primary fails with feedAddress", async () => {
		const primary = failingOracle("stale");
		const fallback = mockOracle(8_400_000);
		const oracle = new CompositeOracle(primary, fallback);

		const result = await oracle.getPrice("BTC", "0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F");
		expect(result.priceMicros).toBe(8_400_000);
	});

	it("tries primary without feed, then falls back for unknown assets", async () => {
		const primary = failingOracle("No price feed for asset: DOGE");
		const fallback = mockOracle(17);
		const oracle = new CompositeOracle(primary, fallback);

		const result = await oracle.getPrice("DOGE");
		expect(result.priceMicros).toBe(17);
	});

	it("uses primary built-in feeds for BTC/ETH without explicit feedAddress", async () => {
		const primary = mockOracle(8_500_000);
		const fallback = mockOracle(8_400_000);
		const oracle = new CompositeOracle(primary, fallback);

		const result = await oracle.getPrice("BTC");
		expect(result.priceMicros).toBe(8_500_000);
		expect(primary.getPrice).toHaveBeenCalledWith("BTC");
		expect(fallback.getPrice).not.toHaveBeenCalled();
	});

	it("propagates fallback errors when both fail", async () => {
		const primary = failingOracle("no chainlink");
		const fallback = failingOracle("no coingecko");
		const oracle = new CompositeOracle(primary, fallback);

		await expect(oracle.getPrice("UNKNOWN")).rejects.toThrow("no coingecko");
	});
});
