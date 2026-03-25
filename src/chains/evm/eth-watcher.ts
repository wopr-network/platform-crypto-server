import { nativeToCents } from "../../oracle/convert.js";
import type { IPriceOracle } from "../../oracle/types.js";
import type { IWatcherCursorStore } from "../../stores/cursor-store.js";
import type { EvmChain } from "./types.js";

type RpcCall = (method: string, params: unknown[]) => Promise<unknown>;

/** Event emitted on each confirmation increment for a native ETH deposit. */
export interface EthPaymentEvent {
	readonly chain: EvmChain;
	readonly from: string;
	readonly to: string;
	/** Raw value in wei (BigInt as string for serialization). */
	readonly valueWei: string;
	/** USD cents equivalent at detection time (integer). */
	readonly amountUsdCents: number;
	readonly txHash: string;
	readonly blockNumber: number;
	/** Current confirmation count (latest block - tx block). */
	readonly confirmations: number;
	/** Required confirmations for this chain. */
	readonly confirmationsRequired: number;
}

export interface EthWatcherOpts {
	chain: EvmChain;
	rpcCall: RpcCall;
	oracle: IPriceOracle;
	fromBlock: number;
	onPayment: (event: EthPaymentEvent) => void | Promise<void>;
	watchedAddresses?: string[];
	cursorStore?: IWatcherCursorStore;
	/** Required confirmations (from DB). */
	confirmations: number;
}

interface RpcTransaction {
	hash: string;
	from: string;
	to: string | null;
	value: string;
	blockNumber: string;
}

/**
 * Native ETH transfer watcher.
 *
 * Unlike the ERC-20 EvmWatcher which uses eth_getLogs for Transfer events,
 * this scans blocks for transactions where `to` matches a watched deposit
 * address and `value > 0`.
 *
 * Scans up to latest block (not just confirmed) to detect pending txs.
 * Emits events on each confirmation increment. Only advances cursor
 * past fully-confirmed blocks.
 */
export class EthWatcher {
	private _cursor: number;
	private readonly chain: EvmChain;
	private readonly rpc: RpcCall;
	private readonly oracle: IPriceOracle;
	private readonly onPayment: EthWatcherOpts["onPayment"];
	private readonly confirmations: number;
	private readonly cursorStore?: IWatcherCursorStore;
	private readonly watcherId: string;
	private _watchedAddresses: Set<string>;

	constructor(opts: EthWatcherOpts) {
		this.chain = opts.chain;
		this.rpc = opts.rpcCall;
		this.oracle = opts.oracle;
		this._cursor = opts.fromBlock;
		this.onPayment = opts.onPayment;
		this.confirmations = opts.confirmations;
		this.cursorStore = opts.cursorStore;
		this.watcherId = `eth:${opts.chain}`;
		this._watchedAddresses = new Set((opts.watchedAddresses ?? []).map((a) => a.toLowerCase()));
	}

	/** Load cursor from DB. Call once at startup before first poll. */
	async init(): Promise<void> {
		if (!this.cursorStore) return;
		const saved = await this.cursorStore.get(this.watcherId);
		if (saved !== null) this._cursor = saved;
	}

	setWatchedAddresses(addresses: string[]): void {
		this._watchedAddresses = new Set(addresses.map((a) => a.toLowerCase()));
	}

	get cursor(): number {
		return this._cursor;
	}

	/**
	 * Poll for native ETH transfers to watched addresses, including unconfirmed blocks.
	 *
	 * Scans from cursor to latest block. Emits events with current confirmation count.
	 * Re-emits on each confirmation increment. Only advances cursor past fully-confirmed blocks.
	 */
	async poll(): Promise<void> {
		if (this._watchedAddresses.size === 0) return;

		const latestHex = (await this.rpc("eth_blockNumber", [])) as string;
		const latest = Number.parseInt(latestHex, 16);
		const confirmed = latest - this.confirmations;

		if (latest < this._cursor) return;

		const { priceMicros } = await this.oracle.getPrice("ETH");

		// Scan up to latest (not just confirmed) to detect pending txs.
		// Fetch blocks in batches to avoid bursting RPC rate limits on fast chains (e.g. Tron 3s blocks).
		const BATCH_SIZE = 5;
		for (let batchStart = this._cursor; batchStart <= latest; batchStart += BATCH_SIZE) {
			const batchEnd = Math.min(batchStart + BATCH_SIZE - 1, latest);
			const blockNums = Array.from({ length: batchEnd - batchStart + 1 }, (_, i) => batchStart + i);

			const blocks = await Promise.all(
				blockNums.map((bn) =>
					this.rpc("eth_getBlockByNumber", [`0x${bn.toString(16)}`, true]).then(
						(b) => ({ blockNum: bn, block: b as { transactions: RpcTransaction[] } | null, error: null }),
						(err: unknown) => ({ blockNum: bn, block: null, error: err }),
					),
				),
			);

			// Stop processing at the first failed block so the cursor doesn't advance past it.
			const firstFailIdx = blocks.findIndex((b) => b.error !== null || !b.block);
			const safeBlocks = firstFailIdx === -1 ? blocks : blocks.slice(0, firstFailIdx);
			for (const { blockNum, block } of safeBlocks) {
				if (!block) break;

				const confs = latest - blockNum;

				for (const tx of block.transactions) {
					if (!tx.to) continue;
					const to = tx.to.toLowerCase();
					if (!this._watchedAddresses.has(to)) continue;

					const valueWei = BigInt(tx.value);
					if (valueWei === 0n) continue;

					// Skip if we already emitted at this confirmation count
					if (this.cursorStore) {
						const lastConf = await this.cursorStore.getConfirmationCount(this.watcherId, tx.hash);
						if (lastConf !== null && confs <= lastConf) continue;
					}

					const amountUsdCents = nativeToCents(valueWei, priceMicros, 18);

					const event: EthPaymentEvent = {
						chain: this.chain,
						from: tx.from.toLowerCase(),
						to,
						valueWei: valueWei.toString(),
						amountUsdCents,
						txHash: tx.hash,
						blockNumber: blockNum,
						confirmations: confs,
						confirmationsRequired: this.confirmations,
					};

					await this.onPayment(event);

					if (this.cursorStore) {
						await this.cursorStore.saveConfirmationCount(this.watcherId, tx.hash, confs);
					}
				}

				// Only advance cursor past fully-confirmed blocks
				if (blockNum <= confirmed) {
					this._cursor = blockNum + 1;
					if (this.cursorStore) {
						await this.cursorStore.save(this.watcherId, this._cursor);
					}
				}
			}

			if (firstFailIdx !== -1) break;
		}
	}
}
