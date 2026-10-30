import { betterAuth } from "better-auth";
import { authOptions } from "./auth-options.ts";
import type { Env } from "./env.ts";

const readers = new WeakMap<
  Env["DB"],
  {
    url: string;
    secret: string;
    auth: ReturnType<typeof createReader>;
  }
>();
const createReader = (env: Env) => betterAuth(authOptions(env));

// Reuse configuration only. Better Auth still verifies the cookie and queries D1 on every read.
// No request headers, ExecutionContext, LoginTiming or resolved session is captured here.
export function sessionAuth(env: Env) {
  let reader = readers.get(env.DB);
  if (!reader || reader.url !== env.SITE_URL || reader.secret !== env.BETTER_AUTH_SECRET) {
    reader = { url: env.SITE_URL, secret: env.BETTER_AUTH_SECRET, auth: createReader(env) };
    readers.set(env.DB, reader);
  }
  return reader.auth;
}
