import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
import * as schema from "./schema.js";

export type CryptoDb = ReturnType<typeof drizzle<typeof schema>>;

export function createDb(pool: pg.Pool): CryptoDb {
	return drizzle(pool, { schema });
}

export { schema };
