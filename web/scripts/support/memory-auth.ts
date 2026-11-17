import { randomBytes } from "node:crypto";
import { memoryAdapter } from "better-auth/adapters/memory";
import { getSchema } from "better-auth/db";
import { createAuth } from "../../lib/auth";

export function memoryAuth(
  options: Pick<Parameters<typeof createAuth>[0], "baseURL" | "env" | "send">,
) {
  const tables: Record<string, unknown[]> = {};
  const auth = createAuth({
    ...options,
    database: memoryAdapter(tables),
    secret: randomBytes(48).toString("base64url"),
  });
  for (const model of Object.keys(getSchema(auth.options))) tables[model] = [];
  return auth;
}
