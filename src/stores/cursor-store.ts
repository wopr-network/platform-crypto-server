import { and, eq, sql } from "drizzle-orm";
import type { CryptoDb } from "../db/index.js";
import { watcherCursors, watcherProcessed } from "../db/schema.js";

export interface IWatcherCursorStore {
	/** Get persisted block cursor for a watcher. */
	get(watcherId: string): Promise<number | null>;
	/** Save block cursor after processing a range. */
	save(watcherId: string, cursorBlock: number): Promise<void>;
	/** Check if a specific tx has been fully processed (reached confirmation threshold). */
	hasProcessedTx(watcherId: string, txId: string): Promise<boolean>;
	/** Mark a tx as fully processed (reached confirmation threshold). */
	markProcessedTx(watcherId: string, txId: string): Promise<void>;
	/** Get the last-seen confirmation count for a tx (for intermediate confirmation tracking). */
	getConfirmationCount(watcherId: string, txId: string): Promise<number | null>;
	/** Save the current confirmation count for a tx (for intermediate confirmation tracking). */
	saveConfirmationCount(watcherId: string, txId: string, count: number): Promise<void>;
}

/**
 * Persists watcher state to PostgreSQL.
 *
 * Three patterns:
 *   - Block cursor (EVM watchers): save/get cursor block number
 *   - Processed txids (BTC watcher): hasProcessedTx/markProcessedTx
 *   - Confirmation counts (all watchers): getConfirmationCount/saveConfirmationCount
 *
 * Eliminates all in-memory watcher state. Clean restart recovery.
 */
export class DrizzleWatcherCursorStore implements IWatcherCursorStore {
	constructor(private readonly db: CryptoDb) {}

	async get(watcherId: string): Promise<number | null> {
		const row = (
			await this.db
				.select({ cursorBlock: watcherCursors.cursorBlock })
				.from(watcherCursors)
				.where(eq(watcherCursors.watcherId, watcherId))
		)[0];
		return row?.cursorBlock ?? null;
	}

	async save(watcherId: string, cursorBlock: number): Promise<void> {
		await this.db
			.insert(watcherCursors)
			.values({ watcherId, cursorBlock })
			.onConflictDoUpdate({
				target: watcherCursors.watcherId,
				set: { cursorBlock, updatedAt: sql`(now())` },
			});
	}

	async hasProcessedTx(watcherId: string, txId: string): Promise<boolean> {
		const row = (
			await this.db
				.select({ txId: watcherProcessed.txId })
				.from(watcherProcessed)
				.where(and(eq(watcherProcessed.watcherId, watcherId), eq(watcherProcessed.txId, txId)))
		)[0];
		return row !== undefined;
	}

	async markProcessedTx(watcherId: string, txId: string): Promise<void> {
		await this.db.insert(watcherProcessed).values({ watcherId, txId }).onConflictDoNothing();
	}

	async getConfirmationCount(watcherId: string, txId: string): Promise<number | null> {
		// Store confirmation counts as synthetic cursor entries: "watcherId:conf:txId" -> count
		const key = `${watcherId}:conf:${txId}`;
		const row = (
			await this.db
				.select({ cursorBlock: watcherCursors.cursorBlock })
				.from(watcherCursors)
				.where(eq(watcherCursors.watcherId, key))
		)[0];
		return row?.cursorBlock ?? null;
	}

	async saveConfirmationCount(watcherId: string, txId: string, count: number): Promise<void> {
		const key = `${watcherId}:conf:${txId}`;
		await this.db
			.insert(watcherCursors)
			.values({ watcherId: key, cursorBlock: count })
			.onConflictDoUpdate({
				target: watcherCursors.watcherId,
				set: { cursorBlock: count, updatedAt: sql`(now())` },
			});
	}
}
