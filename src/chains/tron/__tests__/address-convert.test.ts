import { describe, expect, it } from "vitest";
import { hexToTron, isTronAddress, tronToHex } from "../address-convert.js";

// Known Tron address / hex pair (Tron foundation address)
const TRON_ADDR = "TJCnKsPa7y5okkXvQAidZBzqx3QyQ6sxMW";
const HEX_ADDR = "0x5a523b449890854c8fc460ab602df9f31fe4293f";

describe("tronToHex", () => {
	it("converts T... to 0x hex", () => {
		const hex = tronToHex(TRON_ADDR);
		expect(hex).toBe(HEX_ADDR);
	});

	it("rejects non-Tron address", () => {
		expect(() => tronToHex("0x1234")).toThrow("Not a Tron address");
	});

	it("rejects invalid checksum", () => {
		// Flip last character
		const bad = `${TRON_ADDR.slice(0, -1)}X`;
		expect(() => tronToHex(bad)).toThrow();
	});
});

describe("hexToTron", () => {
	it("converts 0x hex to T...", () => {
		const tron = hexToTron(HEX_ADDR);
		expect(tron).toBe(TRON_ADDR);
	});

	it("handles hex without 0x prefix", () => {
		const tron = hexToTron(HEX_ADDR.slice(2));
		expect(tron).toBe(TRON_ADDR);
	});

	it("rejects wrong length", () => {
		expect(() => hexToTron("0x1234")).toThrow("Invalid hex address length");
	});
});

describe("roundtrip", () => {
	it("tronToHex → hexToTron is identity", () => {
		const hex = tronToHex(TRON_ADDR);
		const back = hexToTron(hex);
		expect(back).toBe(TRON_ADDR);
	});

	it("hexToTron → tronToHex is identity", () => {
		const tron = hexToTron(HEX_ADDR);
		const back = tronToHex(tron);
		expect(back).toBe(HEX_ADDR);
	});
});

describe("isTronAddress", () => {
	it("returns true for T... address", () => {
		expect(isTronAddress(TRON_ADDR)).toBe(true);
	});

	it("returns false for 0x address", () => {
		expect(isTronAddress(HEX_ADDR)).toBe(false);
	});

	it("returns false for BTC address", () => {
		expect(isTronAddress("bc1qtest")).toBe(false);
	});
});
