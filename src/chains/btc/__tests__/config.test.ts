import { describe, expect, it } from "vitest";
import { centsToSats, satsToCents } from "../config.js";

describe("centsToSats", () => {
	it("converts $10 at $100k BTC", () => {
		// $10 = 1000 cents, BTC at $100,000
		// 10 / 100000 = 0.0001 BTC = 10000 sats
		expect(centsToSats(1000, 100_000)).toBe(10000);
	});

	it("converts $100 at $50k BTC", () => {
		// $100 = 10000 cents, BTC at $50,000
		// 100 / 50000 = 0.002 BTC = 200000 sats
		expect(centsToSats(10000, 50_000)).toBe(200000);
	});
});

describe("satsToCents", () => {
	it("converts 10000 sats at $100k BTC", () => {
		// 10000 sats = 0.0001 BTC, at $100k = $10 = 1000 cents
		expect(satsToCents(10000, 100_000)).toBe(1000);
	});

	it("rounds to nearest cent", () => {
		// 15000 sats at $100k = 0.00015 BTC = $15 = 1500 cents
		expect(satsToCents(15000, 100_000)).toBe(1500);
	});
});
