import { describe, expect, it } from "vitest";
import { centsToNative, nativeToCents } from "../convert.js";

describe("centsToNative", () => {
	it("converts $50 to ETH wei at $3,500", () => {
		// 5000 cents × 10000 × 10^18 / 3_500_000_000 micros = 14285714285714285n wei
		const wei = centsToNative(5000, 3_500_000_000, 18);
		expect(wei).toBe(14_285_714_285_714_285n);
	});

	it("converts $50 to BTC sats at $65,000", () => {
		// 5000 cents × 10000 × 10^8 / 65_000_000_000 micros = 76923n sats
		const sats = centsToNative(5000, 65_000_000_000, 8);
		expect(sats).toBe(76_923n);
	});

	it("converts $50 to DOGE at $0.094147", () => {
		// 5000 cents × 10000 × 10^8 / 94_147 micros = 53_107_898_982n base units (531.08 DOGE)
		const dogeUnits = centsToNative(5000, 94_147, 8);
		expect(Number(dogeUnits) / 1e8).toBeCloseTo(531.08, 0);
	});

	it("converts $50 to LTC at $55.79", () => {
		// 5000 cents × 10000 × 10^8 / 55_790_000 micros = 89_622_512n base units (0.896 LTC)
		const ltcUnits = centsToNative(5000, 55_790_000, 8);
		expect(Number(ltcUnits) / 1e8).toBeCloseTo(0.896, 2);
	});

	it("converts $100 to ETH wei at $2,000", () => {
		// 10000 cents × 10000 × 10^18 / 2_000_000_000 micros = 50_000_000_000_000_000n (0.05 ETH)
		const wei = centsToNative(10_000, 2_000_000_000, 18);
		expect(wei).toBe(50_000_000_000_000_000n);
	});

	it("rejects non-integer amountCents", () => {
		expect(() => centsToNative(50.5, 3_500_000_000, 18)).toThrow("positive integer");
	});

	it("rejects zero amountCents", () => {
		expect(() => centsToNative(0, 3_500_000_000, 18)).toThrow("positive integer");
	});

	it("rejects zero priceMicros", () => {
		expect(() => centsToNative(5000, 0, 18)).toThrow("positive integer");
	});

	it("rejects negative decimals", () => {
		expect(() => centsToNative(5000, 3_500_000_000, -1)).toThrow("non-negative integer");
	});
});

describe("nativeToCents", () => {
	it("converts ETH wei back to cents at $3,500", () => {
		// 14285714285714285n × 3_500_000_000 / (10000 × 10^18) = 4999 cents (truncated)
		const cents = nativeToCents(14_285_714_285_714_285n, 3_500_000_000, 18);
		expect(cents).toBe(4999);
	});

	it("converts BTC sats back to cents at $65,000", () => {
		// 76923n × 65_000_000_000 / (10000 × 10^8) = 4999 cents
		const cents = nativeToCents(76_923n, 65_000_000_000, 8);
		expect(cents).toBe(4999);
	});

	it("exact round-trip for clean division", () => {
		// 0.05 ETH at $2,000 = $100
		const cents = nativeToCents(50_000_000_000_000_000n, 2_000_000_000, 18);
		expect(cents).toBe(10_000); // $100.00
	});

	it("rejects negative rawAmount", () => {
		expect(() => nativeToCents(-1n, 3_500_000_000, 18)).toThrow("non-negative");
	});
});
