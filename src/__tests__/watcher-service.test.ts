import { describe, expect, it, vi } from "vitest";
import { handlePayment } from "../watchers/watcher-service.js";

function mockChargeStore(overrides: Record<string, unknown> = {}) {
	return {
		getByDepositAddress: vi.fn().mockResolvedValue({
			referenceId: "btc:test",
			tenantId: "t1",
			amountUsdCents: 5000,
			creditedAt: null,
			chain: "bitcoin",
			depositAddress: "bc1qtest",
			token: "BTC",
			callbackUrl: "https://example.com/hook",
			expectedAmount: "50000",
			receivedAmount: "0",
			confirmations: 0,
			confirmationsRequired: 6,
			...overrides,
		}),
		updateProgress: vi.fn().mockResolvedValue(undefined),
		updateStatus: vi.fn().mockResolvedValue(undefined),
		markCredited: vi.fn().mockResolvedValue(undefined),
	};
}

function mockDb() {
	return {
		insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
		update: vi.fn().mockReturnValue({
			set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
		}),
	};
}

const noop = () => {};

describe("handlePayment", () => {
	it("fires webhook with confirmations: 0 on first tx detection", async () => {
		const chargeStore = mockChargeStore();
		const db = mockDb();
		const enqueuedPayloads: Record<string, unknown>[] = [];
		db.insert = vi.fn().mockReturnValue({
			values: vi.fn().mockImplementation((val: Record<string, unknown>) => {
				if (val.payload) enqueuedPayloads.push(JSON.parse(val.payload as string));
				return Promise.resolve(undefined);
			}),
		});

		await handlePayment(
			db as never,
			chargeStore as never,
			"bc1qtest",
			"50000",
			{
				txHash: "abc123",
				confirmations: 0,
				confirmationsRequired: 6,
				amountReceivedCents: 5000,
			},
			noop,
		);

		expect(enqueuedPayloads).toHaveLength(1);
		expect(enqueuedPayloads[0]).toMatchObject({
			chargeId: "btc:test",
			status: "partial",
			confirmations: 0,
			confirmationsRequired: 6,
		});
	});

	it("fires webhook on each confirmation increment", async () => {
		const chargeStore = mockChargeStore({ confirmations: 2 });
		const db = mockDb();
		const enqueuedPayloads: Record<string, unknown>[] = [];
		db.insert = vi.fn().mockReturnValue({
			values: vi.fn().mockImplementation((val: Record<string, unknown>) => {
				if (val.payload) enqueuedPayloads.push(JSON.parse(val.payload as string));
				return Promise.resolve(undefined);
			}),
		});

		await handlePayment(
			db as never,
			chargeStore as never,
			"bc1qtest",
			"0", // no additional payment, just confirmation update
			{
				txHash: "abc123",
				confirmations: 3,
				confirmationsRequired: 6,
				amountReceivedCents: 5000,
			},
			noop,
		);

		expect(enqueuedPayloads).toHaveLength(1);
		expect(enqueuedPayloads[0]).toMatchObject({
			status: "partial",
			confirmations: 3,
			confirmationsRequired: 6,
		});
	});

	it("fires final webhook with status confirmed at threshold", async () => {
		const chargeStore = mockChargeStore({
			receivedAmount: "50000",
			confirmations: 5,
		});
		const db = mockDb();
		const enqueuedPayloads: Record<string, unknown>[] = [];
		db.insert = vi.fn().mockReturnValue({
			values: vi.fn().mockImplementation((val: Record<string, unknown>) => {
				if (val.payload) enqueuedPayloads.push(JSON.parse(val.payload as string));
				return Promise.resolve(undefined);
			}),
		});

		await handlePayment(
			db as never,
			chargeStore as never,
			"bc1qtest",
			"0",
			{
				txHash: "abc123",
				confirmations: 6,
				confirmationsRequired: 6,
				amountReceivedCents: 5000,
			},
			noop,
		);

		expect(enqueuedPayloads).toHaveLength(1);
		expect(enqueuedPayloads[0]).toMatchObject({
			status: "confirmed",
			confirmations: 6,
			confirmationsRequired: 6,
		});
		expect(chargeStore.markCredited).toHaveBeenCalledOnce();
	});

	it("all webhooks use canonical status values only", async () => {
		const chargeStore = mockChargeStore();
		const db = mockDb();
		const enqueuedPayloads: Record<string, unknown>[] = [];
		db.insert = vi.fn().mockReturnValue({
			values: vi.fn().mockImplementation((val: Record<string, unknown>) => {
				if (val.payload) enqueuedPayloads.push(JSON.parse(val.payload as string));
				return Promise.resolve(undefined);
			}),
		});

		await handlePayment(
			db as never,
			chargeStore as never,
			"bc1qtest",
			"50000",
			{
				txHash: "abc123",
				confirmations: 0,
				confirmationsRequired: 6,
				amountReceivedCents: 5000,
			},
			noop,
		);

		const validStatuses = ["pending", "partial", "confirmed", "expired", "failed"];
		for (const payload of enqueuedPayloads) {
			expect(validStatuses).toContain(payload.status);
		}
		// Must NEVER contain legacy statuses
		for (const payload of enqueuedPayloads) {
			expect(payload.status).not.toBe("Settled");
			expect(payload.status).not.toBe("Processing");
			expect(payload.status).not.toBe("New");
		}
	});

	it("updates charge progress via updateProgress()", async () => {
		const chargeStore = mockChargeStore();
		const db = mockDb();
		db.insert = vi.fn().mockReturnValue({
			values: vi.fn().mockResolvedValue(undefined),
		});

		await handlePayment(
			db as never,
			chargeStore as never,
			"bc1qtest",
			"25000",
			{
				txHash: "abc123",
				confirmations: 2,
				confirmationsRequired: 6,
				amountReceivedCents: 2500,
			},
			noop,
		);

		expect(chargeStore.updateProgress).toHaveBeenCalledWith("btc:test", {
			status: "partial",
			amountReceivedCents: 2500,
			confirmations: 2,
			confirmationsRequired: 6,
			txHash: "abc123",
		});
	});

	it("skips already-credited charges", async () => {
		const chargeStore = mockChargeStore({ creditedAt: "2026-01-01" });
		const db = mockDb();

		await handlePayment(
			db as never,
			chargeStore as never,
			"bc1qtest",
			"50000",
			{ txHash: "abc123", confirmations: 6, confirmationsRequired: 6, amountReceivedCents: 5000 },
			noop,
		);

		expect(chargeStore.updateProgress).not.toHaveBeenCalled();
	});

	it("skips unknown addresses", async () => {
		const chargeStore = mockChargeStore();
		chargeStore.getByDepositAddress.mockResolvedValue(null);
		const db = mockDb();

		await handlePayment(
			db as never,
			chargeStore as never,
			"bc1qunknown",
			"50000",
			{ txHash: "abc123", confirmations: 0, confirmationsRequired: 6, amountReceivedCents: 5000 },
			noop,
		);

		expect(chargeStore.updateProgress).not.toHaveBeenCalled();
	});
});
