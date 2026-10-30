import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema.ts";
import type { Env } from "./env.ts";

// Login and read-only session lookup must use identical signing, expiry and cookie rules.
export function authOptions(env: Env) {
  return {
    appName: "Heybox Daily",
    baseURL: env.SITE_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(drizzle(env.DB), { provider: "sqlite", schema }),
    trustedOrigins: [new URL(env.SITE_URL).origin],
    session: { expiresIn: 30 * 86400, updateAge: 86400, cookieCache: { enabled: false } },
    advanced: {
      useSecureCookies: env.SITE_URL.startsWith("https:"),
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax" as const },
    },
    logger: { disabled: true },
  };
}
