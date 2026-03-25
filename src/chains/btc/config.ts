import type { BitcoindConfig } from "./types.js";

export function loadBitcoindConfig(): BitcoindConfig | null {
	const rpcUrl = process.env.BITCOIND_RPC_URL;
	const rpcUser = process.env.BITCOIND_RPC_USER;
	const rpcPassword = process.env.BITCOIND_RPC_PASSWORD;
	if (!rpcUrl || !rpcUser || !rpcPassword) return null;

	const network = (process.env.BITCOIND_NETWORK ?? "mainnet") as BitcoindConfig["network"];
	const confirmations = network === "regtest" ? 1 : 6;

	return { rpcUrl, rpcUser, rpcPassword, network, confirmations };
}

/**
 * Convert USD cents to satoshis given a BTC/USD price.
 * Integer math only.
 */
export function centsToSats(cents: number, btcPriceUsd: number): number {
	// 1 BTC = 100_000_000 sats, price is in dollars
	// cents / 100 = dollars, dollars / btcPrice = BTC, BTC * 1e8 = sats
	// To avoid float: (cents * 1e8) / (btcPrice * 100)
	return Math.round((cents * 100_000_000) / (btcPriceUsd * 100));
}

/**
 * Convert satoshis to USD cents given a BTC/USD price.
 * Integer math only (rounds to nearest cent).
 */
export function satsToCents(sats: number, btcPriceUsd: number): number {
	// sats / 1e8 = BTC, BTC * btcPrice = dollars, dollars * 100 = cents
	return Math.round((sats * btcPriceUsd * 100) / 100_000_000);
}
