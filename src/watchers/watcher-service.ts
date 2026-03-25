/**
 * Watcher Service — boots chain watchers and sends webhook callbacks.
 *
 * Payment flow:
 *   1. Watcher detects payment → handlePayment()
 *   2. Accumulate native amount (supports partial payments)
 *   3. When totalReceived >= expectedAmount AND confirmations >= required → confirmed + credit
 *   4. Every payment/confirmation change enqueues a webhook delivery
 *   5. Outbox processor retries failed deliveries with exponential backoff
 *
 * Amount comparison is ALWAYS in native crypto units (sats, wei, token base units).
 * The exchange rate is locked at charge creation — no live price comparison.
 */

import { and, eq, isNull, lte, or } from "drizzle-orm";
import type { BtcPaymentEvent } from "../chains/btc/types.js";
import { BtcWatcher, createBitcoindRpc } from "../chains/btc/watcher.js";
import type { EthPaymentEvent } from "../chains/evm/eth-watcher.js";
import { EthWatcher } from "../chains/evm/eth-watcher.js";
import type { EvmChain, EvmPaymentEvent, StablecoinToken } from "../chains/evm/types.js";
import { createRpcCaller, EvmWatcher } from "../chains/evm/watcher.js";
import { hexToTron, isTronAddress, tronToHex } from "../chains/tron/address-convert.js";
import type { CryptoDb } from "../db/index.js";
import { cryptoCharges, webhookDeliveries } from "../db/schema.js";
import type { IPriceOracle } from "../oracle/types.js";
import type { ICryptoChargeRepository } from "../stores/charge-store.js";
import type { IWatcherCursorStore } from "../stores/cursor-store.js";
import type { IPaymentMethodStore } from "../stores/payment-method-store.js";
import type { CryptoChargeStatus } from "../types.js";

const MAX_DELIVERY_ATTEMPTS = 10;
const BACKOFF_BASE_MS = 5_000;

export interface WatcherServiceOpts {
	db: CryptoDb;
	chargeStore: ICryptoChargeRepository;
	methodStore: IPaymentMethodStore;
	cursorStore: IWatcherCursorStore;
	oracle: IPriceOracle;
	bitcoindUser?: string;
	bitcoindPassword?: string;
	pollIntervalMs?: number;
	deliveryIntervalMs?: number;
	log?: (msg: string, meta?: Record<string, unknown>) => void;
	/** Allowed callback URL prefixes. Default: ["https://"] — enforces HTTPS. */
	allowedCallbackPrefixes?: string[];
	/** Service key sent as Bearer token in webhook deliveries. */
	serviceKey?: string;
}

// --- SSRF validation ---

function isValidCallbackUrl(url: string, allowedPrefixes: string[]): boolean {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
		const host = parsed.hostname;
		if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1") return false;
		if (host.startsWith("10.") || host.startsWith("192.168.") || host.startsWith("169.254.")) return false;
		return allowedPrefixes.some((prefix) => url.startsWith(prefix));
	} catch {
		return false;
	}
}

// --- Webhook outbox ---

async function enqueueWebhook(
	db: CryptoDb,
	chargeId: string,
	callbackUrl: string,
	payload: Record<string, unknown>,
): Promise<void> {
	await db.insert(webhookDeliveries).values({
		chargeId,
		callbackUrl,
		payload: JSON.stringify(payload),
	});
}

async function processDeliveries(
	db: CryptoDb,
	allowedPrefixes: string[],
	log: (msg: string, meta?: Record<string, unknown>) => void,
	serviceKey?: string,
): Promise<number> {
	const now = new Date().toISOString();
	const pending = await db
		.select()
		.from(webhookDeliveries)
		.where(
			and(
				eq(webhookDeliveries.status, "pending"),
				or(isNull(webhookDeliveries.nextRetryAt), lte(webhookDeliveries.nextRetryAt, now)),
			),
		)
		.limit(50);

	let delivered = 0;
	for (const row of pending) {
		if (!isValidCallbackUrl(row.callbackUrl, allowedPrefixes)) {
			await db
				.update(webhookDeliveries)
				.set({ status: "failed", lastError: "Invalid callbackUrl (SSRF blocked)" })
				.where(eq(webhookDeliveries.id, row.id));
			continue;
		}

		try {
			const headers: Record<string, string> = { "Content-Type": "application/json" };
			if (serviceKey) headers.Authorization = `Bearer ${serviceKey}`;
			const res = await fetch(row.callbackUrl, {
				method: "POST",
				headers,
				body: row.payload,
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);

			await db.update(webhookDeliveries).set({ status: "delivered" }).where(eq(webhookDeliveries.id, row.id));
			delivered++;
		} catch (err) {
			const attempts = row.attempts + 1;
			if (attempts >= MAX_DELIVERY_ATTEMPTS) {
				await db
					.update(webhookDeliveries)
					.set({ status: "failed", attempts, lastError: String(err) })
					.where(eq(webhookDeliveries.id, row.id));
				log("Webhook permanently failed", { chargeId: row.chargeId, attempts });
			} else {
				const backoffMs = BACKOFF_BASE_MS * 2 ** (attempts - 1);
				const nextRetry = new Date(Date.now() + backoffMs).toISOString();
				await db
					.update(webhookDeliveries)
					.set({ attempts, nextRetryAt: nextRetry, lastError: String(err) })
					.where(eq(webhookDeliveries.id, row.id));
			}
		}
	}
	return delivered;
}

// --- Payment handling (partial + full + confirmation tracking) ---

export interface PaymentPayload {
	txHash: string;
	confirmations: number;
	confirmationsRequired: number;
	amountReceivedCents: number;
	[key: string]: unknown;
}

/**
 * Handle a payment event. Accumulates partial payments in native units.
 * Fires webhook on every payment/confirmation change with canonical statuses.
 *
 * 3-phase webhook lifecycle:
 *   1. Tx first seen -> status: "partial", confirmations: 0
 *   2. Each new block -> status: "partial", confirmations: current
 *   3. Threshold reached + full payment -> status: "confirmed"
 *
 * @param nativeAmount — received amount in native base units (sats for BTC/DOGE, raw token units for ERC20).
 *                        Pass "0" for confirmation-only updates (no new payment, just more confirmations).
 */
export async function handlePayment(
	db: CryptoDb,
	chargeStore: ICryptoChargeRepository,
	address: string,
	nativeAmount: string,
	payload: PaymentPayload,
	log: (msg: string, meta?: Record<string, unknown>) => void,
): Promise<void> {
	const charge = await chargeStore.getByDepositAddress(address);
	if (!charge) {
		log("Payment to unknown address", { address });
		return;
	}
	if (charge.creditedAt) {
		return; // Already fully paid and credited
	}

	const { confirmations, confirmationsRequired, amountReceivedCents, txHash } = payload;

	// Accumulate: add this payment to the running total (if nativeAmount > 0)
	const prevReceived = BigInt(charge.receivedAmount ?? "0");
	const thisPayment = BigInt(nativeAmount);
	const totalReceived = (prevReceived + thisPayment).toString();
	const expected = BigInt(charge.expectedAmount ?? "0");
	const isFull = expected > 0n && BigInt(totalReceived) >= expected;
	const isConfirmed = isFull && confirmations >= confirmationsRequired;

	// Update received_amount in DB (only when there's a new payment)
	if (thisPayment > 0n) {
		await db
			.update(cryptoCharges)
			.set({ receivedAmount: totalReceived, filledAmount: totalReceived })
			.where(eq(cryptoCharges.referenceId, charge.referenceId));
	}

	// Determine canonical status
	const status: CryptoChargeStatus = isConfirmed ? "confirmed" : "partial";

	// Update progress via new API
	await chargeStore.updateProgress(charge.referenceId, {
		status,
		amountReceivedCents,
		confirmations,
		confirmationsRequired,
		txHash,
	});

	if (isConfirmed) {
		await chargeStore.markCredited(charge.referenceId);
		log("Charge confirmed", {
			chargeId: charge.referenceId,
			confirmations,
			confirmationsRequired,
		});
	} else {
		log("Payment progress", {
			chargeId: charge.referenceId,
			confirmations,
			confirmationsRequired,
			received: totalReceived,
		});
	}

	// Webhook on every event — product shows confirmation progress to user
	if (charge.callbackUrl) {
		await enqueueWebhook(db, charge.referenceId, charge.callbackUrl, {
			chargeId: charge.referenceId,
			chain: charge.chain,
			address: charge.depositAddress,
			amountExpectedCents: charge.amountUsdCents,
			amountReceivedCents,
			confirmations,
			confirmationsRequired,
			txHash,
			status,
		});
	}
}

// --- Watcher boot ---

export async function startWatchers(opts: WatcherServiceOpts): Promise<() => void> {
	const { db, chargeStore, methodStore, cursorStore, oracle } = opts;
	const pollMs = opts.pollIntervalMs ?? 15_000;
	const deliveryMs = opts.deliveryIntervalMs ?? 10_000;
	const log = opts.log ?? (() => {});
	const allowedPrefixes = opts.allowedCallbackPrefixes ?? ["https://"];
	const serviceKey = opts.serviceKey;
	const timers: ReturnType<typeof setInterval>[] = [];

	const methods = await methodStore.listEnabled();

	// Route watchers by DB-driven watcherType — no hardcoded chain names.
	// Adding a new chain is a DB INSERT with watcher_type = "utxo" or "evm".
	const utxoMethods = methods.filter((m) => m.watcherType === "utxo");
	const evmMethods = methods.filter((m) => m.watcherType === "evm");

	// --- UTXO Watchers (BTC, LTC, DOGE) ---
	for (const method of utxoMethods) {
		if (!method.rpcUrl) continue;

		const rpcCall = createBitcoindRpc({
			rpcUrl: method.rpcUrl,
			rpcUser: opts.bitcoindUser ?? "btcpay",
			rpcPassword: opts.bitcoindPassword ?? "",
			network: "mainnet",
			confirmations: method.confirmations,
		});

		const activeAddresses = await chargeStore.listActiveDepositAddresses();
		const chainAddresses = activeAddresses.filter((a) => a.chain === method.chain).map((a) => a.address);

		const watcher = new BtcWatcher({
			config: {
				rpcUrl: method.rpcUrl,
				rpcUser: opts.bitcoindUser ?? "btcpay",
				rpcPassword: opts.bitcoindPassword ?? "",
				network: "mainnet",
				confirmations: method.confirmations,
			},
			chainId: method.chain,
			rpcCall,
			watchedAddresses: chainAddresses,
			oracle,
			cursorStore,
			onPayment: async (event: BtcPaymentEvent) => {
				log("UTXO payment", {
					chain: method.chain,
					address: event.address,
					txid: event.txid,
					sats: event.amountSats,
					confirmations: event.confirmations,
					confirmationsRequired: event.confirmationsRequired,
				});
				await handlePayment(
					db,
					chargeStore,
					event.address,
					String(event.amountSats),
					{
						txHash: event.txid,
						confirmations: event.confirmations,
						confirmationsRequired: event.confirmationsRequired,
						amountReceivedCents: event.amountUsdCents,
					},
					log,
				);
			},
		});

		const importedAddresses = new Set<string>();
		for (const addr of chainAddresses) {
			try {
				await watcher.importAddress(addr);
				importedAddresses.add(addr);
			} catch {
				log("Failed to import address", { chain: method.chain, address: addr });
			}
		}

		log(`UTXO watcher started (${method.chain})`, { addresses: importedAddresses.size });

		let utxoPolling = false;
		timers.push(
			setInterval(async () => {
				if (utxoPolling) return; // Prevent overlapping polls
				utxoPolling = true;
				try {
					const fresh = await chargeStore.listActiveDepositAddresses();
					const freshChain = fresh.filter((a) => a.chain === method.chain).map((a) => a.address);

					for (const addr of freshChain) {
						if (!importedAddresses.has(addr)) {
							try {
								await watcher.importAddress(addr);
								importedAddresses.add(addr);
							} catch {
								log("Failed to import new address (will retry)", { chain: method.chain, address: addr });
							}
						}
					}

					watcher.setWatchedAddresses(freshChain);
					await watcher.poll();
				} catch (err) {
					log("UTXO poll error", { chain: method.chain, error: String(err) });
				} finally {
					utxoPolling = false;
				}
			}, pollMs),
		);
	}

	// --- Native ETH Watchers (block-scanning for value transfers) ---
	const nativeEvmMethods = evmMethods.filter((m) => m.type === "native");
	const erc20Methods = evmMethods.filter((m) => m.type === "erc20" && m.contractAddress);

	const BACKFILL_BLOCKS = 1000; // Scan ~30min of blocks on first deploy to catch missed deposits

	// Address conversion for EVM-watched chains with non-0x address formats (Tron T...).
	// Only applies to chains routed through the EVM watcher but storing non-hex addresses.
	// UTXO chains (DOGE p2pkh) never enter this path — they use the UTXO watcher.
	const isTronMethod = (method: { addressType: string; chain: string }): boolean =>
		(method.addressType === "p2pkh" || method.addressType === "keccak-b58check") && method.chain === "tron";
	const toWatcherAddr = (addr: string, method: { addressType: string; chain: string }): string =>
		isTronMethod(method) && isTronAddress(addr) ? tronToHex(addr) : addr;
	const fromWatcherAddr = (addr: string, method: { addressType: string; chain: string }): string =>
		isTronMethod(method) ? hexToTron(addr) : addr;

	for (const method of nativeEvmMethods) {
		if (!method.rpcUrl) continue;

		const rpcCall = createRpcCaller(method.rpcUrl, JSON.parse(method.rpcHeaders ?? "{}"));
		let latestBlock: number;
		try {
			const latestHex = (await rpcCall("eth_blockNumber", [])) as string;
			latestBlock = Number.parseInt(latestHex, 16);
		} catch (err) {
			log("Skipping ETH watcher — RPC unreachable", { chain: method.chain, token: method.token, error: String(err) });
			continue;
		}
		const backfillStart = Math.max(0, latestBlock - BACKFILL_BLOCKS);

		const activeAddresses = await chargeStore.listActiveDepositAddresses();
		// Only watch addresses for native charges on this chain (not ERC20 charges)
		const chainAddresses = activeAddresses
			.filter((a) => a.chain === method.chain && a.token === method.token)
			.map((a) => a.address);

		const watcher = new EthWatcher({
			chain: method.chain as EvmChain,
			rpcCall,
			oracle,
			fromBlock: backfillStart,
			watchedAddresses: chainAddresses.map((a) => toWatcherAddr(a, method)),
			cursorStore,
			confirmations: method.confirmations,
			onPayment: async (event: EthPaymentEvent) => {
				const dbAddr = fromWatcherAddr(event.to, method);
				log("ETH payment", {
					chain: event.chain,
					to: dbAddr,
					txHash: event.txHash,
					valueWei: event.valueWei,
					confirmations: event.confirmations,
					confirmationsRequired: event.confirmationsRequired,
				});
				await handlePayment(
					db,
					chargeStore,
					dbAddr,
					event.valueWei,
					{
						txHash: event.txHash,
						confirmations: event.confirmations,
						confirmationsRequired: event.confirmationsRequired,
						amountReceivedCents: event.amountUsdCents,
					},
					log,
				);
			},
		});

		await watcher.init();
		log(`ETH watcher started (${method.chain}:${method.token})`, { addresses: chainAddresses.length });

		let ethPolling = false;
		timers.push(
			setInterval(async () => {
				if (ethPolling) return;
				ethPolling = true;
				try {
					const fresh = await chargeStore.listActiveDepositAddresses();
					const freshNative = fresh
						.filter((a) => a.chain === method.chain && a.token === method.token)
						.map((a) => a.address);
					watcher.setWatchedAddresses(freshNative.map((a) => toWatcherAddr(a, method)));
					await watcher.poll();
				} catch (err) {
					log("ETH poll error", { chain: method.chain, error: String(err) });
				} finally {
					ethPolling = false;
				}
			}, pollMs),
		);
	}

	// --- ERC20 Watchers (log-based Transfer event scanning) ---
	for (const method of erc20Methods) {
		if (!method.rpcUrl || !method.contractAddress) continue;

		const rpcCall = createRpcCaller(method.rpcUrl, JSON.parse(method.rpcHeaders ?? "{}"));
		let latestBlock: number;
		try {
			const latestHex = (await rpcCall("eth_blockNumber", [])) as string;
			latestBlock = Number.parseInt(latestHex, 16);
		} catch (err) {
			log("Skipping EVM watcher — RPC unreachable", { chain: method.chain, token: method.token, error: String(err) });
			continue;
		}

		const activeAddresses = await chargeStore.listActiveDepositAddresses();
		const chainAddresses = activeAddresses.filter((a) => a.chain === method.chain).map((a) => a.address);

		const watcher = new EvmWatcher({
			chain: method.chain as EvmChain,
			token: method.token as StablecoinToken,
			rpcCall,
			fromBlock: latestBlock,
			watchedAddresses: chainAddresses.map((a) => toWatcherAddr(a, method)),
			contractAddress: toWatcherAddr(method.contractAddress, method),
			decimals: method.decimals,
			confirmations: method.confirmations,
			cursorStore,
			onPayment: async (event: EvmPaymentEvent) => {
				const dbAddr = fromWatcherAddr(event.to, method);
				log("EVM payment", {
					chain: event.chain,
					token: event.token,
					to: dbAddr,
					txHash: event.txHash,
					confirmations: event.confirmations,
					confirmationsRequired: event.confirmationsRequired,
				});
				await handlePayment(
					db,
					chargeStore,
					dbAddr,
					event.rawAmount,
					{
						txHash: event.txHash,
						confirmations: event.confirmations,
						confirmationsRequired: event.confirmationsRequired,
						amountReceivedCents: event.amountUsdCents,
					},
					log,
				);
			},
		});

		await watcher.init();
		log(`EVM watcher started (${method.chain}:${method.token})`, { addresses: chainAddresses.length });

		let evmPolling = false;
		timers.push(
			setInterval(async () => {
				if (evmPolling) return;
				evmPolling = true;
				try {
					const fresh = await chargeStore.listActiveDepositAddresses();
					const freshChain = fresh.filter((a) => a.chain === method.chain).map((a) => a.address);
					watcher.setWatchedAddresses(freshChain.map((a) => toWatcherAddr(a, method)));
					await watcher.poll();
				} catch (err) {
					log("EVM poll error", { chain: method.chain, token: method.token, error: String(err) });
				} finally {
					evmPolling = false;
				}
			}, pollMs),
		);
	}

	// --- Webhook delivery outbox processor ---
	timers.push(
		setInterval(async () => {
			try {
				const count = await processDeliveries(db, allowedPrefixes, log, serviceKey);
				if (count > 0) log("Webhooks delivered", { count });
			} catch (err) {
				log("Delivery loop error", { error: String(err) });
			}
		}, deliveryMs),
	);

	log("All watchers started", {
		utxo: utxoMethods.length,
		evm: erc20Methods.length,
		eth: nativeEvmMethods.length,
		pollMs,
		deliveryMs,
	});

	return () => {
		for (const t of timers) clearInterval(t);
	};
}
