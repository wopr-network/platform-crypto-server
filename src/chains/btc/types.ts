/** BTC payment event emitted on each confirmation increment. */
export interface BtcPaymentEvent {
	readonly address: string;
	readonly txid: string;
	/** Amount in satoshis (integer). */
	readonly amountSats: number;
	/** USD cents equivalent (integer). */
	readonly amountUsdCents: number;
	readonly confirmations: number;
	/** Required confirmations for this chain (from config). */
	readonly confirmationsRequired: number;
}

/** Options for creating a BTC checkout. */
export interface BtcCheckoutOpts {
	tenant: string;
	amountUsd: number;
}

/** Bitcoind RPC configuration. */
export interface BitcoindConfig {
	readonly rpcUrl: string;
	readonly rpcUser: string;
	readonly rpcPassword: string;
	readonly network: "mainnet" | "testnet" | "regtest";
	readonly confirmations: number;
}
