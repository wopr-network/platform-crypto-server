import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { CryptoDb } from "../db/index.js";
import { cryptoCharges } from "../db/schema.js";
import type { CryptoCharge, CryptoChargeStatus, CryptoPaymentState } from "../types.js";

export interface CryptoChargeRecord {
	referenceId: string;
	tenantId: string;
	amountUsdCents: number;
	status: string;
	currency: string | null;
	filledAmount: string | null;
	creditedAt: string | null;
	createdAt: string;
	updatedAt: string;
	chain: string | null;
	token: string | null;
	depositAddress: string | null;
	derivationIndex: number | null;
	callbackUrl: string | null;
	expectedAmount: string | null;
	receivedAmount: string | null;
	confirmations: number;
	confirmationsRequired: number;
	txHash: string | null;
	amountReceivedCents: number;
}

export interface CryptoDepositChargeInput {
	referenceId: string;
	tenantId: string;
	amountUsdCents: number;
	chain: string;
	token: string;
	depositAddress: string;
	derivationIndex: number;
	callbackUrl?: string;
	/** Expected crypto amount in native base units (sats for BTC, base units for ERC20). */
	expectedAmount?: string;
}

export interface CryptoChargeProgressUpdate {
	status: CryptoChargeStatus;
	amountReceivedCents: number;
	confirmations: number;
	confirmationsRequired: number;
	txHash?: string;
}

export interface ICryptoChargeRepository {
	create(referenceId: string, tenantId: string, amountUsdCents: number): Promise<void>;
	getByReferenceId(referenceId: string): Promise<CryptoChargeRecord | null>;
	/** @deprecated Use updateProgress() instead. Kept for one release cycle. */
	updateStatus(
		referenceId: string,
		status: CryptoPaymentState,
		currency?: string,
		filledAmount?: string,
	): Promise<void>;
	/** Update partial payment progress, confirmations, and tx hash. */
	updateProgress(referenceId: string, update: CryptoChargeProgressUpdate): Promise<void>;
	/** Get a charge as a UI-facing CryptoCharge with all progress fields. */
	get(referenceId: string): Promise<CryptoCharge | null>;
	markCredited(referenceId: string): Promise<void>;
	isCredited(referenceId: string): Promise<boolean>;
	createStablecoinCharge(input: CryptoDepositChargeInput): Promise<void>;
	getByDepositAddress(address: string): Promise<CryptoChargeRecord | null>;
	getNextDerivationIndex(): Promise<number>;
	/** List deposit addresses with pending (uncredited) charges, grouped by chain. */
	listActiveDepositAddresses(): Promise<{ chain: string; address: string; token: string }[]>;
}

/**
 * Manages crypto charge records in PostgreSQL.
 *
 * Each charge maps a deposit address to a tenant and tracks
 * the payment lifecycle (New → Processing → Settled/Expired/Invalid).
 *
 * amountUsdCents stores the requested amount in USD cents (integer).
 * This is NOT nanodollars — Credit.fromCents() handles the conversion
 * when crediting the ledger in the webhook handler.
 */
export class DrizzleCryptoChargeRepository implements ICryptoChargeRepository {
	constructor(private readonly db: CryptoDb) {}

	/** Create a new charge record when an invoice is created. */
	async create(referenceId: string, tenantId: string, amountUsdCents: number): Promise<void> {
		await this.db.insert(cryptoCharges).values({
			referenceId,
			tenantId,
			amountUsdCents,
			status: "New",
		});
	}

	/** Get a charge by reference ID. Returns null if not found. */
	async getByReferenceId(referenceId: string): Promise<CryptoChargeRecord | null> {
		const row = (await this.db.select().from(cryptoCharges).where(eq(cryptoCharges.referenceId, referenceId)))[0];
		if (!row) return null;
		return this.toRecord(row);
	}

	private toRecord(row: typeof cryptoCharges.$inferSelect): CryptoChargeRecord {
		return {
			referenceId: row.referenceId,
			tenantId: row.tenantId,
			amountUsdCents: row.amountUsdCents,
			status: row.status,
			currency: row.currency ?? null,
			filledAmount: row.filledAmount ?? null,
			creditedAt: row.creditedAt ?? null,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
			chain: row.chain ?? null,
			token: row.token ?? null,
			depositAddress: row.depositAddress ?? null,
			derivationIndex: row.derivationIndex ?? null,
			callbackUrl: row.callbackUrl ?? null,
			expectedAmount: row.expectedAmount ?? null,
			receivedAmount: row.receivedAmount ?? null,
			confirmations: row.confirmations,
			confirmationsRequired: row.confirmationsRequired,
			txHash: row.txHash ?? null,
			amountReceivedCents: row.amountReceivedCents,
		};
	}

	/** Map DB status strings to CryptoChargeStatus for UI consumption. */
	private mapStatus(dbStatus: string, credited: boolean): CryptoChargeStatus {
		if (credited) return "confirmed";
		switch (dbStatus) {
			case "New":
				return "pending";
			case "Processing":
				return "partial";
			case "Settled":
				return "confirmed";
			case "Expired":
				return "expired";
			case "Invalid":
				return "failed";
			default:
				return "pending";
		}
	}

	/** Get a charge as a UI-facing CryptoCharge with all progress fields. */
	async get(referenceId: string): Promise<CryptoCharge | null> {
		const row = (await this.db.select().from(cryptoCharges).where(eq(cryptoCharges.referenceId, referenceId)))[0];
		if (!row) return null;
		return {
			id: row.referenceId,
			tenantId: row.tenantId,
			chain: row.chain ?? "unknown",
			status: this.mapStatus(row.status, row.creditedAt != null),
			amountExpectedCents: row.amountUsdCents,
			amountReceivedCents: row.amountReceivedCents,
			confirmations: row.confirmations,
			confirmationsRequired: row.confirmationsRequired,
			txHash: row.txHash ?? undefined,
			credited: row.creditedAt != null,
			createdAt: new Date(row.createdAt),
		};
	}

	/** Update partial payment progress, confirmations, and tx hash. */
	async updateProgress(referenceId: string, update: CryptoChargeProgressUpdate): Promise<void> {
		const statusMap: Record<CryptoChargeStatus, string> = {
			pending: "New",
			partial: "Processing",
			confirmed: "Settled",
			expired: "Expired",
			failed: "Invalid",
		};
		await this.db
			.update(cryptoCharges)
			.set({
				status: statusMap[update.status],
				amountReceivedCents: update.amountReceivedCents,
				confirmations: update.confirmations,
				confirmationsRequired: update.confirmationsRequired,
				txHash: update.txHash,
				updatedAt: sql`now()`,
			})
			.where(eq(cryptoCharges.referenceId, referenceId));
	}

	/**
	 * @deprecated Use updateProgress() instead. Kept for one release cycle.
	 * Update charge status and payment details from webhook.
	 */
	async updateStatus(
		referenceId: string,
		status: CryptoPaymentState,
		currency?: string,
		filledAmount?: string,
	): Promise<void> {
		await this.db
			.update(cryptoCharges)
			.set({
				status,
				currency,
				filledAmount,
				updatedAt: sql`now()`,
			})
			.where(eq(cryptoCharges.referenceId, referenceId));
	}

	/** Mark a charge as credited (idempotency flag). */
	async markCredited(referenceId: string): Promise<void> {
		await this.db
			.update(cryptoCharges)
			.set({
				creditedAt: sql`now()`,
				updatedAt: sql`now()`,
			})
			.where(eq(cryptoCharges.referenceId, referenceId));
	}

	/** Check if a charge has already been credited (for idempotency). */
	async isCredited(referenceId: string): Promise<boolean> {
		const row = (
			await this.db
				.select({ creditedAt: cryptoCharges.creditedAt })
				.from(cryptoCharges)
				.where(eq(cryptoCharges.referenceId, referenceId))
		)[0];
		return row?.creditedAt != null;
	}

	/** Create a stablecoin charge with chain/token/deposit address. */
	async createStablecoinCharge(input: CryptoDepositChargeInput): Promise<void> {
		await this.db.insert(cryptoCharges).values({
			referenceId: input.referenceId,
			tenantId: input.tenantId,
			amountUsdCents: input.amountUsdCents,
			status: "New",
			chain: input.chain,
			token: input.token,
			depositAddress: input.depositAddress.toLowerCase(),
			derivationIndex: input.derivationIndex,
			callbackUrl: input.callbackUrl,
			expectedAmount: input.expectedAmount,
			receivedAmount: "0",
		});
	}

	/** Look up a charge by its deposit address. */
	async getByDepositAddress(address: string): Promise<CryptoChargeRecord | null> {
		const row = (
			await this.db.select().from(cryptoCharges).where(eq(cryptoCharges.depositAddress, address.toLowerCase()))
		)[0];
		if (!row) return null;
		return this.toRecord(row);
	}

	/** List deposit addresses with pending (uncredited) charges. */
	async listActiveDepositAddresses(): Promise<{ chain: string; address: string; token: string }[]> {
		const rows = await this.db
			.select({
				chain: cryptoCharges.chain,
				address: cryptoCharges.depositAddress,
				token: cryptoCharges.token,
			})
			.from(cryptoCharges)
			.where(
				and(isNull(cryptoCharges.creditedAt), isNotNull(cryptoCharges.depositAddress), isNotNull(cryptoCharges.chain)),
			);
		return rows.filter(
			(r): r is { chain: string; address: string; token: string } =>
				r.chain !== null && r.address !== null && r.token !== null,
		);
	}

	/** Get the next available HD derivation index (max + 1, or 0 if empty). */
	async getNextDerivationIndex(): Promise<number> {
		const result = await this.db
			.select({ maxIdx: sql<number>`coalesce(max(${cryptoCharges.derivationIndex}), -1)` })
			.from(cryptoCharges);
		return (result[0]?.maxIdx ?? -1) + 1;
	}
}

export { DrizzleCryptoChargeRepository as CryptoChargeRepository };
