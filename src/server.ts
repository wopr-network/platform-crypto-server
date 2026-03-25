/**
 * Crypto Key Server — shared address derivation + charge management.
 *
 * Deploys on the chain server (pay.wopr.bot) alongside bitcoind.
 * Products don't run watchers or hold xpubs. They request addresses
 * and receive webhooks.
 *
 * ~200 lines of new code wrapping platform-core's existing crypto modules.
 */

import { HDKey } from "@scure/bip32";
import { and, eq, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { EncodingParams } from "./address-gen.js";
import { deriveAddress } from "./address-gen.js";
import type { CryptoDb } from "./db/index.js";
import { addressPool, derivedAddresses, keyRings, pathAllocations, paymentMethods } from "./db/schema.js";
import { centsToNative } from "./oracle/convert.js";
import type { IPriceOracle } from "./oracle/types.js";
import { AssetNotSupportedError } from "./oracle/types.js";
import type { PluginRegistry } from "./plugin/registry.js";
import type { ICryptoChargeRepository } from "./stores/charge-store.js";
import type { IPaymentMethodStore } from "./stores/payment-method-store.js";

export interface KeyServerDeps {
	db: CryptoDb;
	chargeStore: ICryptoChargeRepository;
	methodStore: IPaymentMethodStore;
	oracle: IPriceOracle;
	/** Bearer token for product API routes. If unset, auth is disabled. */
	serviceKey?: string;
	/** Bearer token for admin routes. If unset, admin routes are disabled. */
	adminToken?: string;
	/** Plugin registry for address encoding. Falls back to address-gen.ts when absent. */
	registry?: PluginRegistry;
}

/**
 * Claim the next address from the pre-derived address pool.
 * Used for Ed25519 chains (Solana, etc.) that can't derive from an xpub.
 */
async function claimFromPool(
	db: CryptoDb,
	keyRingId: string,
	chainId: string,
	tenantId?: string,
): Promise<{ address: string; index: number }> {
	const dbWithTx = db as unknown as { transaction: (fn: (tx: CryptoDb) => Promise<unknown>) => Promise<unknown> };

	const result = await dbWithTx.transaction(async (tx: CryptoDb) => {
		// Find the next unassigned address (lowest index first)
		const [poolEntry] = await tx
			.select()
			.from(addressPool)
			.where(and(eq(addressPool.keyRingId, keyRingId), isNull(addressPool.assignedTo)))
			.orderBy(addressPool.derivationIndex)
			.limit(1);

		if (!poolEntry) {
			throw new Error(`No available addresses in pool for ${keyRingId}. Run crypto-sweep replenish.`);
		}

		// Mark as assigned
		const assignmentId = tenantId ? `${chainId}:${tenantId}` : chainId;
		await tx.update(addressPool).set({ assignedTo: assignmentId }).where(eq(addressPool.id, poolEntry.id));

		// Record in derived_addresses for tracking
		await tx.insert(derivedAddresses).values({
			chainId,
			derivationIndex: poolEntry.derivationIndex,
			address: poolEntry.address,
			tenantId,
		});

		return { address: poolEntry.address, index: poolEntry.derivationIndex };
	});

	return result as { address: string; index: number };
}

/**
 * Derive the next unused address for a chain.
 *
 * For Ed25519 chains with a key ring in "pre-derived" mode (or no xpub),
 * claims from the address pool instead of deriving from an xpub.
 *
 * For xpub-based chains, atomically increments next_index and records
 * the address in a single transaction. EVM chains share an xpub (coin type 60),
 * so the unique constraint on derived_addresses.address prevents reuse.
 * On collision, we skip the index and retry (up to maxRetries).
 */
async function deriveNextAddress(
	db: CryptoDb,
	chainId: string,
	tenantId?: string,
	registry?: PluginRegistry,
): Promise<{ address: string; index: number; chain: string; token: string }> {
	const maxRetries = 10;
	const dbWithTx = db as unknown as { transaction: (fn: (tx: CryptoDb) => Promise<unknown>) => Promise<unknown> };

	// Check if this payment method uses pool-based derivation (Ed25519 chains).
	// Look up the method first to check for key_ring_id with derivation_mode = 'pre-derived'.
	const [methodCheck] = await db.select().from(paymentMethods).where(eq(paymentMethods.id, chainId));

	if (methodCheck?.keyRingId) {
		// Check the key ring's derivation mode
		const [ring] = await db.select().from(keyRings).where(eq(keyRings.id, methodCheck.keyRingId));

		if (ring?.derivationMode === "pre-derived" || (!methodCheck.xpub && ring)) {
			// Pool mode: claim from pre-derived addresses
			const { address, index } = await claimFromPool(db, methodCheck.keyRingId, chainId, tenantId);
			return { address, index, chain: methodCheck.chain, token: methodCheck.token };
		}
	}

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		// Step 1: Atomically claim the next index OUTSIDE the transaction.
		// This survives even if the transaction below rolls back on address collision.
		const [method] = await db
			.update(paymentMethods)
			.set({ nextIndex: sql`${paymentMethods.nextIndex} + 1` })
			.where(eq(paymentMethods.id, chainId))
			.returning();

		if (!method) throw new Error(`Chain not found: ${chainId}`);
		if (!method.xpub) throw new Error(`No xpub configured for chain: ${chainId}`);

		const index = method.nextIndex - 1;

		// Universal address derivation — encoding type + params are DB-driven.
		// Adding a new chain is a DB INSERT, not a code change.
		let encodingParams: EncodingParams = {};
		try {
			encodingParams = JSON.parse(method.encodingParams ?? "{}");
		} catch {
			throw new Error(`Invalid encoding_params JSON for chain ${chainId}: ${method.encodingParams}`);
		}

		// Plugin-driven encoding: look up the plugin, use its encoder.
		// Falls back to legacy deriveAddress() when no registry or no matching plugin.
		let address: string;
		const pluginId = method.pluginId ?? (method.watcherType === "utxo" ? "bitcoin" : method.watcherType);
		const plugin = registry?.get(pluginId ?? "");
		const encodingKey = method.encoding ?? method.addressType;
		const encoder = plugin?.encoders[encodingKey];

		if (encoder) {
			const master = HDKey.fromExtendedKey(method.xpub);
			const child = master.deriveChild(0).deriveChild(index);
			if (!child.publicKey) throw new Error("Failed to derive public key");
			address = encoder.encode(child.publicKey, encodingParams as Record<string, string | undefined>);
		} else {
			address = deriveAddress(method.xpub, index, method.addressType, encodingParams);
		}

		// Step 2: Record in immutable log. If this address was already derived by a
		// sibling chain (shared xpub), the unique constraint fires and we retry
		// with the next index (which is already incremented above).
		try {
			await dbWithTx.transaction(async (tx: CryptoDb) => {
				// bech32/evm addresses are case-insensitive (lowercase by spec).
				// p2pkh (Base58Check) addresses are case-sensitive — do NOT lowercase.
				const normalizedAddress = method.addressType === "p2pkh" ? address : address.toLowerCase();
				await tx.insert(derivedAddresses).values({
					chainId,
					derivationIndex: index,
					address: normalizedAddress,
					tenantId,
				});
			});
			return { address, index, chain: method.chain, token: method.token };
		} catch (err: unknown) {
			// Drizzle wraps PG errors — check both top-level and cause for the constraint violation code
			const code = (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;
			if (code === "23505" && attempt < maxRetries) continue; // collision — index already advanced, retry
			throw err;
		}
	}
	throw new Error(`Failed to derive unique address for ${chainId} after ${maxRetries} retries`);
}

/** Validate Bearer token from Authorization header. */
function requireAuth(header: string | undefined, expected: string): boolean {
	if (!expected) return true; // auth disabled
	return header === `Bearer ${expected}`;
}

/**
 * Create the Hono app for the crypto key server.
 * Mount this on the chain server at the root.
 */
export function createKeyServerApp(deps: KeyServerDeps): Hono {
	const app = new Hono();

	// --- Auth middleware for product routes ---
	app.use("/address", async (c, next) => {
		if (deps.serviceKey && !requireAuth(c.req.header("Authorization"), deps.serviceKey)) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		await next();
	});
	app.use("/charges/*", async (c, next) => {
		if (deps.serviceKey && !requireAuth(c.req.header("Authorization"), deps.serviceKey)) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		await next();
	});
	app.use("/charges", async (c, next) => {
		if (deps.serviceKey && !requireAuth(c.req.header("Authorization"), deps.serviceKey)) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		await next();
	});

	// --- Auth middleware for admin routes ---
	app.use("/admin/*", async (c, next) => {
		if (!deps.adminToken) return c.json({ error: "Admin API disabled" }, 403);
		if (!requireAuth(c.req.header("Authorization"), deps.adminToken)) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		await next();
	});

	// --- Product API ---

	/** POST /address — derive next unused address */
	app.post("/address", async (c) => {
		const body = await c.req.json<{ chain: string }>();
		if (!body.chain) return c.json({ error: "chain is required" }, 400);

		const tenantId = c.req.header("X-Tenant-Id");
		const result = await deriveNextAddress(deps.db, body.chain, tenantId ?? undefined, deps.registry);
		return c.json(result, 201);
	});

	/** POST /charges — create charge + derive address + start watching */
	app.post("/charges", async (c) => {
		const body = await c.req.json<{
			chain: string;
			amountUsd: number;
			callbackUrl?: string;
			metadata?: Record<string, unknown>;
		}>();

		if (!body.chain || typeof body.amountUsd !== "number" || !Number.isFinite(body.amountUsd) || body.amountUsd <= 0) {
			return c.json({ error: "chain is required and amountUsd must be a positive finite number" }, 400);
		}

		const tenantId = c.req.header("X-Tenant-Id") ?? "unknown";
		const { address, index, chain, token } = await deriveNextAddress(deps.db, body.chain, tenantId, deps.registry);

		// Look up payment method for decimals + oracle config
		const method = await deps.methodStore.getById(body.chain);
		if (!method) return c.json({ error: `Unknown chain: ${body.chain}` }, 400);

		const amountUsdCents = Math.round(body.amountUsd * 100);

		// Compute expected crypto amount in native base units.
		// Price is locked NOW — this is what the user must send.
		let expectedAmount: bigint;
		const feedAddress = method.oracleAddress ? (method.oracleAddress as `0x${string}`) : undefined;
		try {
			// Try oracle pricing (Chainlink for BTC/ETH, CoinGecko for DOGE/LTC).
			// feedAddress is a hint for Chainlink — undefined is fine, CompositeOracle
			// falls through to CoinGecko or built-in feed maps.
			const { priceMicros } = await deps.oracle.getPrice(token, feedAddress);
			expectedAmount = centsToNative(amountUsdCents, priceMicros, method.decimals);
		} catch (err) {
			if (err instanceof AssetNotSupportedError) {
				// No oracle knows this token (e.g. USDC, DAI) — stablecoin 1:1 USD.
				expectedAmount = (BigInt(amountUsdCents) * 10n ** BigInt(method.decimals)) / 100n;
			} else {
				// Transient oracle failure (network, rate limit, stale feed).
				// Reject the charge — silently pricing BTC at $1 would be catastrophic.
				return c.json({ error: `Price oracle unavailable for ${token}: ${(err as Error).message}` }, 503);
			}
		}

		const referenceId = `${token.toLowerCase()}:${address.toLowerCase()}`;

		await deps.chargeStore.createStablecoinCharge({
			referenceId,
			tenantId,
			amountUsdCents,
			chain,
			token,
			depositAddress: address,
			derivationIndex: index,
			callbackUrl: body.callbackUrl,
			expectedAmount: expectedAmount.toString(),
		});

		// Format display amount for the client (BigInt-safe, no Number overflow)
		const divisor = 10n ** BigInt(method.decimals);
		const whole = expectedAmount / divisor;
		const frac = expectedAmount % divisor;
		const fracStr = frac.toString().padStart(method.decimals, "0").slice(0, 8).replace(/0+$/, "");
		const displayAmount = `${whole}${fracStr ? `.${fracStr}` : ""} ${token}`;

		return c.json(
			{
				chargeId: referenceId,
				address,
				chain,
				token,
				amountUsd: body.amountUsd,
				expectedAmount: expectedAmount.toString(),
				displayAmount,
				derivationIndex: index,
				expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30 min
			},
			201,
		);
	});

	/** GET /charges/:id — check charge status */
	app.get("/charges/:id", async (c) => {
		const charge = await deps.chargeStore.getByReferenceId(c.req.param("id"));
		if (!charge) return c.json({ error: "Charge not found" }, 404);

		return c.json({
			chargeId: charge.referenceId,
			status: charge.status,
			address: charge.depositAddress,
			chain: charge.chain,
			token: charge.token,
			amountUsdCents: charge.amountUsdCents,
			creditedAt: charge.creditedAt,
		});
	});

	/** GET /chains — list enabled payment methods (for checkout UI) */
	app.get("/chains", async (c) => {
		const methods = await deps.methodStore.listEnabled();
		return c.json(
			methods.map((m) => ({
				id: m.id,
				token: m.token,
				chain: m.chain,
				decimals: m.decimals,
				displayName: m.displayName,
				contractAddress: m.contractAddress,
				confirmations: m.confirmations,
				iconUrl: m.iconUrl,
			})),
		);
	});

	// --- Admin API ---

	/** GET /admin/next-path — which derivation path to use for a coin type */
	app.get("/admin/next-path", async (c) => {
		const coinType = Number(c.req.query("coin_type"));
		if (!Number.isInteger(coinType)) return c.json({ error: "coin_type must be an integer" }, 400);

		// Find all allocations for this coin type
		const existing = await deps.db.select().from(pathAllocations).where(eq(pathAllocations.coinType, coinType));

		if (existing.length === 0) {
			return c.json({
				coin_type: coinType,
				account_index: 0,
				path: `m/44'/${coinType}'/0'`,
				status: "available",
			});
		}

		// If already allocated, return info about existing allocation
		const latest = existing.sort(
			(a: { accountIndex: number }, b: { accountIndex: number }) => b.accountIndex - a.accountIndex,
		)[0];

		// Find chains using this coin type's allocations
		const chainIds = existing.map((a: { chainId: string | null }) => a.chainId).filter(Boolean);
		return c.json({
			coin_type: coinType,
			account_index: latest.accountIndex,
			path: `m/44'/${coinType}'/${latest.accountIndex}'`,
			status: "allocated",
			allocated_to: chainIds,
			note: "xpub already registered — reuse for new chains with same key type",
			next_available: {
				account_index: latest.accountIndex + 1,
				path: `m/44'/${coinType}'/${latest.accountIndex + 1}'`,
			},
		});
	});

	/** POST /admin/chains — register a new chain with its xpub */
	app.post("/admin/chains", async (c) => {
		const body = await c.req.json<{
			id: string;
			coin_type: number;
			account_index: number;
			network: string;
			type: string;
			token: string;
			chain: string;
			contract?: string;
			decimals: number;
			xpub: string;
			rpc_url: string;
			rpc_headers?: Record<string, string>;
			confirmations?: number;
			display_name?: string;
			oracle_address?: string;
			address_type?: string;
			encoding_params?: Record<string, string>;
			watcher_type?: string;
			oracle_asset_id?: string;
			icon_url?: string;
			display_order?: number;
		}>();

		if (!body.id || !body.xpub || !body.token) {
			return c.json({ error: "id, xpub, and token are required" }, 400);
		}

		// Validate encoding_params match address_type requirements
		const addrType = body.address_type ?? "evm";
		const encParams = body.encoding_params ?? {};
		if (addrType === "bech32" && !encParams.hrp) {
			return c.json({ error: "bech32 address_type requires encoding_params.hrp" }, 400);
		}
		if (addrType === "p2pkh" && !encParams.version) {
			return c.json({ error: "p2pkh address_type requires encoding_params.version" }, 400);
		}

		// Upsert payment method FIRST (path_allocations has FK to payment_methods.id)
		await deps.methodStore.upsert({
			id: body.id,
			type: body.type ?? "native",
			token: body.token,
			chain: body.chain ?? body.network,
			contractAddress: body.contract ?? null,
			decimals: body.decimals,
			displayName: body.display_name ?? `${body.token} on ${body.network}`,
			enabled: true,
			displayOrder: body.display_order ?? 0,
			iconUrl: body.icon_url ?? null,
			rpcUrl: body.rpc_url,
			rpcHeaders: JSON.stringify(body.rpc_headers ?? {}),
			oracleAddress: body.oracle_address ?? null,
			xpub: body.xpub,
			addressType: body.address_type ?? "evm",
			encodingParams: JSON.stringify(body.encoding_params ?? {}),
			watcherType: body.watcher_type ?? "evm",
			oracleAssetId: body.oracle_asset_id ?? null,
			confirmations: body.confirmations ?? 6,
			keyRingId: null,
			encoding: null,
			pluginId: null,
		});

		// Record the path allocation (idempotent — ignore if already exists)
		const inserted = (await deps.db
			.insert(pathAllocations)
			.values({
				coinType: body.coin_type,
				accountIndex: body.account_index,
				chainId: body.id,
				xpub: body.xpub,
			})
			.onConflictDoNothing()) as { rowCount: number };

		if (inserted.rowCount === 0) {
			return c.json(
				{
					message: "Path allocation already exists, payment method updated",
					path: `m/44'/${body.coin_type}'/${body.account_index}'`,
				},
				200,
			);
		}

		return c.json({ id: body.id, path: `m/44'/${body.coin_type}'/${body.account_index}'` }, 201);
	});

	/** PATCH /admin/chains/:id — update metadata (icon_url, display_order, display_name) */
	app.patch("/admin/chains/:id", async (c) => {
		const id = c.req.param("id");
		const body = await c.req.json<{
			icon_url?: string | null;
			display_order?: number;
			display_name?: string;
		}>();

		const updated = await deps.methodStore.patchMetadata(id, {
			iconUrl: body.icon_url,
			displayOrder: body.display_order,
			displayName: body.display_name,
		});

		if (!updated) return c.json({ id, updated: false }, 200);
		return c.json({ id, updated: true });
	});

	/** DELETE /admin/chains/:id — soft disable */
	app.delete("/admin/chains/:id", async (c) => {
		await deps.methodStore.setEnabled(c.req.param("id"), false);
		return c.body(null, 204);
	});

	/** POST /admin/pool/replenish — upload pre-derived addresses for Ed25519 chains */
	app.post("/admin/pool/replenish", async (c) => {
		const body = await c.req.json<{
			key_ring_id: string;
			plugin_id: string;
			encoding: string;
			addresses: Array<{
				index: number;
				public_key: string;
				address: string;
			}>;
		}>();

		if (
			!body.key_ring_id ||
			!body.plugin_id ||
			!body.encoding ||
			!Array.isArray(body.addresses) ||
			body.addresses.length === 0
		) {
			return c.json({ error: "key_ring_id, plugin_id, encoding, and a non-empty addresses array are required" }, 400);
		}

		// Validate the key ring exists
		const [ring] = await deps.db.select().from(keyRings).where(eq(keyRings.id, body.key_ring_id));
		if (!ring) {
			return c.json({ error: `Key ring not found: ${body.key_ring_id}` }, 404);
		}

		// Look up the plugin encoder for validation
		const plugin = deps.registry?.get(body.plugin_id);
		const encoder = plugin?.encoders[body.encoding];

		// Validate each address against the public key
		for (const entry of body.addresses) {
			if (typeof entry.index !== "number" || !entry.public_key || !entry.address) {
				return c.json(
					{ error: `Invalid entry at index ${entry.index}: index, public_key, and address are required` },
					400,
				);
			}

			// If we have an encoder, validate the address by re-encoding the public key
			if (encoder) {
				const pubKeyBytes = hexToBytes(entry.public_key);
				const reEncoded = encoder.encode(pubKeyBytes, {});
				if (reEncoded !== entry.address) {
					return c.json(
						{
							error: `Address mismatch at index ${entry.index}: expected ${reEncoded}, got ${entry.address}`,
						},
						400,
					);
				}
			}
		}

		// Insert validated addresses into the pool
		let inserted = 0;
		for (const entry of body.addresses) {
			const result = (await deps.db
				.insert(addressPool)
				.values({
					keyRingId: body.key_ring_id,
					derivationIndex: entry.index,
					publicKey: entry.public_key,
					address: entry.address,
				})
				.onConflictDoNothing()) as { rowCount: number };
			inserted += result.rowCount;
		}

		// Get total pool size for this key ring
		const totalRows = await deps.db.select().from(addressPool).where(eq(addressPool.keyRingId, body.key_ring_id));

		return c.json({ inserted, total: totalRows.length }, 201);
	});

	/** GET /admin/pool/status — pool stats per key ring */
	app.get("/admin/pool/status", async (c) => {
		// Get all key rings
		const rings = await deps.db.select().from(keyRings);

		const pools = await Promise.all(
			rings.map(async (ring) => {
				const allEntries = await deps.db.select().from(addressPool).where(eq(addressPool.keyRingId, ring.id));

				const available = allEntries.filter((e) => e.assignedTo === null).length;
				const assigned = allEntries.length - available;

				return {
					key_ring_id: ring.id,
					total: allEntries.length,
					available,
					assigned,
				};
			}),
		);

		return c.json({ pools });
	});

	return app;
}

/** Convert a hex string to Uint8Array. */
function hexToBytes(hex: string): Uint8Array {
	const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
	const bytes = new Uint8Array(clean.length / 2);
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
	}
	return bytes;
}
