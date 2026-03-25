import { describe, expect, it } from "vitest";
import { FixedPriceOracle } from "../fixed.js";

describe("FixedPriceOracle", () => {
	it("returns default ETH price", async () => {
		const oracle = new FixedPriceOracle();
		const result = await oracle.getPrice("ETH");
		expect(result.priceMicros).toBe(3_500_000_000); // $3,500
		expect(result.updatedAt).toBeInstanceOf(Date);
	});

	it("returns default BTC price", async () => {
		const oracle = new FixedPriceOracle();
		const result = await oracle.getPrice("BTC");
		expect(result.priceMicros).toBe(65_000_000_000); // $65,000
	});

	it("accepts custom prices", async () => {
		const oracle = new FixedPriceOracle({ ETH: 2_000_000_000, BTC: 50_000_000_000 });
		expect((await oracle.getPrice("ETH")).priceMicros).toBe(2_000_000_000);
		expect((await oracle.getPrice("BTC")).priceMicros).toBe(50_000_000_000);
	});
});
