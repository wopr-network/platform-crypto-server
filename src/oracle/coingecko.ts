import type { IPriceOracle, PriceAsset, PriceResult } from "./types.js";
import { AssetNotSupportedError } from "./types.js";

/** Default cache TTL: 60 seconds. CoinGecko free tier allows 10-30 req/min. */
const DEFAULT_CACHE_TTL_MS = 60_000;

interface CachedPrice {
	priceMicros: number;
	updatedAt: Date;
	fetchedAt: number;
}

export interface CoinGeckoOracleOpts {
	/** Token→CoinGecko ID mapping. Populated from payment_methods.oracle_asset_id at boot. */
	tokenIds: Record<string, string>;
	/** Cache TTL in ms. Default: 60s. */
	cacheTtlMs?: number;
	/** Custom fetch function (for testing). */
	fetchFn?: typeof fetch;
}

/**
 * CoinGecko price oracle — free API, no key required.
 *
 * Token→CoinGecko ID mapping is DB-driven (payment_methods.oracle_asset_id).
 * Adding a new chain = adding a DB row with the CoinGecko slug. No code deploy.
 */
export class CoinGeckoOracle implements IPriceOracle {
	private readonly ids: Record<string, string>;
	private readonly cacheTtlMs: number;
	private readonly fetchFn: typeof fetch;
	private readonly cache = new Map<string, CachedPrice>();

	constructor(opts: CoinGeckoOracleOpts) {
		this.ids = { ...opts.tokenIds };
		this.cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
		this.fetchFn = opts.fetchFn ?? fetch;
	}

	async getPrice(asset: PriceAsset, _feedAddress?: `0x${string}`): Promise<PriceResult> {
		const cached = this.cache.get(asset);
		if (cached && Date.now() - cached.fetchedAt < this.cacheTtlMs) {
			return { priceMicros: cached.priceMicros, updatedAt: cached.updatedAt };
		}

		const coinId = this.ids[asset];
		if (!coinId) throw new AssetNotSupportedError(asset);

		const url = `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`;
		try {
			const res = await this.fetchFn(url);
			if (!res.ok) {
				throw new Error(`CoinGecko API error for ${asset}: ${res.status} ${res.statusText}`);
			}

			const data = (await res.json()) as Record<string, { usd?: number }>;
			const usdPrice = data[coinId]?.usd;
			if (usdPrice === undefined || usdPrice <= 0) {
				throw new Error(`Invalid CoinGecko price for ${asset}: ${usdPrice}`);
			}

			const priceMicros = Math.round(usdPrice * 1_000_000);
			const updatedAt = new Date();

			this.cache.set(asset, { priceMicros, updatedAt, fetchedAt: Date.now() });

			return { priceMicros, updatedAt };
		} catch (err) {
			// Serve stale cache on transient failure (rate limit, network error).
			// A slightly old price is better than rejecting the charge entirely.
			const stale = this.cache.get(asset);
			if (stale) {
				return { priceMicros: stale.priceMicros, updatedAt: stale.updatedAt };
			}
			throw err;
		}
	}
}
