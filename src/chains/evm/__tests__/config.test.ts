import { describe, expect, it } from "vitest";
import { centsFromTokenAmount, getChainConfig, getTokenConfig, tokenAmountFromCents } from "../config.js";

describe("getChainConfig", () => {
	it("returns Base config", () => {
		const cfg = getChainConfig("base");
		expect(cfg.chainId).toBe(8453);
		expect(cfg.confirmations).toBe(1);
		expect(cfg.blockTimeMs).toBe(2000);
	});

	it("returns Ethereum config", () => {
		const cfg = getChainConfig("ethereum");
		expect(cfg.chainId).toBe(1);
		expect(cfg.confirmations).toBe(12);
	});

	it("returns Arbitrum config", () => {
		const cfg = getChainConfig("arbitrum");
		expect(cfg.chainId).toBe(42161);
		expect(cfg.confirmations).toBe(1);
	});

	it("returns Polygon config", () => {
		const cfg = getChainConfig("polygon");
		expect(cfg.chainId).toBe(137);
		expect(cfg.confirmations).toBe(32);
	});

	it("throws on unknown chain", () => {
		// biome-ignore lint/suspicious/noExplicitAny: testing invalid input
		expect(() => getChainConfig("solana" as any)).toThrow("Unsupported chain");
	});
});

describe("getTokenConfig", () => {
	it("returns USDC on Base", () => {
		const cfg = getTokenConfig("USDC", "base");
		expect(cfg.decimals).toBe(6);
		expect(cfg.contractAddress).toMatch(/^0x/);
		expect(cfg.contractAddress).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
	});

	it("returns USDT on Base", () => {
		const cfg = getTokenConfig("USDT", "base");
		expect(cfg.decimals).toBe(6);
		expect(cfg.contractAddress).toBe("0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2");
	});

	it("returns DAI on Base", () => {
		const cfg = getTokenConfig("DAI", "base");
		expect(cfg.decimals).toBe(18);
		expect(cfg.contractAddress).toBe("0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb");
	});

	it("returns USDC on Ethereum", () => {
		const cfg = getTokenConfig("USDC", "ethereum");
		expect(cfg.decimals).toBe(6);
		expect(cfg.contractAddress).toBe("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
	});

	it("returns USDT on Ethereum", () => {
		const cfg = getTokenConfig("USDT", "ethereum");
		expect(cfg.decimals).toBe(6);
	});

	it("returns DAI on Ethereum", () => {
		const cfg = getTokenConfig("DAI", "ethereum");
		expect(cfg.decimals).toBe(18);
	});

	it("returns USDC on Arbitrum", () => {
		const cfg = getTokenConfig("USDC", "arbitrum");
		expect(cfg.chain).toBe("arbitrum");
		expect(cfg.decimals).toBe(6);
	});

	it("returns USDT on Polygon", () => {
		const cfg = getTokenConfig("USDT", "polygon");
		expect(cfg.decimals).toBe(6);
	});

	it("throws on DAI:polygon (not supported)", () => {
		expect(() => getTokenConfig("DAI", "polygon")).toThrow("Unsupported token");
	});

	it("throws on unsupported chain", () => {
		// biome-ignore lint/suspicious/noExplicitAny: testing invalid input
		expect(() => getTokenConfig("USDC" as any, "solana" as any)).toThrow("Unsupported token");
	});
});

describe("tokenAmountFromCents", () => {
	it("converts 1000 cents ($10) to USDC raw amount (6 decimals)", () => {
		expect(tokenAmountFromCents(1000, 6)).toBe(10_000_000n);
	});

	it("converts 100 cents ($1) to DAI raw amount (18 decimals)", () => {
		expect(tokenAmountFromCents(100, 18)).toBe(1_000_000_000_000_000_000n);
	});

	it("converts 1 cent to USDC", () => {
		expect(tokenAmountFromCents(1, 6)).toBe(10_000n);
	});

	it("rejects non-integer cents", () => {
		expect(() => tokenAmountFromCents(10.5, 6)).toThrow("integer");
	});
});

describe("centsFromTokenAmount", () => {
	it("converts 10 USDC raw to 1000 cents", () => {
		expect(centsFromTokenAmount(10_000_000n, 6)).toBe(1000);
	});

	it("converts 1 DAI raw to 100 cents", () => {
		expect(centsFromTokenAmount(1_000_000_000_000_000_000n, 18)).toBe(100);
	});

	it("truncates fractional cents", () => {
		// 0.005 USDC = 5000 raw units = 0.5 cents -> truncates to 0
		expect(centsFromTokenAmount(5000n, 6)).toBe(0);
	});
});
