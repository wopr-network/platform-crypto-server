import type { IPriceOracle, PriceAsset, PriceResult } from "./types.js";

/**
 * Fixed-price oracle for testing and local dev (Anvil, regtest).
 * Returns hardcoded prices in microdollars — no RPC calls.
 */
export class FixedPriceOracle implements IPriceOracle {
	private readonly prices: Record<string, number>;

	constructor(prices: Partial<Record<PriceAsset, number>> = {}) {
		this.prices = {
			ETH: 3_500_000_000, // $3,500 in microdollars
			BTC: 65_000_000_000, // $65,000 in microdollars
			DOGE: 94_000, // $0.094 in microdollars
			LTC: 55_000_000, // $55 in microdollars
			...prices,
		};
	}

	async getPrice(asset: PriceAsset, _feedAddress?: `0x${string}`): Promise<PriceResult> {
		const priceMicros = this.prices[asset];
		if (priceMicros === undefined) throw new Error(`No fixed price for ${asset}`);
		return { priceMicros, updatedAt: new Date() };
	}
}
