import type { Env } from "./env.ts";
import { sponsorAvatarPath, sponsorsSchema } from "../lib/sponsors.ts";

export async function sponsorContent(
  request: Request,
  env: Env,
  execution: Pick<ExecutionContext, "waitUntil">,
  cache: Pick<Cache, "match" | "put"> = (caches as CacheStorage & { default: Cache }).default,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/sponsors" && !url.pathname.startsWith("/sponsors/")) return null;
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });

  if (url.pathname === "/api/sponsors") {
    const key = new Request(new URL(url.pathname, url.origin));
    const cached = await cache.match(key).catch(() => undefined);
    if (cached) {
      const response = new Response(request.method === "HEAD" ? null : cached.body, cached);
      response.headers.set("Cache-Control", "public, max-age=60");
      return response;
    }
    let sponsors = [] as ReturnType<typeof sponsorsSchema.parse>;
    let valid = false;
    try {
      sponsors = sponsorsSchema.parse((await env.SITE_CONFIG?.get("sponsors", "json")) ?? []);
      valid = !!env.SITE_CONFIG;
    } catch {
      console.error("Unable to read valid sponsor configuration from KV");
    }
    const response = Response.json(sponsors, {
      headers: { "Cache-Control": valid ? "public, max-age=60" : "no-store" },
    });
    if (valid) execution.waitUntil(cache.put(key, response.clone()).catch(() => {}));
    return request.method === "HEAD" ? new Response(null, response) : response;
  }

  if (!sponsorAvatarPath.test(url.pathname) || !env.SPONSOR_ASSETS)
    return new Response(null, { status: 404 });

  // Ignore cookies and query strings so all visitors share the same cached avatar.
  const key = new Request(new URL(url.pathname, url.origin));
  const cached = await cache.match(key).catch(() => undefined);
  if (cached) {
    const response = new Response(request.method === "HEAD" ? null : cached.body, cached);
    response.headers.set("Cache-Control", "public, max-age=3600");
    return response;
  }

  try {
    const object = await env.SPONSOR_ASSETS.get(url.pathname.slice(1));
    if (!object) return new Response(null, { status: 404 });
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("ETag", object.httpEtag);
    headers.set("Content-Length", String(object.size));
    headers.set("Cache-Control", "public, max-age=3600");
    const response = new Response(object.body, { headers });
    execution.waitUntil(cache.put(key, response.clone()).catch(() => {}));
    return request.method === "HEAD" ? new Response(null, response) : response;
  } catch {
    console.error("Unable to read sponsor avatar from R2");
    return new Response(null, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
