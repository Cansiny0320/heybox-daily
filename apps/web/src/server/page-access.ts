import { sessionAuth } from "./session-auth.ts";
import type { Env } from "./env.ts";

export async function pageAccess(
  request: Request,
  env: Env,
  _execution: Pick<ExecutionContext, "waitUntil">,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!["/", "/tasks", "/tasks/", "/history", "/history/"].includes(path)) return null;
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  // Guests must reach the login page even when a local preview has no auth configuration.
  const session =
    request.headers.has("cookie") && env.BETTER_AUTH_SECRET?.length >= 32
      ? await sessionAuth(env)
          .api.getSession({ headers: request.headers })
          .catch(() => null)
      : null;
  if (!session || path === "/")
    return Response.redirect(new URL(session ? "/tasks" : "/login", request.url), 302);
  return null;
}
