/**
 * Plugin-driven watcher service — replaces the hardcoded watcher-service.ts.
 *
 * Instead of importing BtcWatcher/EvmWatcher/EthWatcher directly,
 * this delegates to IChainPlugin.createWatcher() from the plugin registry.
 * Adding a new chain = register a plugin + INSERT a payment_methods row.
 *
 * Payment flow is unchanged:
 *   plugin.poll() -> PaymentEvent[] -> handlePayment() -> credit + webhook
 */

import type { CryptoDb } from "../db/index.js";
import type { IPriceOracle } from "../oracle/types.js";
import type { IChainPlugin, IChainWatcher } from "../plugin/interfaces.js";
import type { PluginRegistry } from "../plugin/registry.js";
import type { ICryptoChargeRepository } from "../stores/charge-store.js";
import type { IWatcherCursorStore } from "../stores/cursor-store.js";
import type { IPaymentMethodStore, PaymentMethodRecord } from "../stores/payment-method-store.js";
import { handlePayment } from "./watcher-service.js";

export interface PluginWatcherServiceOpts {
	db: CryptoDb;
	chargeStore: ICryptoChargeRepository;
	methodStore: IPaymentMethodStore;
	cursorStore: IWatcherCursorStore;
	oracle: IPriceOracle;
	registry: PluginRegistry;
	pollIntervalMs?: number;
	log?: (msg: string, meta?: Record<string, unknown>) => void;
}

/** Map legacy watcher_type values to plugin IDs for backward compatibility. */
const WATCHER_TYPE_TO_PLUGIN: Record<string, string> = {
	utxo: "bitcoin",
	evm: "evm",
};

function resolvePlugin(registry: PluginRegistry, method: PaymentMethodRecord): IChainPlugin | undefined {
	// Prefer explicit plugin_id, fall back to watcher_type mapping
	const id = method.pluginId ?? WATCHER_TYPE_TO_PLUGIN[method.watcherType];
	return id ? registry.get(id) : undefined;
}

/**
 * Boot plugin-driven watchers for all enabled payment methods.
 *
 * Returns a cleanup function that stops all poll timers and watchers.
 */
export async function startPluginWatchers(opts: PluginWatcherServiceOpts): Promise<() => void> {
	const { db, chargeStore, methodStore, cursorStore, oracle, registry } = opts;
	const pollMs = opts.pollIntervalMs ?? 15_000;
	const log = opts.log ?? (() => {});

	const methods = await methodStore.listEnabled();
	const timers: ReturnType<typeof setInterval>[] = [];
	const watchers: IChainWatcher[] = [];

	for (const method of methods) {
		if (!method.rpcUrl) continue;

		const plugin = resolvePlugin(registry, method);
		if (!plugin) {
			log("No plugin found, skipping method", { id: method.id, chain: method.chain, watcherType: method.watcherType });
			continue;
		}

		const watcher = plugin.createWatcher({
			rpcUrl: method.rpcUrl,
			rpcHeaders: JSON.parse(method.rpcHeaders ?? "{}"),
			oracle,
			cursorStore,
			token: method.token,
			chain: method.chain,
			contractAddress: method.contractAddress ?? undefined,
			decimals: method.decimals,
			confirmations: method.confirmations,
		});

		try {
			await watcher.init();
		} catch (err) {
			log("Watcher init failed, skipping", { chain: method.chain, token: method.token, error: String(err) });
			continue;
		}

		// Seed watched addresses from active charges
		const active = await chargeStore.listActiveDepositAddresses();
		const addrs = active.filter((a) => a.chain === method.chain && a.token === method.token).map((a) => a.address);
		watcher.setWatchedAddresses(addrs);

		watchers.push(watcher);
		log(`Plugin watcher started (${method.chain}:${method.token})`, {
			plugin: plugin.pluginId,
			addresses: addrs.length,
		});

		let polling = false;
		timers.push(
			setInterval(async () => {
				if (polling) return;
				polling = true;
				try {
					// Refresh watched addresses each cycle
					const fresh = await chargeStore.listActiveDepositAddresses();
					const freshAddrs = fresh
						.filter((a) => a.chain === method.chain && a.token === method.token)
						.map((a) => a.address);
					watcher.setWatchedAddresses(freshAddrs);

					const events = await watcher.poll();
					for (const ev of events) {
						log("Plugin payment", {
							chain: ev.chain,
							token: ev.token,
							to: ev.to,
							txHash: ev.txHash,
							confirmations: ev.confirmations,
						});
						await handlePayment(
							db,
							chargeStore,
							ev.to,
							ev.rawAmount,
							{
								txHash: ev.txHash,
								confirmations: ev.confirmations,
								confirmationsRequired: ev.confirmationsRequired,
								amountReceivedCents: ev.amountUsdCents,
							},
							log,
						);
					}
				} catch (err) {
					log("Plugin poll error", { chain: method.chain, token: method.token, error: String(err) });
				} finally {
					polling = false;
				}
			}, pollMs),
		);
	}

	log("All plugin watchers started", { count: watchers.length, pollMs });

	return () => {
		for (const t of timers) clearInterval(t);
		for (const w of watchers) w.stop();
	};
}
