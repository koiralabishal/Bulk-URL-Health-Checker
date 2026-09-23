import { createDb } from "@urlchecker/db";
import { env } from "./env";

export const { pool, db } = createDb(env.DATABASE_URL, 5);