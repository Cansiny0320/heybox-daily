import start from "@tanstack/react-start/server-entry";
import type { Env } from "./server/env.ts";
import { api } from "./server/api.ts";
import { runScheduled } from "./server/schedule.ts";
import { crawlerDocument, shouldNoindex } from "./server/seo.ts";
import { pageAccess } from "./server/page-access.ts";
import { sponsorContent } from "./server/sponsors.ts";
import { LoginTiming, loginTimingHeader } from "@heybox/contracts";

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext) {
    const started = performance.now();
    const timing =
      request.method === "POST" && new URL(request.url).pathname === "/api/auth/heybox/send-code"
        ? new LoginTiming()
        : undefined;
    let response: Response;
    try {
      response =
        crawlerDocument(request, env.DEPLOYMENT_ENV === "staging") ||
        (await sponsorContent(request, env, context)) ||
        (await pageAccess(request, env, context)) ||
        (await api(request, env, context, timing)) ||
        (await start.fetch(request));
    } catch {
      response = Response.json({ message: "服务暂时不可用，请稍后重试" }, { status: 503 });
    }
    const result = new Response(response.body, response);
    if (
      env.DEPLOYMENT_ENV === "staging" ||
      shouldNoindex(new URL(request.url).pathname, response.status)
    )
      result.headers.set("x-robots-tag", "noindex, follow");
    result.headers.set("x-content-type-options", "nosniff");
    result.headers.set("referrer-policy", "same-origin");
    result.headers.set("x-frame-options", "DENY");
    result.headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
    const path = new URL(request.url).pathname;
    const cacheable =
      response.ok &&
      ((path === "/api/stats" && request.method === "GET") ||
        ((path === "/api/sponsors" || path.startsWith("/sponsors/")) &&
          ["GET", "HEAD"].includes(request.method)));
    if (!cacheable) result.headers.set("cache-control", "no-store");
    const durationMs = Math.round((performance.now() - started) * 10) / 10;
    result.headers.set(
      "server-timing",
      [`app;dur=${durationMs}`, timing?.header()].filter(Boolean).join(", "),
    );
    if (timing) {
      result.headers.set(loginTimingHeader, timing.id);
      console.info(
        JSON.stringify({
          event: "auth_sms_timing",
          requestId: timing.id,
          status: result.status,
          durationMs,
          stages: timing.values,
        }),
      );
    }
    return result;
  },
  async scheduled(event: ScheduledController, env: Env, context: ExecutionContext) {
    if (env.DEPLOYMENT_ENV === "staging") return;
    context.waitUntil(runScheduled(env, event.scheduledTime));
  },
};
