import type { IPriceOracle, PriceAsset, PriceResult } from "./types.js";

/**
 * Composite oracle — tries primary (Chainlink on-chain), falls back to secondary (CoinGecko).
 *
 * When a feedAddress is provided (from payment_methods.oracle_address), the primary
 * oracle is used with that address. When no feed exists or the primary fails,
 * the fallback oracle is consulted.
 */
export class CompositeOracle implements IPriceOracle {
	constructor(
		private readonly primary: IPriceOracle,
		private readonly fallback: IPriceOracle,
	) {}

	async getPrice(asset: PriceAsset, feedAddress?: `0x${string}`): Promise<PriceResult> {
		// If a specific feed address is provided, try the primary (Chainlink) first
		if (feedAddress) {
			try {
				return await this.primary.getPrice(asset, feedAddress);
			} catch {
				// Primary failed (stale, network error) — fall through to fallback
			}
		}

		// Try primary without explicit feed (uses built-in feed map for BTC/ETH)
		try {
			return await this.primary.getPrice(asset);
		} catch {
			// No feed configured or call failed — use fallback
		}

		return this.fallback.getPrice(asset);
	}
}
