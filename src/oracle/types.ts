/** Assets with Chainlink price feeds. */
export type PriceAsset = string;

/** Thrown when no oracle supports a given asset (not a transient failure). */
export class AssetNotSupportedError extends Error {
	constructor(asset: string) {
		super(`No price oracle supports asset: ${asset}`);
		this.name = "AssetNotSupportedError";
	}
}

/** Result from a price oracle query. */
export interface PriceResult {
	/** Microdollars per 1 unit of asset (integer, 10^-6 USD). */
	priceMicros: number;
	/** When the price was last updated on-chain. */
	updatedAt: Date;
}

/** Read-only price oracle. */
export interface IPriceOracle {
	/**
	 * Get the current USD price for an asset.
	 * @param asset — token symbol (e.g. "BTC", "DOGE")
	 * @param feedAddress — optional Chainlink feed address override (from payment_methods.oracle_address)
	 */
	getPrice(asset: PriceAsset, feedAddress?: `0x${string}`): Promise<PriceResult>;
}
