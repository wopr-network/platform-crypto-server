/** Supported EVM chains. */
export type EvmChain = "base" | "ethereum" | "arbitrum" | "polygon" | (string & {});

/** Supported stablecoin tokens. */
export type StablecoinToken = "USDC" | "USDT" | "DAI";

/** Chain configuration. */
export interface ChainConfig {
	readonly chain: EvmChain;
	readonly rpcUrl: string;
	readonly confirmations: number;
	readonly blockTimeMs: number;
	readonly chainId: number;
}

/** Token configuration on a specific chain. */
export interface TokenConfig {
	readonly token: StablecoinToken;
	readonly chain: EvmChain;
	readonly contractAddress: `0x${string}`;
	readonly decimals: number;
}

/** Event emitted on each confirmation increment for a Transfer. */
export interface EvmPaymentEvent {
	readonly chain: EvmChain;
	readonly token: StablecoinToken;
	readonly from: string;
	readonly to: string;
	/** Raw token amount (BigInt as string for serialization). */
	readonly rawAmount: string;
	/** USD cents equivalent (integer). */
	readonly amountUsdCents: number;
	readonly txHash: string;
	readonly blockNumber: number;
	readonly logIndex: number;
	/** Current confirmation count (latest block - tx block). */
	readonly confirmations: number;
	/** Required confirmations for this chain. */
	readonly confirmationsRequired: number;
}

/** Options for creating a stablecoin checkout. */
export interface StablecoinCheckoutOpts {
	tenant: string;
	amountUsd: number;
	chain: EvmChain;
	token: StablecoinToken;
}
