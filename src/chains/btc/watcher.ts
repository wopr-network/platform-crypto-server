import { nativeToCents } from "../../oracle/convert.js";
import type { IPriceOracle } from "../../oracle/types.js";
import type { IWatcherCursorStore } from "../../stores/cursor-store.js";
import type { BitcoindConfig, BtcPaymentEvent } from "./types.js";

type RpcCall = (method: string, params: unknown[]) => Promise<unknown>;

export interface BtcWatcherOpts {
	config: BitcoindConfig;
	rpcCall: RpcCall;
	/** Addresses to watch (must be imported into bitcoind wallet first). */
	watchedAddresses: string[];
	onPayment: (event: BtcPaymentEvent) => void | Promise<void>;
	/** Price oracle for BTC/USD conversion. */
	oracle: IPriceOracle;
	/** Required — BTC has no block cursor, so txid dedup must be persisted. */
	cursorStore: IWatcherCursorStore;
	/** Override chain identity for cursor namespace (default: config.network). Prevents txid collisions across BTC/LTC/DOGE. */
	chainId?: string;
}

interface ReceivedByAddress {
	address: string;
	amount: number;
	confirmations: number;
	txids: string[];
}

export class BtcWatcher {
	private readonly rpc: RpcCall;
	private readonly addresses: Set<string>;
	private readonly onPayment: BtcWatcherOpts["onPayment"];
	private readonly minConfirmations: number;
	private readonly oracle: IPriceOracle;
	private readonly cursorStore: IWatcherCursorStore;
	private readonly watcherId: string;

	constructor(opts: BtcWatcherOpts) {
		this.rpc = opts.rpcCall;
		this.addresses = new Set(opts.watchedAddresses);
		this.onPayment = opts.onPayment;
		this.minConfirmations = opts.config.confirmations;
		this.oracle = opts.oracle;
		this.cursorStore = opts.cursorStore;
		this.watcherId = `btc:${opts.chainId ?? opts.config.network}`;
	}

	/** Update the set of watched addresses. */
	setWatchedAddresses(addresses: string[]): void {
		this.addresses.clear();
		for (const a of addresses) this.addresses.add(a);
	}

	/**
	 * Import an address into bitcoind's wallet (watch-only).
	 * Uses `importdescriptors` (modern bitcoind v24+) with fallback to legacy `importaddress`.
	 */
	async importAddress(address: string): Promise<void> {
		try {
			// Modern bitcoind: get descriptor checksum, then import
			const info = (await this.rpc("getdescriptorinfo", [`addr(${address})`])) as {
				descriptor: string;
			};
			const result = (await this.rpc("importdescriptors", [[{ desc: info.descriptor, timestamp: 0 }]])) as Array<{
				success: boolean;
				error?: { message: string };
			}>;
			if (result[0] && !result[0].success) {
				throw new Error(result[0].error?.message ?? "importdescriptors failed");
			}
		} catch {
			// Fallback: legacy importaddress (bitcoind <v24)
			await this.rpc("importaddress", [address, "", false]);
		}
		this.addresses.add(address);
	}

	/**
	 * Poll for payments to watched addresses, including unconfirmed txs.
	 *
	 * Fires onPayment on every confirmation increment (0, 1, 2, ... threshold).
	 * Only marks a tx as fully processed once it reaches the confirmation threshold.
	 */
	async poll(): Promise<void> {
		if (this.addresses.size === 0) return;

		// Poll with minconf=0 to see unconfirmed txs
		const received = (await this.rpc("listreceivedbyaddress", [
			0, // minconf=0: see ALL txs including unconfirmed
			false, // include_empty
			true, // include_watchonly
		])) as ReceivedByAddress[];

		const { priceMicros } = await this.oracle.getPrice("BTC");

		for (const entry of received) {
			if (!this.addresses.has(entry.address)) continue;

			for (const txid of entry.txids) {
				// Skip fully-processed txids (already reached threshold, persisted to DB)
				if (await this.cursorStore.hasProcessedTx(this.watcherId, txid)) continue;

				// Get transaction details for the exact amount sent to this address
				const tx = (await this.rpc("gettransaction", [txid, true])) as {
					details: Array<{ address: string; amount: number; category: string }>;
					confirmations: number;
				};

				const detail = tx.details.find((d) => d.address === entry.address && d.category === "receive");
				if (!detail) continue;

				// Check if confirmations have increased since last seen
				const lastSeen = await this.cursorStore.getConfirmationCount(this.watcherId, txid);
				if (lastSeen !== null && tx.confirmations <= lastSeen) continue; // No change

				const amountSats = Math.round(detail.amount * 100_000_000);
				// priceMicros is microdollars per 1 BTC. Convert sats→USD cents via nativeToCents.
				const amountUsdCents = nativeToCents(BigInt(amountSats), priceMicros, 8);

				const event: BtcPaymentEvent = {
					address: entry.address,
					txid,
					amountSats,
					amountUsdCents,
					confirmations: tx.confirmations,
					confirmationsRequired: this.minConfirmations,
				};

				await this.onPayment(event);

				// Persist confirmation count
				await this.cursorStore.saveConfirmationCount(this.watcherId, txid, tx.confirmations);

				// Mark as fully processed once we reach the threshold
				if (tx.confirmations >= this.minConfirmations) {
					await this.cursorStore.markProcessedTx(this.watcherId, txid);
				}
			}
		}
	}
}

/** Create a bitcoind JSON-RPC caller with basic auth. */
export function createBitcoindRpc(config: BitcoindConfig): RpcCall {
	let id = 0;
	const auth = btoa(`${config.rpcUser}:${config.rpcPassword}`);
	return async (method: string, params: unknown[]): Promise<unknown> => {
		const res = await fetch(config.rpcUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Basic ${auth}`,
			},
			body: JSON.stringify({ jsonrpc: "1.0", id: ++id, method, params }),
		});
		if (!res.ok) throw new Error(`bitcoind ${method} failed: ${res.status}`);
		const data = (await res.json()) as { result?: unknown; error?: { message: string } };
		if (data.error) throw new Error(`bitcoind ${method}: ${data.error.message}`);
		return data.result;
	};
}
