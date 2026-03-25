import { describe, expect, it, vi } from "vitest";
import { CoinGeckoOracle } from "../coingecko.js";

/** DB-driven token IDs — mirrors what entry.ts loads from payment_methods.oracle_asset_id */
const TOKEN_IDS: Record<string, string> = {
	BTC: "bitcoin",
	ETH: "ethereum",
	DOGE: "dogecoin",
	LTC: "litecoin",
};

describe("CoinGeckoOracle", () => {
	const mockFetch = (price: number) =>
		vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ bitcoin: { usd: price } }),
		});

	it("returns price in microdollars from CoinGecko API", async () => {
		const oracle = new CoinGeckoOracle({
			tokenIds: TOKEN_IDS,
			fetchFn: mockFetch(84_532.17) as unknown as typeof fetch,
		});
		const result = await oracle.getPrice("BTC");
		expect(result.priceMicros).toBe(84_532_170_000);
		expect(result.updatedAt).toBeInstanceOf(Date);
	});

	it("caches prices within TTL", async () => {
		const fn = mockFetch(84_532.17);
		const oracle = new CoinGeckoOracle({
			tokenIds: TOKEN_IDS,
			fetchFn: fn as unknown as typeof fetch,
			cacheTtlMs: 60_000,
		});
		await oracle.getPrice("BTC");
		await oracle.getPrice("BTC");
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("re-fetches after cache expires", async () => {
		const fn = mockFetch(84_532.17);
		const oracle = new CoinGeckoOracle({ tokenIds: TOKEN_IDS, fetchFn: fn as unknown as typeof fetch, cacheTtlMs: 0 });
		await oracle.getPrice("BTC");
		await oracle.getPrice("BTC");
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("throws for unknown asset when not in DB mapping", async () => {
		const oracle = new CoinGeckoOracle({ tokenIds: TOKEN_IDS, fetchFn: mockFetch(100) as unknown as typeof fetch });
		await expect(oracle.getPrice("UNKNOWN")).rejects.toThrow("No price oracle supports asset: UNKNOWN");
	});

	it("throws on API error", async () => {
		const fn = vi.fn().mockResolvedValue({ ok: false, status: 429, statusText: "Too Many Requests" });
		const oracle = new CoinGeckoOracle({ tokenIds: TOKEN_IDS, fetchFn: fn as unknown as typeof fetch });
		await expect(oracle.getPrice("BTC")).rejects.toThrow("CoinGecko API error");
	});

	it("throws on zero price", async () => {
		const fn = vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ bitcoin: { usd: 0 } }),
		});
		const oracle = new CoinGeckoOracle({ tokenIds: TOKEN_IDS, fetchFn: fn as unknown as typeof fetch });
		await expect(oracle.getPrice("BTC")).rejects.toThrow("Invalid CoinGecko price");
	});

	it("resolves DOGE via DB-driven ID mapping", async () => {
		const fn = vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ dogecoin: { usd: 0.1742 } }),
		});
		const oracle = new CoinGeckoOracle({ tokenIds: TOKEN_IDS, fetchFn: fn as unknown as typeof fetch });
		const result = await oracle.getPrice("DOGE");
		expect(result.priceMicros).toBe(174_200);
		expect(fn).toHaveBeenCalledWith(expect.stringContaining("ids=dogecoin"));
	});

	it("resolves LTC via DB-driven ID mapping", async () => {
		const fn = vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ litecoin: { usd: 92.45 } }),
		});
		const oracle = new CoinGeckoOracle({ tokenIds: TOKEN_IDS, fetchFn: fn as unknown as typeof fetch });
		const result = await oracle.getPrice("LTC");
		expect(result.priceMicros).toBe(92_450_000);
		expect(fn).toHaveBeenCalledWith(expect.stringContaining("ids=litecoin"));
	});
});
