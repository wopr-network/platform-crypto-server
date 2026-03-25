-- Baseline migration for platform-crypto-server.
-- Uses CREATE TABLE IF NOT EXISTS so this is a no-op on existing production DBs
-- but sets up fresh databases from scratch.

-- 1. crypto_charges
CREATE TABLE IF NOT EXISTS "crypto_charges" (
  "reference_id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL,
  "amount_usd_cents" integer NOT NULL,
  "status" text DEFAULT 'New' NOT NULL,
  "currency" text,
  "filled_amount" text,
  "created_at" text DEFAULT (now()) NOT NULL,
  "updated_at" text DEFAULT (now()) NOT NULL,
  "credited_at" text,
  "chain" text,
  "token" text,
  "deposit_address" text,
  "derivation_index" integer,
  "callback_url" text,
  "expected_amount" text,
  "received_amount" text,
  "confirmations" integer DEFAULT 0 NOT NULL,
  "confirmations_required" integer DEFAULT 1 NOT NULL,
  "tx_hash" text,
  "amount_received_cents" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_crypto_charges_tenant" ON "crypto_charges" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_crypto_charges_status" ON "crypto_charges" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_crypto_charges_created" ON "crypto_charges" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_crypto_charges_deposit_address" ON "crypto_charges" USING btree ("deposit_address");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_crypto_charges_deposit_address" ON "crypto_charges" ("deposit_address") WHERE "deposit_address" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_crypto_charges_chain_derivation" ON "crypto_charges" ("chain", "derivation_index") WHERE "chain" IS NOT NULL AND "derivation_index" IS NOT NULL;
--> statement-breakpoint

-- 2. watcher_cursors
CREATE TABLE IF NOT EXISTS "watcher_cursors" (
  "watcher_id" text PRIMARY KEY NOT NULL,
  "cursor_block" integer NOT NULL,
  "updated_at" text DEFAULT (now()) NOT NULL
);
--> statement-breakpoint

-- 3. payment_methods
CREATE TABLE IF NOT EXISTS "payment_methods" (
  "id" text PRIMARY KEY NOT NULL,
  "type" text NOT NULL,
  "token" text NOT NULL,
  "chain" text NOT NULL,
  "network" text DEFAULT 'mainnet' NOT NULL,
  "contract_address" text,
  "decimals" integer NOT NULL,
  "display_name" text NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "display_order" integer DEFAULT 0 NOT NULL,
  "icon_url" text,
  "rpc_url" text,
  "rpc_headers" text DEFAULT '{}' NOT NULL,
  "oracle_address" text,
  "xpub" text,
  "address_type" text DEFAULT 'evm' NOT NULL,
  "encoding_params" text DEFAULT '{}' NOT NULL,
  "watcher_type" text DEFAULT 'evm' NOT NULL,
  "oracle_asset_id" text,
  "confirmations" integer DEFAULT 1 NOT NULL,
  "next_index" integer DEFAULT 0 NOT NULL,
  "key_ring_id" text,
  "encoding" text,
  "plugin_id" text,
  "created_at" text DEFAULT (now()) NOT NULL
);
--> statement-breakpoint

-- 4. path_allocations
CREATE TABLE IF NOT EXISTS "path_allocations" (
  "coin_type" integer NOT NULL,
  "account_index" integer NOT NULL,
  "chain_id" text REFERENCES "payment_methods"("id"),
  "xpub" text NOT NULL,
  "allocated_at" text DEFAULT (now()) NOT NULL,
  CONSTRAINT "path_allocations_pkey" PRIMARY KEY ("coin_type", "account_index")
);
--> statement-breakpoint

-- 5. webhook_deliveries
CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "charge_id" text NOT NULL,
  "callback_url" text NOT NULL,
  "payload" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_retry_at" text,
  "last_error" text,
  "created_at" text DEFAULT (now()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_webhook_deliveries_status" ON "webhook_deliveries" ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_webhook_deliveries_charge" ON "webhook_deliveries" ("charge_id");
--> statement-breakpoint

-- 6. derived_addresses
CREATE TABLE IF NOT EXISTS "derived_addresses" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "chain_id" text NOT NULL REFERENCES "payment_methods"("id"),
  "derivation_index" integer NOT NULL,
  "address" text NOT NULL UNIQUE,
  "tenant_id" text,
  "created_at" text DEFAULT (now()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_derived_addresses_chain" ON "derived_addresses" ("chain_id");
--> statement-breakpoint

-- 7. watcher_processed
CREATE TABLE IF NOT EXISTS "watcher_processed" (
  "watcher_id" text NOT NULL,
  "tx_id" text NOT NULL,
  "processed_at" text DEFAULT (now()) NOT NULL,
  CONSTRAINT "watcher_processed_watcher_id_tx_id_pk" PRIMARY KEY ("watcher_id", "tx_id")
);
--> statement-breakpoint

-- 8. key_rings
CREATE TABLE IF NOT EXISTS "key_rings" (
  "id" text PRIMARY KEY,
  "curve" text NOT NULL,
  "derivation_scheme" text NOT NULL,
  "derivation_mode" text DEFAULT 'on-demand' NOT NULL,
  "key_material" text DEFAULT '{}' NOT NULL,
  "coin_type" integer NOT NULL,
  "account_index" integer DEFAULT 0 NOT NULL,
  "created_at" text DEFAULT (now()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "key_rings_path_unique" ON "key_rings" ("coin_type", "account_index");
--> statement-breakpoint

-- 9. address_pool
CREATE TABLE IF NOT EXISTS "address_pool" (
  "id" serial PRIMARY KEY,
  "key_ring_id" text NOT NULL REFERENCES "key_rings"("id"),
  "derivation_index" integer NOT NULL,
  "public_key" text NOT NULL,
  "address" text NOT NULL,
  "assigned_to" text,
  "created_at" text DEFAULT (now()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "address_pool_ring_index" ON "address_pool" ("key_ring_id", "derivation_index");
--> statement-breakpoint

-- FK: payment_methods.key_ring_id -> key_rings.id
-- Added as ALTER since key_rings is created after payment_methods
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'payment_methods_key_ring_id_key_rings_id_fk'
    AND table_name = 'payment_methods'
  ) THEN
    ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_key_ring_id_key_rings_id_fk"
      FOREIGN KEY ("key_ring_id") REFERENCES "key_rings"("id");
  END IF;
END $$;
