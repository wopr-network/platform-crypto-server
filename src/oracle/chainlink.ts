import type { IPriceOracle, PriceAsset, PriceResult } from "./types.js";

/**
 * Chainlink price feed addresses on Base mainnet.
 * These are ERC-1967 proxy contracts — addresses are stable.
 */
const FEED_ADDRESSES: Record<PriceAsset, `0x${string}`> = {
	ETH: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
	BTC: "0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F",
};

/** Function selector for latestRoundData(). */
const LATEST_ROUND_DATA = "0xfeaf968c";

/** Default max staleness: 1 hour. */
const DEFAULT_MAX_STALENESS_MS = 60 * 60 * 1000;

type RpcCall = (method: string, params: unknown[]) => Promise<unknown>;

export interface ChainlinkOracleOpts {
	rpcCall: RpcCall;
	/** Override feed addresses (e.g. for testnet or Anvil forks). */
	feedAddresses?: Partial<Record<PriceAsset, `0x${string}`>>;
	/** Maximum age of price data before rejecting (ms). Default: 1 hour. */
	maxStalenessMs?: number;
}

/**
 * On-chain Chainlink price oracle.
 *
 * Reads latestRoundData() from Chainlink aggregator contracts via eth_call.
 * No API key, no rate limits — just an RPC call to our own node.
 *
 * Chainlink USD feeds use 8 decimals. We convert to integer USD cents:
 *   priceMicros = answer / 100  (i.e. answer / 10^8 * 10^6)
 */
export class ChainlinkOracle implements IPriceOracle {
	private readonly rpc: RpcCall;
	private readonly feeds: Map<string, `0x${string}`>;
	private readonly maxStalenessMs: number;

	constructor(opts: ChainlinkOracleOpts) {
		this.rpc = opts.rpcCall;
		this.feeds = new Map(Object.entries({ ...FEED_ADDRESSES, ...opts.feedAddresses })) as Map<string, `0x${string}`>;
		this.maxStalenessMs = opts.maxStalenessMs ?? DEFAULT_MAX_STALENESS_MS;
	}

	async getPrice(asset: PriceAsset, feedAddress?: `0x${string}`): Promise<PriceResult> {
		const resolvedFeed = feedAddress ?? this.feeds.get(asset);
		if (!resolvedFeed) throw new Error(`No price feed for asset: ${asset}`);

		const result = (await this.rpc("eth_call", [{ to: resolvedFeed, data: LATEST_ROUND_DATA }, "latest"])) as string;

		// ABI decode latestRoundData() return:
		//   [0]  roundId       (uint80)  — skip
		//   [1]  answer        (int256)  — price × 10^8
		//   [2]  startedAt     (uint256) — skip
		//   [3]  updatedAt     (uint256) — unix seconds
		//   [4]  answeredInRound (uint80) — skip
		const hex = result.slice(2);
		if (hex.length < 320) {
			throw new Error(`Malformed Chainlink response for ${asset}: expected 320 hex chars, got ${hex.length}`);
		}

		const answer = BigInt(`0x${hex.slice(64, 128)}`);
		const updatedAtSec = Number(BigInt(`0x${hex.slice(192, 256)}`));
		const updatedAt = new Date(updatedAtSec * 1000);

		// Staleness guard.
		const ageMs = Date.now() - updatedAt.getTime();
		if (ageMs > this.maxStalenessMs) {
			throw new Error(
				`Price feed for ${asset} is stale (${Math.round(ageMs / 1000)}s old, max ${Math.round(this.maxStalenessMs / 1000)}s)`,
			);
		}

		// Chainlink USD feeds: 8 decimals. answer / 100 = microdollars (10^-6 USD).
		// e.g. BTC at $70,315 → answer = 7_031_500_000_000 → 70_315_000_000 microdollars
		const priceMicros = Number(answer / 100n);
		if (priceMicros <= 0) {
			throw new Error(`Invalid price for ${asset}: ${priceMicros} microdollars`);
		}

		return { priceMicros, updatedAt };
	}
}
