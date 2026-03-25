// src/billing/crypto/plugin/__tests__/interfaces.test.ts
import { describe, expect, it } from "vitest";
import type { EncodingParams, IAddressEncoder, IChainWatcher, ICurveDeriver, PaymentEvent } from "../interfaces.js";

describe("plugin interfaces — type contracts", () => {
	it("PaymentEvent has required fields", () => {
		const event: PaymentEvent = {
			chain: "ethereum",
			token: "ETH",
			from: "0xabc",
			to: "0xdef",
			rawAmount: "1000000000000000000",
			amountUsdCents: 350000,
			txHash: "0x123",
			blockNumber: 100,
			confirmations: 6,
			confirmationsRequired: 6,
		};
		expect(event.chain).toBe("ethereum");
		expect(event.amountUsdCents).toBe(350000);
	});

	it("ICurveDeriver contract is satisfiable", () => {
		const deriver: ICurveDeriver = {
			derivePublicKey: (_chain: number, _index: number) => new Uint8Array(33),
			getCurve: () => "secp256k1",
		};
		expect(deriver.getCurve()).toBe("secp256k1");
		expect(deriver.derivePublicKey(0, 0)).toBeInstanceOf(Uint8Array);
	});

	it("IAddressEncoder contract is satisfiable", () => {
		const encoder: IAddressEncoder = {
			encode: (_pk: Uint8Array, _params: EncodingParams) => "bc1qtest",
			encodingType: () => "bech32",
		};
		expect(encoder.encodingType()).toBe("bech32");
		expect(encoder.encode(new Uint8Array(33), { hrp: "bc" })).toBe("bc1qtest");
	});

	it("IChainWatcher contract is satisfiable", () => {
		const watcher: IChainWatcher = {
			init: async () => {},
			poll: async () => [],
			setWatchedAddresses: () => {},
			getCursor: () => 0,
			stop: () => {},
		};
		expect(watcher.getCursor()).toBe(0);
	});
});
