import type { ChainConfig, EvmChain, StablecoinToken, TokenConfig } from "./types.js";

const CHAINS: Record<EvmChain, ChainConfig> = {
	base: {
		chain: "base",
		rpcUrl: process.env.EVM_RPC_BASE ?? "http://op-geth:8545",
		confirmations: 1,
		blockTimeMs: 2000,
		chainId: 8453,
	},
	ethereum: {
		chain: "ethereum",
		rpcUrl: process.env.EVM_RPC_ETHEREUM ?? "http://geth:8545",
		confirmations: 12,
		blockTimeMs: 12000,
		chainId: 1,
	},
	arbitrum: {
		chain: "arbitrum",
		rpcUrl: process.env.EVM_RPC_ARBITRUM ?? "http://nitro:8547",
		confirmations: 1,
		blockTimeMs: 250,
		chainId: 42161,
	},
	polygon: {
		chain: "polygon",
		rpcUrl: process.env.EVM_RPC_POLYGON ?? "http://bor:8545",
		confirmations: 32,
		blockTimeMs: 2000,
		chainId: 137,
	},
};

const TOKENS: Partial<Record<`${StablecoinToken}:${EvmChain}`, TokenConfig>> = {
	// --- Base ---
	"USDC:base": {
		token: "USDC",
		chain: "base",
		contractAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
		decimals: 6,
	},
	"USDT:base": {
		token: "USDT",
		chain: "base",
		contractAddress: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
		decimals: 6,
	},
	"DAI:base": {
		token: "DAI",
		chain: "base",
		contractAddress: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
		decimals: 18,
	},
	// --- Ethereum ---
	"USDC:ethereum": {
		token: "USDC",
		chain: "ethereum",
		contractAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
		decimals: 6,
	},
	"USDT:ethereum": {
		token: "USDT",
		chain: "ethereum",
		contractAddress: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
		decimals: 6,
	},
	"DAI:ethereum": {
		token: "DAI",
		chain: "ethereum",
		contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
		decimals: 18,
	},
	// --- Arbitrum ---
	"USDC:arbitrum": {
		token: "USDC",
		chain: "arbitrum",
		contractAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
		decimals: 6,
	},
	"USDT:arbitrum": {
		token: "USDT",
		chain: "arbitrum",
		contractAddress: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
		decimals: 6,
	},
	"DAI:arbitrum": {
		token: "DAI",
		chain: "arbitrum",
		contractAddress: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
		decimals: 18,
	},
	// --- Polygon ---
	"USDC:polygon": {
		token: "USDC",
		chain: "polygon",
		contractAddress: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
		decimals: 6,
	},
	"USDT:polygon": {
		token: "USDT",
		chain: "polygon",
		contractAddress: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
		decimals: 6,
	},
};

export function getChainConfig(chain: EvmChain): ChainConfig {
	const cfg = CHAINS[chain];
	if (!cfg) throw new Error(`Unsupported chain: ${chain}`);
	return cfg;
}

export function getTokenConfig(token: StablecoinToken, chain: EvmChain): TokenConfig {
	const key = `${token}:${chain}` as const;
	const cfg = TOKENS[key];
	if (!cfg) throw new Error(`Unsupported token ${token} on ${chain}`);
	return cfg;
}

/**
 * Convert USD cents (integer) to token raw amount (BigInt).
 * Stablecoins are 1:1 USD. Integer math only.
 */
export function tokenAmountFromCents(cents: number, decimals: number): bigint {
	if (!Number.isInteger(cents)) throw new Error("cents must be an integer");
	return (BigInt(cents) * 10n ** BigInt(decimals)) / 100n;
}

/**
 * Convert token raw amount (BigInt) to USD cents (integer).
 * Truncates fractional cents.
 */
export function centsFromTokenAmount(rawAmount: bigint, decimals: number): number {
	return Number((rawAmount * 100n) / 10n ** BigInt(decimals));
}
