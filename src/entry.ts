/**
 * Standalone entry point for the crypto key server.
 *
 * Deploys on the chain server (pay.wopr.bot:3100).
 * Boots: postgres → migrations → key server routes → watchers → serve.
 *
 * Usage: node dist/entry.js
 */
/* biome-ignore-all lint/suspicious/noConsole: standalone entry point */
import { serve } from "@hono/node-server";
import {
	bitcoinPlugin,
	dogecoinPlugin,
	evmPlugin,
	litecoinPlugin,
	solanaPlugin,
	tronPlugin,
} from "@wopr-network/crypto-plugins";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { createRpcCaller } from "./chains/evm/watcher.js";
import { createDb } from "./db/index.js";
import { ChainlinkOracle } from "./oracle/chainlink.js";
import { CoinGeckoOracle } from "./oracle/coingecko.js";
import { CompositeOracle } from "./oracle/composite.js";
import { FixedPriceOracle } from "./oracle/fixed.js";
import { PluginRegistry } from "./plugin/registry.js";
import { createKeyServerApp } from "./server.js";
import { DrizzleCryptoChargeRepository } from "./stores/charge-store.js";
import { DrizzleWatcherCursorStore } from "./stores/cursor-store.js";
import { DrizzlePaymentMethodStore } from "./stores/payment-method-store.js";
import { startPluginWatchers } from "./watchers/plugin-watcher-service.js";
import { startWatchers } from "./watchers/watcher-service.js";

const PORT = Number(process.env.PORT ?? "3100");
const DATABASE_URL = process.env.DATABASE_URL;
const SERVICE_KEY = process.env.SERVICE_KEY;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const BITCOIND_USER = process.env.BITCOIND_USER ?? "btcpay";
const BITCOIND_PASSWORD = process.env.BITCOIND_PASSWORD ?? "";
const BASE_RPC_URL = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";

if (!DATABASE_URL) {
	console.error("DATABASE_URL is required");
	process.exit(1);
}

async function main(): Promise<void> {
	const pool = new pg.Pool({ connectionString: DATABASE_URL });

	// Run migrations FIRST, before creating schema-typed db
	console.log("[crypto-key-server] Running migrations...");
	await migrate(drizzle(pool), { migrationsFolder: "./drizzle/migrations" });

	// Now create the schema-typed db (columns guaranteed to exist)
	console.log("[crypto-key-server] Connecting...");
	const db = createDb(pool);

	const chargeStore = new DrizzleCryptoChargeRepository(db);
	const methodStore = new DrizzlePaymentMethodStore(db);

	// Composite oracle: Chainlink on-chain (BTC, ETH on Base) + CoinGecko fallback (DOGE, LTC, etc.)
	// Every volatile asset needs reliable USD pricing — the ledger credits nanodollars.
	const chainlink = BASE_RPC_URL
		? new ChainlinkOracle({ rpcCall: createRpcCaller(BASE_RPC_URL) })
		: new FixedPriceOracle();
	// Build token→CoinGecko ID map from DB (zero-deploy chain additions)
	const allMethods = await methodStore.listAll();
	const dbTokenIds: Record<string, string> = {};
	for (const m of allMethods) {
		if (m.oracleAssetId) dbTokenIds[m.token] = m.oracleAssetId;
	}
	const coingecko = new CoinGeckoOracle({ tokenIds: dbTokenIds });
	const oracle = new CompositeOracle(chainlink, coingecko);

	// Build plugin registry — one plugin per chain family
	const registry = new PluginRegistry();
	registry.register(bitcoinPlugin);
	registry.register(litecoinPlugin);
	registry.register(dogecoinPlugin);
	registry.register(evmPlugin);
	registry.register(tronPlugin);
	registry.register(solanaPlugin);
	console.log(
		`[crypto-key-server] Registered ${registry.list().length} chain plugins:`,
		registry.list().map((p) => p.pluginId),
	);

	const app = createKeyServerApp({
		db,
		chargeStore,
		methodStore,
		oracle,
		serviceKey: SERVICE_KEY,
		adminToken: ADMIN_TOKEN,
		registry,
	});

	// Boot plugin-driven watchers — polls for payments, sends webhooks.
	// Falls back to legacy startWatchers() if USE_LEGACY_WATCHERS=1 is set.
	const cursorStore = new DrizzleWatcherCursorStore(db);
	const useLegacy = process.env.USE_LEGACY_WATCHERS === "1";
	const stopWatchers = useLegacy
		? await startWatchers({
				db,
				chargeStore,
				methodStore,
				cursorStore,
				oracle,
				bitcoindUser: BITCOIND_USER,
				bitcoindPassword: BITCOIND_PASSWORD,
				serviceKey: SERVICE_KEY,
				log: (msg, meta) => console.log(`[watcher] ${msg}`, meta ?? ""),
			})
		: await startPluginWatchers({
				db,
				chargeStore,
				methodStore,
				cursorStore,
				oracle,
				registry,
				log: (msg, meta) => console.log(`[watcher] ${msg}`, meta ?? ""),
			});

	const server = serve({ fetch: app.fetch, port: PORT });
	console.log(`[crypto-key-server] Listening on :${PORT}`);

	// Graceful shutdown — stop accepting requests, drain watchers, close pool
	const shutdown = async () => {
		console.log("[crypto-key-server] Shutting down...");
		stopWatchers();
		server.close();
		await pool.end();
		process.exit(0);
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}

main().catch((err) => {
	console.error("[crypto-key-server] Fatal:", err);
	process.exit(1);
});
