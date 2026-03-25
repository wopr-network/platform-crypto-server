import type { IWatcherCursorStore } from "../../stores/cursor-store.js";
import { centsFromTokenAmount } from "./config.js";
import type { EvmChain, EvmPaymentEvent, StablecoinToken } from "./types.js";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

type RpcCall = (method: string, params: unknown[]) => Promise<unknown>;

export interface EvmWatcherOpts {
	chain: EvmChain;
	token: StablecoinToken;
	rpcCall: RpcCall;
	fromBlock: number;
	onPayment: (event: EvmPaymentEvent) => void | Promise<void>;
	/** Active deposit addresses to watch. Filters eth_getLogs by topic[2] (to address). */
	watchedAddresses?: string[];
	cursorStore?: IWatcherCursorStore;
	/** Contract address for the ERC20 token (from DB). */
	contractAddress: string;
	/** Token decimals (from DB). */
	decimals: number;
	/** Required confirmations (from DB). */
	confirmations: number;
}

interface RpcLog {
	address: string;
	topics: string[];
	data: string;
	blockNumber: string;
	transactionHash: string;
	logIndex: string;
}

export class EvmWatcher {
	private _cursor: number;
	private readonly chain: EvmChain;
	private readonly token: StablecoinToken;
	private readonly rpc: RpcCall;
	private readonly onPayment: EvmWatcherOpts["onPayment"];
	private readonly confirmations: number;
	private readonly contractAddress: string;
	private readonly decimals: number;
	private readonly cursorStore?: IWatcherCursorStore;
	private readonly watcherId: string;
	private _watchedAddresses: string[];

	constructor(opts: EvmWatcherOpts) {
		this.chain = opts.chain;
		this.token = opts.token;
		this.rpc = opts.rpcCall;
		this._cursor = opts.fromBlock;
		this.onPayment = opts.onPayment;
		this.cursorStore = opts.cursorStore;
		this.watcherId = `evm:${opts.chain}:${opts.token}`;
		this._watchedAddresses = (opts.watchedAddresses ?? []).map((a) => a.toLowerCase());

		this.confirmations = opts.confirmations;
		this.contractAddress = opts.contractAddress.toLowerCase();
		this.decimals = opts.decimals;
	}

	/** Load cursor from DB. Call once at startup before first poll. */
	async init(): Promise<void> {
		if (!this.cursorStore) return;
		const saved = await this.cursorStore.get(this.watcherId);
		if (saved !== null) this._cursor = saved;
	}

	/** Update the set of watched deposit addresses (e.g. after a new checkout). */
	setWatchedAddresses(addresses: string[]): void {
		this._watchedAddresses = addresses.map((a) => a.toLowerCase());
	}

	get cursor(): number {
		return this._cursor;
	}

	/**
	 * Poll for Transfer events, including pending (unconfirmed) blocks.
	 *
	 * Two-phase scan:
	 *   1. Scan cursor..latest for new/updated txs, emit with current confirmation count
	 *   2. Re-check pending txs automatically since cursor doesn't advance past unconfirmed blocks
	 *
	 * Cursor only advances past fully-confirmed blocks.
	 */
	async poll(): Promise<void> {
		if (this._watchedAddresses.length === 0) return; // nothing to watch

		const latestHex = (await this.rpc("eth_blockNumber", [])) as string;
		const latest = Number.parseInt(latestHex, 16);
		const confirmed = latest - this.confirmations;

		if (latest < this._cursor) return;

		// Filter by topic[2] (to address) when watched addresses are set.
		const toFilter =
			this._watchedAddresses.length > 0
				? this._watchedAddresses.map((a) => `0x000000000000000000000000${a.slice(2)}`)
				: null;

		// Scan from cursor to latest (not just confirmed) to detect pending txs
		const logs = (await this.rpc("eth_getLogs", [
			{
				address: this.contractAddress,
				topics: [TRANSFER_TOPIC, null, toFilter],
				fromBlock: `0x${this._cursor.toString(16)}`,
				toBlock: `0x${latest.toString(16)}`,
			},
		])) as RpcLog[];

		// Group logs by block
		const logsByBlock = new Map<number, RpcLog[]>();
		for (const log of logs) {
			const bn = Number.parseInt(log.blockNumber, 16);
			const arr = logsByBlock.get(bn);
			if (arr) arr.push(log);
			else logsByBlock.set(bn, [log]);
		}

		// Process all blocks (including unconfirmed), emit with confirmation count
		const blockNums = [...logsByBlock.keys()].sort((a, b) => a - b);
		for (const blockNum of blockNums) {
			const confs = latest - blockNum;

			for (const log of logsByBlock.get(blockNum) ?? []) {
				const txKey = `${log.transactionHash}:${log.logIndex}`;

				// Skip if we already emitted at this confirmation count
				if (this.cursorStore) {
					const lastConf = await this.cursorStore.getConfirmationCount(this.watcherId, txKey);
					if (lastConf !== null && confs <= lastConf) continue;
				}

				const to = `0x${log.topics[2].slice(26)}`.toLowerCase();
				const from = `0x${log.topics[1].slice(26)}`.toLowerCase();
				const rawAmount = BigInt(log.data);
				const amountUsdCents = centsFromTokenAmount(rawAmount, this.decimals);

				const event: EvmPaymentEvent = {
					chain: this.chain,
					token: this.token,
					from,
					to,
					rawAmount: rawAmount.toString(),
					amountUsdCents,
					txHash: log.transactionHash,
					blockNumber: blockNum,
					logIndex: Number.parseInt(log.logIndex, 16),
					confirmations: confs,
					confirmationsRequired: this.confirmations,
				};

				await this.onPayment(event);

				// Track confirmation count
				if (this.cursorStore) {
					await this.cursorStore.saveConfirmationCount(this.watcherId, txKey, confs);
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

		// Advance cursor if no logs found but confirmed blocks exist
		if (blockNums.length === 0 && confirmed >= this._cursor) {
			this._cursor = confirmed + 1;
			if (this.cursorStore) {
				await this.cursorStore.save(this.watcherId, this._cursor);
			}
		}
	}
}

/** Create an RPC caller for a given URL (plain JSON-RPC over fetch). */
export function createRpcCaller(rpcUrl: string, extraHeaders?: Record<string, string>): RpcCall {
	let id = 0;
	const headers: Record<string, string> = { "Content-Type": "application/json", ...extraHeaders };
	return async (method: string, params: unknown[]): Promise<unknown> => {
		const res = await fetch(rpcUrl, {
			method: "POST",
			headers,
			body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
		});
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			const hasApiKey = "TRON-PRO-API-KEY" in headers;
			console.error(
				`[rpc] ${method} ${res.status} auth=${hasApiKey} url=${rpcUrl.replace(/apikey=[^&]+/, "apikey=***")} body=${body.slice(0, 200)}`,
			);
			throw new Error(`RPC ${method} failed: ${res.status}`);
		}
		const data = (await res.json()) as { result?: unknown; error?: { message: string } };
		if (data.error) throw new Error(`RPC ${method} error: ${data.error.message}`);
		return data.result;
	};
}
