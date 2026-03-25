/**
 * Price units: **microdollars** (1 microdollar = $0.000001 = 10^-6 USD).
 *
 * Why not cents? DOGE at $0.094 rounds to 9 cents — 6% error.
 * Microdollars give 6 decimal places: $0.094147 = 94,147 microdollars.
 *
 * Chainlink feeds: 8 decimals → answer / 100 = microdollars.
 * CoinGecko: Math.round(usd * 1_000_000) = microdollars.
 * All math is integer bigint — no floating point.
 */

/** Microdollars per cent. Multiply amountCents by this to get microdollars. */
const MICROS_PER_CENT = 10_000n;

/**
 * Convert USD cents to native token amount using a price in microdollars.
 *
 * Formula: rawAmount = (amountCents × 10_000) × 10^decimals / priceMicros
 *
 * Examples:
 *   $50 in BTC at $70,315:  centsToNative(5000, 70_315_000_000, 8) = 71,119 sats
 *   $50 in DOGE at $0.094:  centsToNative(5000, 94_147, 8) = 53,107,898,982 base units (531.08 DOGE)
 *
 * Integer math only. No floating point.
 */
export function centsToNative(amountCents: number, priceMicros: number, decimals: number): bigint {
	if (!Number.isInteger(amountCents) || amountCents <= 0) {
		throw new Error(`amountCents must be a positive integer, got ${amountCents}`);
	}
	if (!Number.isInteger(priceMicros) || priceMicros <= 0) {
		throw new Error(`priceMicros must be a positive integer, got ${priceMicros}`);
	}
	if (!Number.isInteger(decimals) || decimals < 0) {
		throw new Error(`decimals must be a non-negative integer, got ${decimals}`);
	}
	// Convert amountCents to microdollars to match priceMicros units
	return (BigInt(amountCents) * MICROS_PER_CENT * 10n ** BigInt(decimals)) / BigInt(priceMicros);
}

/**
 * Convert native token amount back to USD cents using a price in microdollars.
 *
 * Inverse of centsToNative. Truncates fractional cents.
 *
 * Integer math only.
 */
export function nativeToCents(rawAmount: bigint, priceMicros: number, decimals: number): number {
	if (rawAmount < 0n) throw new Error("rawAmount must be non-negative");
	if (!Number.isInteger(priceMicros) || priceMicros <= 0) {
		throw new Error(`priceMicros must be a positive integer, got ${priceMicros}`);
	}
	return Number((rawAmount * BigInt(priceMicros)) / (MICROS_PER_CENT * 10n ** BigInt(decimals)));
}
