import { and, eq } from "drizzle-orm";
import type { CryptoDb } from "../db/index.js";
import { paymentMethods } from "../db/schema.js";

export interface PaymentMethodRecord {
	id: string;
	type: string;
	token: string;
	chain: string;
	contractAddress: string | null;
	decimals: number;
	displayName: string;
	enabled: boolean;
	displayOrder: number;
	iconUrl: string | null;
	rpcUrl: string | null;
	rpcHeaders: string;
	oracleAddress: string | null;
	xpub: string | null;
	addressType: string;
	encodingParams: string;
	watcherType: string;
	oracleAssetId: string | null;
	confirmations: number;
	keyRingId: string | null;
	encoding: string | null;
	pluginId: string | null;
}

export interface IPaymentMethodStore {
	/** List all enabled payment methods, ordered by displayOrder. */
	listEnabled(): Promise<PaymentMethodRecord[]>;
	/** List all payment methods (including disabled). */
	listAll(): Promise<PaymentMethodRecord[]>;
	/** Get a specific payment method by id. */
	getById(id: string): Promise<PaymentMethodRecord | null>;
	/** Get enabled methods by type (stablecoin, eth, btc). */
	listByType(type: string): Promise<PaymentMethodRecord[]>;
	/** Upsert a payment method (admin). */
	upsert(method: PaymentMethodRecord): Promise<void>;
	/** Enable or disable a payment method (admin). */
	setEnabled(id: string, enabled: boolean): Promise<void>;
	/** Partial update of metadata fields (no read-modify-write needed). */
	patchMetadata(
		id: string,
		patch: { iconUrl?: string | null; displayOrder?: number; displayName?: string },
	): Promise<boolean>;
}

export class DrizzlePaymentMethodStore implements IPaymentMethodStore {
	constructor(private readonly db: CryptoDb) {}

	async listEnabled(): Promise<PaymentMethodRecord[]> {
		const rows = await this.db
			.select()
			.from(paymentMethods)
			.where(eq(paymentMethods.enabled, true))
			.orderBy(paymentMethods.displayOrder);
		return rows.map(toRecord);
	}

	async listAll(): Promise<PaymentMethodRecord[]> {
		const rows = await this.db.select().from(paymentMethods).orderBy(paymentMethods.displayOrder);
		return rows.map(toRecord);
	}

	async getById(id: string): Promise<PaymentMethodRecord | null> {
		const row = (await this.db.select().from(paymentMethods).where(eq(paymentMethods.id, id)))[0];
		return row ? toRecord(row) : null;
	}

	async listByType(type: string): Promise<PaymentMethodRecord[]> {
		const rows = await this.db
			.select()
			.from(paymentMethods)
			.where(and(eq(paymentMethods.type, type), eq(paymentMethods.enabled, true)))
			.orderBy(paymentMethods.displayOrder);
		return rows.map(toRecord);
	}

	async upsert(method: PaymentMethodRecord): Promise<void> {
		await this.db
			.insert(paymentMethods)
			.values({
				id: method.id,
				type: method.type,
				token: method.token,
				chain: method.chain,
				contractAddress: method.contractAddress,
				decimals: method.decimals,
				displayName: method.displayName,
				enabled: method.enabled,
				displayOrder: method.displayOrder,
				iconUrl: method.iconUrl,
				rpcUrl: method.rpcUrl,
				rpcHeaders: method.rpcHeaders ?? "{}",
				oracleAddress: method.oracleAddress,
				xpub: method.xpub,
				addressType: method.addressType,
				encodingParams: method.encodingParams,
				watcherType: method.watcherType,
				oracleAssetId: method.oracleAssetId,
				confirmations: method.confirmations,
				keyRingId: method.keyRingId,
				encoding: method.encoding,
				pluginId: method.pluginId,
			})
			.onConflictDoUpdate({
				target: paymentMethods.id,
				set: {
					type: method.type,
					token: method.token,
					chain: method.chain,
					contractAddress: method.contractAddress,
					decimals: method.decimals,
					displayName: method.displayName,
					enabled: method.enabled,
					displayOrder: method.displayOrder,
					iconUrl: method.iconUrl,
					rpcUrl: method.rpcUrl,
					oracleAddress: method.oracleAddress,
					xpub: method.xpub,
					addressType: method.addressType,
					encodingParams: method.encodingParams,
					watcherType: method.watcherType,
					oracleAssetId: method.oracleAssetId,
					confirmations: method.confirmations,
					keyRingId: method.keyRingId,
					encoding: method.encoding,
					pluginId: method.pluginId,
				},
			});
	}

	async setEnabled(id: string, enabled: boolean): Promise<void> {
		await this.db.update(paymentMethods).set({ enabled }).where(eq(paymentMethods.id, id));
	}

	async patchMetadata(
		id: string,
		patch: { iconUrl?: string | null; displayOrder?: number; displayName?: string },
	): Promise<boolean> {
		const set: Record<string, unknown> = {};
		if (patch.iconUrl !== undefined) set.iconUrl = patch.iconUrl;
		if (patch.displayOrder !== undefined) set.displayOrder = patch.displayOrder;
		if (patch.displayName !== undefined) set.displayName = patch.displayName;
		if (Object.keys(set).length === 0) return false;
		const result = (await this.db.update(paymentMethods).set(set).where(eq(paymentMethods.id, id))) as {
			rowCount: number;
		};
		return result.rowCount > 0;
	}
}

function toRecord(row: typeof paymentMethods.$inferSelect): PaymentMethodRecord {
	return {
		id: row.id,
		type: row.type,
		token: row.token,
		chain: row.chain,
		contractAddress: row.contractAddress,
		decimals: row.decimals,
		displayName: row.displayName,
		enabled: row.enabled,
		displayOrder: row.displayOrder,
		iconUrl: row.iconUrl,
		rpcUrl: row.rpcUrl,
		rpcHeaders: row.rpcHeaders ?? "{}",
		oracleAddress: row.oracleAddress,
		xpub: row.xpub,
		addressType: row.addressType,
		encodingParams: row.encodingParams,
		watcherType: row.watcherType,
		oracleAssetId: row.oracleAssetId,
		confirmations: row.confirmations,
		keyRingId: row.keyRingId,
		encoding: row.encoding,
		pluginId: row.pluginId,
	};
}
