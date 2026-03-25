import { describe, expect, it, vi } from "vitest";
import type { PluginRegistry } from "../plugin/registry.js";
import type { KeyServerDeps } from "../server.js";
import { createKeyServerApp } from "../server.js";
import type { ICryptoChargeRepository } from "../stores/charge-store.js";
import type { IPaymentMethodStore } from "../stores/payment-method-store.js";

/** Create a mock db that supports transaction() by passing itself to the callback. */
function createMockDb() {
	const mockMethod = {
		id: "btc",
		type: "native",
		token: "BTC",
		chain: "bitcoin",
		xpub: "xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKrhko4egpiMZbpiaQL2jkwSB1icqYh2cfDfVxdx4df189oLKnC5fSwqPfgyP3hooxujYzAu3fDVmz",
		nextIndex: 1,
		decimals: 8,
		addressType: "bech32",
		encodingParams: '{"hrp":"bc"}',
		watcherType: "utxo",
		oracleAssetId: "bitcoin",
		confirmations: 6,
	};

	const db = {
		update: vi.fn().mockReturnValue({
			set: vi.fn().mockReturnValue({
				where: vi.fn().mockReturnValue({
					returning: vi.fn().mockResolvedValue([mockMethod]),
				}),
			}),
		}),
		insert: vi.fn().mockReturnValue({
			values: vi.fn().mockReturnValue({
				onConflictDoNothing: vi.fn().mockResolvedValue({ rowCount: 1 }),
			}),
		}),
		select: vi.fn().mockReturnValue({
			from: vi.fn().mockReturnValue({
				where: vi.fn().mockResolvedValue([]),
			}),
		}),
		// transaction() passes itself as tx — mocks work the same way
		transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db)),
	};
	return db;
}

/** Minimal mock deps for key server tests. */
function mockDeps(): KeyServerDeps & {
	chargeStore: { [K in keyof ICryptoChargeRepository]: ReturnType<typeof vi.fn> };
	methodStore: { [K in keyof IPaymentMethodStore]: ReturnType<typeof vi.fn> };
} {
	const chargeStore = {
		getByReferenceId: vi.fn().mockResolvedValue({
			referenceId: "btc:bc1q...",
			status: "New",
			depositAddress: "bc1q...",
			chain: "bitcoin",
			token: "BTC",
			amountUsdCents: 5000,
			creditedAt: null,
		}),
		createStablecoinCharge: vi.fn().mockResolvedValue(undefined),
		create: vi.fn(),
		updateStatus: vi.fn(),
		markCredited: vi.fn(),
		isCredited: vi.fn(),
		getByDepositAddress: vi.fn(),
		getNextDerivationIndex: vi.fn(),
		listActiveDepositAddresses: vi.fn(),
	};
	const methodStore = {
		listEnabled: vi.fn().mockResolvedValue([
			{
				id: "btc",
				token: "BTC",
				chain: "bitcoin",
				decimals: 8,
				displayName: "Bitcoin",
				contractAddress: null,
				confirmations: 6,
				iconUrl: null,
			},
			{
				id: "base-usdc",
				token: "USDC",
				chain: "base",
				decimals: 6,
				displayName: "USDC on Base",
				contractAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
				confirmations: 12,
				iconUrl: null,
			},
		]),
		listAll: vi.fn(),
		getById: vi.fn().mockResolvedValue({
			id: "btc",
			type: "native",
			token: "BTC",
			chain: "bitcoin",
			decimals: 8,
			displayName: "Bitcoin",
			contractAddress: null,
			confirmations: 6,
			oracleAddress: "0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F",
			xpub: null,
			displayOrder: 0,
			iconUrl: null,
			enabled: true,
			rpcUrl: null,
		}),
		listByType: vi.fn(),
		upsert: vi.fn().mockResolvedValue(undefined),
		setEnabled: vi.fn().mockResolvedValue(undefined),
		patchMetadata: vi.fn().mockResolvedValue(true),
	};
	return {
		db: createMockDb() as never,
		chargeStore: chargeStore as never,
		methodStore: methodStore as never,
		oracle: { getPrice: vi.fn().mockResolvedValue({ priceMicros: 65_000_000_000, updatedAt: new Date() }) } as never,
	};
}

describe("key-server routes", () => {
	it("GET /chains returns enabled payment methods", async () => {
		const app = createKeyServerApp(mockDeps());
		const res = await app.request("/chains");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toHaveLength(2);
		expect(body[0].token).toBe("BTC");
		expect(body[1].token).toBe("USDC");
	});

	it("POST /address requires chain", async () => {
		const app = createKeyServerApp(mockDeps());
		const res = await app.request("/address", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});

	it("POST /address derives BTC address", async () => {
		const app = createKeyServerApp(mockDeps());
		const res = await app.request("/address", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chain: "btc" }),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.address).toMatch(/^bc1q/);
		expect(body.index).toBe(0);
		expect(body.chain).toBe("bitcoin");
		expect(body.token).toBe("BTC");
	});

	it("GET /charges/:id returns charge status", async () => {
		const app = createKeyServerApp(mockDeps());
		const res = await app.request("/charges/btc:bc1q...");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.chargeId).toBe("btc:bc1q...");
		expect(body.status).toBe("New");
	});

	it("GET /charges/:id returns 404 for missing charge", async () => {
		const deps = mockDeps();
		(deps.chargeStore.getByReferenceId as ReturnType<typeof vi.fn>).mockResolvedValue(null);
		const app = createKeyServerApp(deps);
		const res = await app.request("/charges/nonexistent");
		expect(res.status).toBe(404);
	});

	it("POST /charges validates amountUsd", async () => {
		const app = createKeyServerApp(mockDeps());
		const res = await app.request("/charges", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chain: "btc", amountUsd: -10 }),
		});
		expect(res.status).toBe(400);
	});

	it("POST /address retries on shared-xpub address collision", async () => {
		const collision = Object.assign(new Error("unique_violation"), { code: "23505" });
		let callCount = 0;

		const mockMethod = {
			id: "eth",
			type: "native",
			token: "ETH",
			chain: "base",
			xpub: "xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKrhko4egpiMZbpiaQL2jkwSB1icqYh2cfDfVxdx4df189oLKnC5fSwqPfgyP3hooxujYzAu3fDVmz",
			nextIndex: 0,
			decimals: 18,
			addressType: "evm",
			encodingParams: "{}",
			watcherType: "evm",
			oracleAssetId: "ethereum",
			confirmations: 1,
		};

		const db = {
			// Each update call increments nextIndex
			update: vi.fn().mockImplementation(() => ({
				set: vi.fn().mockReturnValue({
					where: vi.fn().mockReturnValue({
						returning: vi.fn().mockImplementation(() => {
							callCount++;
							return Promise.resolve([{ ...mockMethod, nextIndex: callCount }]);
						}),
					}),
				}),
			})),
			insert: vi.fn().mockImplementation(() => ({
				values: vi.fn().mockImplementation(() => {
					// First insert collides, second succeeds
					if (callCount <= 1) throw collision;
					return { onConflictDoNothing: vi.fn().mockResolvedValue({ rowCount: 1 }) };
				}),
			})),
			select: vi.fn().mockReturnValue({
				from: vi.fn().mockReturnValue({
					where: vi.fn().mockResolvedValue([]),
				}),
			}),
			transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db)),
		};

		const deps = mockDeps();
		(deps as unknown as { db: unknown }).db = db;
		const app = createKeyServerApp(deps);

		const res = await app.request("/address", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chain: "eth" }),
		});

		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.address).toMatch(/^0x/);
		// Should have called update twice (first collision, then success)
		expect(callCount).toBe(2);
		expect(body.index).toBe(1); // skipped index 0
	});

	it("POST /address retries on Drizzle-wrapped collision error (cause.code)", async () => {
		// Drizzle wraps PG errors: err.code is undefined, err.cause.code has "23505"
		const pgError = Object.assign(new Error("unique_violation"), { code: "23505" });
		const drizzleError = Object.assign(new Error("DrizzleQueryError"), { cause: pgError });
		let callCount = 0;

		const mockMethod = {
			id: "eth",
			type: "native",
			token: "ETH",
			chain: "base",
			xpub: "xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKrhko4egpiMZbpiaQL2jkwSB1icqYh2cfDfVxdx4df189oLKnC5fSwqPfgyP3hooxujYzAu3fDVmz",
			nextIndex: 0,
			decimals: 18,
			addressType: "evm",
			encodingParams: "{}",
			watcherType: "evm",
			oracleAssetId: "ethereum",
			confirmations: 1,
		};

		const db = {
			update: vi.fn().mockImplementation(() => ({
				set: vi.fn().mockReturnValue({
					where: vi.fn().mockReturnValue({
						returning: vi.fn().mockImplementation(() => {
							callCount++;
							return Promise.resolve([{ ...mockMethod, nextIndex: callCount }]);
						}),
					}),
				}),
			})),
			insert: vi.fn().mockImplementation(() => ({
				values: vi.fn().mockImplementation(() => {
					if (callCount <= 1) throw drizzleError;
					return { onConflictDoNothing: vi.fn().mockResolvedValue({ rowCount: 1 }) };
				}),
			})),
			select: vi.fn().mockReturnValue({
				from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
			}),
			transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db)),
		};

		const deps = mockDeps();
		(deps as unknown as { db: unknown }).db = db;
		const app = createKeyServerApp(deps);

		const res = await app.request("/address", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chain: "eth" }),
		});

		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.address).toMatch(/^0x/);
		expect(callCount).toBe(2);
		expect(body.index).toBe(1);
	});

	it("POST /charges creates a charge", async () => {
		const app = createKeyServerApp(mockDeps());
		const res = await app.request("/charges", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chain: "btc", amountUsd: 50 }),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.address).toMatch(/^bc1q/);
		expect(body.amountUsd).toBe(50);
		expect(body.expiresAt).toBeTruthy();
	});

	it("GET /admin/next-path returns available path", async () => {
		const deps = mockDeps();
		deps.adminToken = "test-admin";
		const app = createKeyServerApp(deps);
		const res = await app.request("/admin/next-path?coin_type=0", {
			headers: { Authorization: "Bearer test-admin" },
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.path).toBe("m/44'/0'/0'");
		expect(body.status).toBe("available");
	});

	it("DELETE /admin/chains/:id disables chain", async () => {
		const deps = mockDeps();
		deps.adminToken = "test-admin";
		const app = createKeyServerApp(deps);
		const res = await app.request("/admin/chains/doge", {
			method: "DELETE",
			headers: { Authorization: "Bearer test-admin" },
		});
		expect(res.status).toBe(204);
		expect(deps.methodStore.setEnabled).toHaveBeenCalledWith("doge", false);
	});
});

describe("key-server pool endpoints", () => {
	/** Create a mock db that supports pool queries. */
	function createPoolMockDb(opts?: {
		keyRing?: { id: string; derivationMode: string } | null;
		poolEntries?: Array<{
			id: number;
			keyRingId: string;
			derivationIndex: number;
			publicKey: string;
			address: string;
			assignedTo: string | null;
		}>;
		allKeyRings?: Array<{ id: string }>;
	}) {
		const keyRing = opts?.keyRing ?? null;
		const poolEntries = opts?.poolEntries ?? [];
		const allKeyRings = opts?.allKeyRings ?? (keyRing ? [keyRing] : []);

		const db: Record<string, unknown> = {};

		// Track which table is being queried via from()
		db.select = vi.fn().mockReturnValue({
			from: vi.fn().mockImplementation((table: unknown) => {
				const tableName = (table as Record<symbol, string>)[Symbol.for("drizzle:Name")];
				if (tableName === "key_rings") {
					return {
						where: vi.fn().mockResolvedValue(keyRing ? [keyRing] : []),
						orderBy: vi.fn().mockResolvedValue(allKeyRings),
					};
				}
				if (tableName === "address_pool") {
					return {
						where: vi.fn().mockImplementation(() => ({
							orderBy: vi.fn().mockImplementation(() => ({
								limit: vi.fn().mockResolvedValue(poolEntries.filter((e) => e.assignedTo === null).slice(0, 1)),
							})),
							// For counting all pool entries for a key ring
							length: poolEntries.length,
							filter: (fn: (e: unknown) => boolean) => poolEntries.filter(fn),
							[Symbol.iterator]: function* () {
								yield* poolEntries;
							},
						})),
					};
				}
				// Default: payment_methods
				return {
					where: vi.fn().mockResolvedValue([]),
				};
			}),
		});

		db.insert = vi.fn().mockReturnValue({
			values: vi.fn().mockReturnValue({
				onConflictDoNothing: vi.fn().mockResolvedValue({ rowCount: 1 }),
			}),
		});

		db.update = vi.fn().mockReturnValue({
			set: vi.fn().mockReturnValue({
				where: vi.fn().mockReturnValue({
					returning: vi.fn().mockResolvedValue([]),
				}),
			}),
		});

		db.transaction = vi.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));

		return db;
	}

	it("POST /admin/pool/replenish validates required fields", async () => {
		const deps = mockDeps();
		deps.adminToken = "test-admin";
		const app = createKeyServerApp(deps);
		const res = await app.request("/admin/pool/replenish", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer test-admin" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});

	it("POST /admin/pool/replenish returns 404 for unknown key ring", async () => {
		const db = createPoolMockDb({ keyRing: null });
		const deps = mockDeps();
		deps.adminToken = "test-admin";
		(deps as unknown as { db: unknown }).db = db;
		const app = createKeyServerApp(deps);
		const res = await app.request("/admin/pool/replenish", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer test-admin" },
			body: JSON.stringify({
				key_ring_id: "sol-main",
				plugin_id: "solana",
				encoding: "base58-solana",
				addresses: [{ index: 0, public_key: "abcd", address: "SolAddr1" }],
			}),
		});
		expect(res.status).toBe(404);
	});

	it("POST /admin/pool/replenish inserts validated addresses", async () => {
		const db = createPoolMockDb({
			keyRing: { id: "sol-main", derivationMode: "pre-derived" },
			poolEntries: [],
		});

		// Override select().from() to handle both keyRings query and the count query
		const selectMock = vi.fn().mockReturnValue({
			from: vi.fn().mockImplementation((table: unknown) => {
				const tableName = (table as Record<symbol, string>)[Symbol.for("drizzle:Name")];
				if (tableName === "key_rings") {
					return {
						where: vi.fn().mockResolvedValue([{ id: "sol-main", derivationMode: "pre-derived" }]),
					};
				}
				// address_pool count query (after insert)
				return {
					where: vi.fn().mockResolvedValue([
						{
							id: 1,
							keyRingId: "sol-main",
							derivationIndex: 0,
							publicKey: "ab",
							address: "SolAddr0",
							assignedTo: null,
						},
						{
							id: 2,
							keyRingId: "sol-main",
							derivationIndex: 1,
							publicKey: "cd",
							address: "SolAddr1",
							assignedTo: null,
						},
					]),
				};
			}),
		});
		(db as Record<string, unknown>).select = selectMock;

		const deps = mockDeps();
		deps.adminToken = "test-admin";
		(deps as unknown as { db: unknown }).db = db;
		// No registry — skip re-encoding validation
		deps.registry = undefined;

		const app = createKeyServerApp(deps);
		const res = await app.request("/admin/pool/replenish", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer test-admin" },
			body: JSON.stringify({
				key_ring_id: "sol-main",
				plugin_id: "solana",
				encoding: "base58-solana",
				addresses: [
					{ index: 0, public_key: "ab", address: "SolAddr0" },
					{ index: 1, public_key: "cd", address: "SolAddr1" },
				],
			}),
		});

		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.inserted).toBe(2);
		expect(body.total).toBe(2);
	});

	it("POST /admin/pool/replenish rejects mismatched address when encoder present", async () => {
		const mockEncoder = {
			encode: vi.fn().mockReturnValue("CorrectAddress"),
			encodingType: vi.fn().mockReturnValue("base58-solana"),
		};
		const mockPlugin = {
			pluginId: "solana",
			supportedCurve: "ed25519" as const,
			encoders: { "base58-solana": mockEncoder },
			createWatcher: vi.fn(),
			createSweeper: vi.fn(),
			version: 1,
		};
		const mockRegistry = {
			get: vi.fn().mockReturnValue(mockPlugin),
			getOrThrow: vi.fn(),
			list: vi.fn(),
			register: vi.fn(),
		};

		const db = createPoolMockDb({
			keyRing: { id: "sol-main", derivationMode: "pre-derived" },
		});

		const deps = mockDeps();
		deps.adminToken = "test-admin";
		(deps as unknown as { db: unknown }).db = db;
		deps.registry = mockRegistry as unknown as PluginRegistry;

		const app = createKeyServerApp(deps);
		const res = await app.request("/admin/pool/replenish", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer test-admin" },
			body: JSON.stringify({
				key_ring_id: "sol-main",
				plugin_id: "solana",
				encoding: "base58-solana",
				addresses: [{ index: 0, public_key: "abcd1234", address: "WrongAddress" }],
			}),
		});

		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toContain("Address mismatch");
	});

	it("GET /admin/pool/status returns pool stats", async () => {
		const db = createPoolMockDb({
			allKeyRings: [{ id: "sol-main" }],
			poolEntries: [
				{ id: 1, keyRingId: "sol-main", derivationIndex: 0, publicKey: "a", address: "A", assignedTo: null },
				{ id: 2, keyRingId: "sol-main", derivationIndex: 1, publicKey: "b", address: "B", assignedTo: "tenant:1" },
				{ id: 3, keyRingId: "sol-main", derivationIndex: 2, publicKey: "c", address: "C", assignedTo: null },
			],
		});

		// Override select to handle the two different query patterns in pool/status
		let selectCallCount = 0;
		const poolEntries = [
			{ id: 1, keyRingId: "sol-main", derivationIndex: 0, publicKey: "a", address: "A", assignedTo: null },
			{ id: 2, keyRingId: "sol-main", derivationIndex: 1, publicKey: "b", address: "B", assignedTo: "tenant:1" },
			{ id: 3, keyRingId: "sol-main", derivationIndex: 2, publicKey: "c", address: "C", assignedTo: null },
		];
		(db as Record<string, unknown>).select = vi.fn().mockReturnValue({
			from: vi.fn().mockImplementation(() => {
				selectCallCount++;
				if (selectCallCount === 1) {
					// First call: select from keyRings (no where clause)
					return [{ id: "sol-main" }];
				}
				// Second call: select from addressPool where keyRingId = ring.id
				return {
					where: vi.fn().mockResolvedValue(poolEntries),
				};
			}),
		});

		const deps = mockDeps();
		deps.adminToken = "test-admin";
		(deps as unknown as { db: unknown }).db = db;
		const app = createKeyServerApp(deps);

		const res = await app.request("/admin/pool/status", {
			headers: { Authorization: "Bearer test-admin" },
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.pools).toHaveLength(1);
		expect(body.pools[0].key_ring_id).toBe("sol-main");
		expect(body.pools[0].total).toBe(3);
		expect(body.pools[0].available).toBe(2);
		expect(body.pools[0].assigned).toBe(1);
	});

	it("POST /address uses pool for pre-derived key ring", async () => {
		const poolEntry = {
			id: 1,
			keyRingId: "sol-main",
			derivationIndex: 7,
			publicKey: "deadbeef",
			address: "SolanaAddr7",
			assignedTo: null,
			createdAt: "2026-01-01",
		};

		const solMethod = {
			id: "sol",
			type: "native",
			token: "SOL",
			chain: "solana",
			xpub: null,
			keyRingId: "sol-main",
			nextIndex: 0,
			decimals: 9,
			addressType: "base58-solana",
			encodingParams: "{}",
			watcherType: "solana",
			oracleAssetId: "solana",
			confirmations: 1,
			pluginId: "solana",
			encoding: "base58-solana",
		};

		const keyRing = {
			id: "sol-main",
			curve: "ed25519",
			derivationScheme: "slip10",
			derivationMode: "pre-derived",
			keyMaterial: "{}",
			coinType: 501,
			accountIndex: 0,
		};

		// Build a mock that handles the pool flow:
		// 1. select from paymentMethods where id=sol -> solMethod
		// 2. select from keyRings where id=sol-main -> keyRing
		// 3. transaction: select from addressPool -> poolEntry, update addressPool, insert derivedAddresses
		let selectCallCount = 0;
		const db = {
			select: vi.fn().mockImplementation(() => ({
				from: vi.fn().mockImplementation(() => {
					selectCallCount++;
					if (selectCallCount === 1) {
						// paymentMethods lookup
						return { where: vi.fn().mockResolvedValue([solMethod]) };
					}
					if (selectCallCount === 2) {
						// keyRings lookup
						return { where: vi.fn().mockResolvedValue([keyRing]) };
					}
					// addressPool query inside transaction
					return {
						where: vi.fn().mockReturnValue({
							orderBy: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([poolEntry]),
							}),
						}),
					};
				}),
			})),
			update: vi.fn().mockReturnValue({
				set: vi.fn().mockReturnValue({
					where: vi.fn().mockResolvedValue(undefined),
				}),
			}),
			insert: vi.fn().mockReturnValue({
				values: vi.fn().mockResolvedValue(undefined),
			}),
			transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db)),
		};

		const deps = mockDeps();
		(deps as unknown as { db: unknown }).db = db;
		const app = createKeyServerApp(deps);

		const res = await app.request("/address", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chain: "sol" }),
		});

		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.address).toBe("SolanaAddr7");
		expect(body.index).toBe(7);
		expect(body.chain).toBe("solana");
		expect(body.token).toBe("SOL");
	});

	it("POST /address throws when pool is empty", async () => {
		const solMethod = {
			id: "sol",
			type: "native",
			token: "SOL",
			chain: "solana",
			xpub: null,
			keyRingId: "sol-main",
			nextIndex: 0,
			decimals: 9,
			addressType: "base58-solana",
			encodingParams: "{}",
			watcherType: "solana",
			oracleAssetId: "solana",
			confirmations: 1,
			pluginId: "solana",
			encoding: "base58-solana",
		};

		const keyRing = {
			id: "sol-main",
			curve: "ed25519",
			derivationScheme: "slip10",
			derivationMode: "pre-derived",
			keyMaterial: "{}",
			coinType: 501,
			accountIndex: 0,
		};

		let selectCallCount = 0;
		const db = {
			select: vi.fn().mockImplementation(() => ({
				from: vi.fn().mockImplementation(() => {
					selectCallCount++;
					if (selectCallCount === 1) {
						return { where: vi.fn().mockResolvedValue([solMethod]) };
					}
					if (selectCallCount === 2) {
						return { where: vi.fn().mockResolvedValue([keyRing]) };
					}
					// Empty pool
					return {
						where: vi.fn().mockReturnValue({
							orderBy: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([]),
							}),
						}),
					};
				}),
			})),
			transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db)),
		};

		const deps = mockDeps();
		(deps as unknown as { db: unknown }).db = db;
		const app = createKeyServerApp(deps);

		const res = await app.request("/address", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chain: "sol" }),
		});

		// Hono catches the thrown error and returns 500
		expect(res.status).toBe(500);
	});
});

describe("key-server auth", () => {
	it("rejects unauthenticated request when serviceKey is set", async () => {
		const deps = mockDeps();
		deps.serviceKey = "sk-test-secret";
		const app = createKeyServerApp(deps);
		const res = await app.request("/address", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chain: "btc" }),
		});
		expect(res.status).toBe(401);
	});

	it("allows authenticated request with correct serviceKey", async () => {
		const deps = mockDeps();
		deps.serviceKey = "sk-test-secret";
		const app = createKeyServerApp(deps);
		const res = await app.request("/address", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer sk-test-secret" },
			body: JSON.stringify({ chain: "btc" }),
		});
		expect(res.status).toBe(201);
	});

	it("rejects admin route without adminToken", async () => {
		const deps = mockDeps();
		// no adminToken set — admin routes disabled
		const app = createKeyServerApp(deps);
		const res = await app.request("/admin/next-path?coin_type=0");
		expect(res.status).toBe(403);
	});

	it("allows admin route with correct adminToken", async () => {
		const deps = mockDeps();
		deps.adminToken = "admin-secret";
		const app = createKeyServerApp(deps);
		const res = await app.request("/admin/next-path?coin_type=0", {
			headers: { Authorization: "Bearer admin-secret" },
		});
		expect(res.status).toBe(200);
	});
});
