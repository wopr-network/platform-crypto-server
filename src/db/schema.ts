import { sql } from "drizzle-orm";
import { boolean, index, integer, pgTable, primaryKey, serial, text, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Crypto payment charges — tracks the lifecycle of each payment.
 * reference_id is the charge ID (e.g. "btc:bc1q...").
 *
 * amountUsdCents stores the requested amount in USD cents (integer).
 * This is NOT nanodollars — Credit.fromCents() handles the conversion
 * when crediting the ledger in the webhook handler.
 */
export const cryptoCharges = pgTable(
	"crypto_charges",
	{
		referenceId: text("reference_id").primaryKey(),
		tenantId: text("tenant_id").notNull(),
		amountUsdCents: integer("amount_usd_cents").notNull(),
		status: text("status").notNull().default("New"),
		currency: text("currency"),
		filledAmount: text("filled_amount"),
		createdAt: text("created_at").notNull().default(sql`(now())`),
		updatedAt: text("updated_at").notNull().default(sql`(now())`),
		creditedAt: text("credited_at"),
		chain: text("chain"),
		token: text("token"),
		depositAddress: text("deposit_address"),
		derivationIndex: integer("derivation_index"),
		callbackUrl: text("callback_url"),
		/** Expected crypto amount in native units (e.g. "76923" sats, "50000000" USDC base units). Locked at creation. */
		expectedAmount: text("expected_amount"),
		/** Running total of received crypto in native units. Accumulates across partial payments. */
		receivedAmount: text("received_amount"),
		/** Number of blockchain confirmations observed so far. */
		confirmations: integer("confirmations").notNull().default(0),
		/** Required confirmations for settlement (copied from payment method at creation). */
		confirmationsRequired: integer("confirmations_required").notNull().default(1),
		/** Blockchain transaction hash for the payment. */
		txHash: text("tx_hash"),
		/** Amount received so far in USD cents (integer). Converted from crypto at time of receipt. */
		amountReceivedCents: integer("amount_received_cents").notNull().default(0),
	},
	(table) => [
		index("idx_crypto_charges_tenant").on(table.tenantId),
		index("idx_crypto_charges_status").on(table.status),
		index("idx_crypto_charges_created").on(table.createdAt),
		index("idx_crypto_charges_deposit_address").on(table.depositAddress),
	],
);

/**
 * Watcher cursor persistence — tracks the last processed block per watcher.
 * Eliminates in-memory processedTxids and enables clean restart recovery.
 */
export const watcherCursors = pgTable("watcher_cursors", {
	watcherId: text("watcher_id").primaryKey(),
	cursorBlock: integer("cursor_block").notNull(),
	updatedAt: text("updated_at").notNull().default(sql`(now())`),
});

/**
 * Payment method registry — runtime-configurable tokens/chains.
 * Admin inserts a row to enable a new payment method. No deploy needed.
 * Contract addresses are immutable on-chain but configurable here.
 *
 * nextIndex is an atomic counter for HD derivation — never reuses an index.
 * Increment via UPDATE ... SET next_index = next_index + 1 RETURNING next_index.
 */
export const paymentMethods = pgTable("payment_methods", {
	id: text("id").primaryKey(), // "btc", "base-usdc", "arb-usdc", "doge"
	type: text("type").notNull(), // "erc20", "native", "btc"
	token: text("token").notNull(), // "USDC", "ETH", "BTC", "DOGE"
	chain: text("chain").notNull(), // "base", "ethereum", "bitcoin", "arbitrum"
	network: text("network").notNull().default("mainnet"), // "mainnet", "base", "arbitrum"
	contractAddress: text("contract_address"), // null for native (ETH, BTC)
	decimals: integer("decimals").notNull(),
	displayName: text("display_name").notNull(),
	enabled: boolean("enabled").notNull().default(true),
	displayOrder: integer("display_order").notNull().default(0),
	iconUrl: text("icon_url"),
	rpcUrl: text("rpc_url"), // chain node RPC endpoint
	rpcHeaders: text("rpc_headers").notNull().default("{}"), // JSON: extra headers for RPC calls (e.g. {"TRON-PRO-API-KEY":"xxx"})
	oracleAddress: text("oracle_address"), // Chainlink feed address for price (null = 1:1 stablecoin)
	xpub: text("xpub"), // HD wallet extended public key for deposit address derivation
	addressType: text("address_type").notNull().default("evm"), // "bech32" (BTC/LTC), "p2pkh" (DOGE/TRX), "evm" (ETH/ERC20)
	encodingParams: text("encoding_params").notNull().default("{}"), // JSON: {"hrp":"bc"}, {"version":"0x1e"}, etc.
	watcherType: text("watcher_type").notNull().default("evm"), // "utxo" (BTC/LTC/DOGE) or "evm" (ETH/ERC20/TRX)
	oracleAssetId: text("oracle_asset_id"), // CoinGecko slug (e.g. "bitcoin", "tron"). Null = stablecoin (1:1 USD) or use token symbol fallback.
	confirmations: integer("confirmations").notNull().default(1),
	nextIndex: integer("next_index").notNull().default(0), // atomic derivation counter, never reuses
	keyRingId: text("key_ring_id"), // FK to key_rings.id (nullable during migration)
	encoding: text("encoding"), // address encoding override (e.g. "bech32", "p2pkh", "evm")
	pluginId: text("plugin_id"), // plugin identifier (e.g. "evm", "utxo", "solana")
	createdAt: text("created_at").notNull().default(sql`(now())`),
});

/**
 * BIP-44 path allocation registry — tracks which derivation paths are in use.
 * The server knows which paths are allocated so you never collide.
 * The seed phrase never touches the server — only xpubs.
 */
export const pathAllocations = pgTable(
	"path_allocations",
	{
		coinType: integer("coin_type").notNull(), // BIP44 coin type (0=BTC, 60=ETH, 3=DOGE, 501=SOL)
		accountIndex: integer("account_index").notNull(), // m/44'/{coin_type}'/{index}'
		chainId: text("chain_id").references(() => paymentMethods.id),
		xpub: text("xpub").notNull(),
		allocatedAt: text("allocated_at").notNull().default(sql`(now())`),
	},
	(table) => [primaryKey({ columns: [table.coinType, table.accountIndex] })],
);

/**
 * Webhook delivery outbox — durable retry for payment callbacks.
 * Inserted when a payment is confirmed. Retried until the receiver ACKs.
 */
export const webhookDeliveries = pgTable(
	"webhook_deliveries",
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		chargeId: text("charge_id").notNull(),
		callbackUrl: text("callback_url").notNull(),
		payload: text("payload").notNull(), // JSON stringified
		status: text("status").notNull().default("pending"), // pending, delivered, failed
		attempts: integer("attempts").notNull().default(0),
		nextRetryAt: text("next_retry_at"),
		lastError: text("last_error"),
		createdAt: text("created_at").notNull().default(sql`(now())`),
	},
	(table) => [
		index("idx_webhook_deliveries_status").on(table.status),
		index("idx_webhook_deliveries_charge").on(table.chargeId),
	],
);

/**
 * Every address ever derived — immutable append-only log.
 * Used for auditing and ensuring no address is ever reused.
 */
export const derivedAddresses = pgTable(
	"derived_addresses",
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		chainId: text("chain_id")
			.notNull()
			.references(() => paymentMethods.id),
		derivationIndex: integer("derivation_index").notNull(),
		address: text("address").notNull().unique(),
		tenantId: text("tenant_id"),
		createdAt: text("created_at").notNull().default(sql`(now())`),
	},
	(table) => [index("idx_derived_addresses_chain").on(table.chainId)],
);

/** Processed transaction IDs for watchers without block cursors (e.g. BTC). */
export const watcherProcessed = pgTable(
	"watcher_processed",
	{
		watcherId: text("watcher_id").notNull(),
		txId: text("tx_id").notNull(),
		processedAt: text("processed_at").notNull().default(sql`(now())`),
	},
	(table) => [primaryKey({ columns: [table.watcherId, table.txId] })],
);

/**
 * Key rings — decouples key material (xpub/seed) from payment methods.
 * Each key ring maps to a BIP-44 coin type + account index.
 */
export const keyRings = pgTable(
	"key_rings",
	{
		id: text("id").primaryKey(),
		curve: text("curve").notNull(), // "secp256k1" | "ed25519"
		derivationScheme: text("derivation_scheme").notNull(), // "bip32" | "slip10" | "ed25519-hd"
		derivationMode: text("derivation_mode").notNull().default("on-demand"), // "on-demand" | "pre-derived"
		keyMaterial: text("key_material").notNull().default("{}"), // JSON: { xpub: "..." }
		coinType: integer("coin_type").notNull(), // BIP-44 coin type
		accountIndex: integer("account_index").notNull().default(0),
		createdAt: text("created_at").notNull().default(sql`(now())`),
	},
	(table) => [uniqueIndex("key_rings_path_unique").on(table.coinType, table.accountIndex)],
);

/**
 * Pre-derived address pool — for Ed25519 chains that need offline derivation.
 * Addresses are derived in batches and assigned on demand.
 */
export const addressPool = pgTable(
	"address_pool",
	{
		id: serial("id").primaryKey(),
		keyRingId: text("key_ring_id")
			.notNull()
			.references(() => keyRings.id),
		derivationIndex: integer("derivation_index").notNull(),
		publicKey: text("public_key").notNull(),
		address: text("address").notNull(),
		assignedTo: text("assigned_to"), // charge reference or tenant ID
		createdAt: text("created_at").notNull().default(sql`(now())`),
	},
	(table) => [uniqueIndex("address_pool_ring_index").on(table.keyRingId, table.derivationIndex)],
);
