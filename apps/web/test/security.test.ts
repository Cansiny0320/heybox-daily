import { runnerRequest } from "../src/server/security.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { boundedBody, privateKey, sameOrigin, serviceAuthorized } from "@heybox/hosting/security";
import type { Env } from "../src/server/env.ts";
import { authRequest } from "../src/lib/auth-client.ts";
import { LoginFailure, LoginTiming, loginTimingHeader } from "@heybox/contracts";
import type { SmsCooldown } from "../src/lib/login-cooldown.ts";

test("new operations use the private Worker binding while existing challenges retain their original backend", async (t) => {
  let bound = 0;
  let legacy = 0;
  t.mock.method(globalThis, "fetch", async () => {
    legacy++;
    return Response.json({ backend: "legacy" });
  });
  const env = {
    RUNNER_URL: "https://runner.invalid",
    RUNNER_SERVICE_TOKEN: "a".repeat(64),
    EXECUTOR_ENABLED: "true",
    EXECUTOR: {
      fetch: async (input: string, init: RequestInit) => {
        bound++;
        assert.equal(new URL(input).pathname, "/login/verify");
        assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${"a".repeat(64)}`);
        return Response.json({ backend: "cloudflare" });
      },
    },
  } as unknown as Env;
  assert.deepEqual(await runnerRequest(env, "/login/verify", {}, "legacy"), { backend: "legacy" });
  assert.deepEqual(await runnerRequest(env, "/login/verify", {}, "cloudflare"), {
    backend: "cloudflare",
  });
  assert.deepEqual(await runnerRequest(env, "/login/verify", {}), { backend: "cloudflare" });
  assert.equal(bound, 2);
  assert.equal(legacy, 1);
  await assert.rejects(runnerRequest({ ...env, EXECUTOR: undefined }, "/login/verify", {}), /绑定/);
  assert.equal(legacy, 1, "missing binding cannot silently fall back to the wrong login state");
});

test("service calls use Workers-compatible manual redirects and never follow them with credentials", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    assert.equal(init?.redirect, "manual");
    return new Response(null, { status: 302, headers: { location: "https://other.invalid/" } });
  };
  try {
    await assert.rejects(
      runnerRequest(
        { RUNNER_URL: "https://runner.invalid", RUNNER_SERVICE_TOKEN: "test" } as Env,
        "/login/begin",
        {},
      ),
      /HTTP 302/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
test("login transport correlates and collects downstream timing even when the upstream rejects the request", async () => {
  const timing = new LoginTiming();
  const env = {
    EXECUTOR_ENABLED: "true",
    RUNNER_SERVICE_TOKEN: "a".repeat(64),
    EXECUTOR: {
      fetch: async (_url: string, init: RequestInit) => {
        assert.equal(new Headers(init.headers).get(loginTimingHeader), timing.id);
        return Response.json(
          { code: "upstream_rate_limit", error: "private message" },
          {
            status: 400,
            headers: { "server-timing": "sms_upstream;dur=123.4, unknown;dur=50" },
          },
        );
      },
    },
  } as unknown as Env;
  await assert.rejects(runnerRequest(env, "/login/begin", {}, undefined, timing), LoginFailure);
  assert.equal(timing.values.sms_upstream, 123.4);
  assert.ok(timing.values.executor! >= 0);
  assert.ok(!timing.header().includes("unknown"));
});
test("service token, same-origin checks and hashed quotas do not trust user input", async () => {
  const token = "a".repeat(64);
  assert.equal(
    await serviceAuthorized(
      new Request("https://site.invalid", { headers: { authorization: `Bearer ${token}` } }),
      token,
    ),
    true,
  );
  assert.equal(await serviceAuthorized(new Request("https://site.invalid"), token), false);
  assert.equal(
    sameOrigin(
      new Request("https://site.invalid", { headers: { origin: "https://attacker.invalid" } }),
      "https://site.invalid",
    ),
    false,
  );
  assert.equal(sameOrigin(new Request("https://site.invalid"), "https://site.invalid"), false);
  const hashed = await privateKey("phone:13800138000", token);
  assert.equal(hashed.length, 64);
  assert.ok(!hashed.includes("13800138000"));
  assert.notEqual(hashed, await privateKey("phone:13800138000", "b".repeat(64)));
});
test("body limits apply to actual bytes even when Content-Length is absent", async () => {
  assert.equal(
    new TextDecoder().decode(
      await boundedBody(
        new Request("https://site.invalid", { method: "POST", body: '{"ok":true}' }),
      ),
    ),
    '{"ok":true}',
  );
  const body = await boundedBody(
    new Request("https://site.invalid", {
      method: "POST",
      body: new TextEncoder().encode('{"json":{}}'),
    }),
  );
  const forwarded = new Request("https://site.invalid", { method: "POST", body });
  assert.equal(forwarded.headers.get("content-type"), null);
  assert.deepEqual(await forwarded.json(), { json: {} });
  await assert.rejects(
    boundedBody(new Request("https://site.invalid", { method: "POST", body: "字".repeat(2000) })),
    /请求过大/,
  );
});

test("runner human-challenge errors keep their safe code instead of becoming a gateway failure", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ code: "captcha_required", error: "private-provider-details" }, { status: 400 });
  try {
    await assert.rejects(
      runnerRequest(
        { RUNNER_URL: "https://runner.invalid", RUNNER_SERVICE_TOKEN: "test" } as Env,
        "/login/begin",
        {},
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { code: string }).code, "captcha_required");
        assert.match(error.message, /人机验证/);
        assert.ok(!error.message.includes("private-provider-details"));
        return true;
      },
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("upstream throttling keeps an actionable message without leaking provider details", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      { code: "upstream_rate_limit", error: "private-provider-details" },
      { status: 400 },
    ),
  );
  await assert.rejects(
    runnerRequest(
      { RUNNER_URL: "https://runner.invalid", RUNNER_SERVICE_TOKEN: "test" } as Env,
      "/login/captcha",
      {},
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { code: string }).code, "upstream_rate_limit");
      assert.match(error.message, /小黑盒.*频繁.*稍后/);
      assert.ok(!error.message.includes("人机验证"));
      assert.ok(!error.message.includes("private-provider-details"));
      return true;
    },
  );
});

test("the browser retains the throttle code so it can exit a rejected CAPTCHA flow", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      { code: "upstream_rate_limit", message: "private-provider-details" },
      { status: 400 },
    ),
  );
  await assert.rejects(authRequest("heybox/complete-captcha", {}), (error) => {
    assert.ok(error instanceof LoginFailure);
    assert.equal(error.code, "upstream_rate_limit");
    assert.match(error.message, /小黑盒.*频繁.*稍后/);
    assert.ok(!error.message.includes("private-provider-details"));
    return true;
  });
});

test("a rejected SMS response still synchronizes its authoritative cooldown", async (t) => {
  const cooldown: SmsCooldown = {
    serverTime: 100_000,
    limits: [{ rule: "sms:phone:minute", retryAt: 146_000 }],
  };
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      {
        code: "upstream_rate_limit",
        smsCooldown: cooldown,
      },
      { status: 400 },
    ),
  );
  let received: SmsCooldown | undefined;
  await assert.rejects(
    authRequest("heybox/send-code", {}, (value) => {
      received = value;
    }),
    LoginFailure,
  );
  assert.deepEqual(received, cooldown);
});

test("actual SMS cooldown survives executor and browser transports as HTTP 429 with a deadline", async (t) => {
  const retryAt = Date.now() + 60_000;
  const body = {
    code: "sms_cooldown",
    retryAt,
    smsCooldown: { serverTime: Date.now(), limits: [{ rule: "sms:phone:minute", retryAt }] },
  };
  const env = {
    EXECUTOR_ENABLED: "true",
    RUNNER_SERVICE_TOKEN: "fixture",
    EXECUTOR: { fetch: async () => Response.json(body, { status: 429 }) },
  } as unknown as Env;
  const expected = (error: unknown) =>
    error instanceof LoginFailure && error.code === "sms_cooldown" && error.retryAt === retryAt;
  await assert.rejects(runnerRequest(env, "/login/captcha", {}), expected);
  t.mock.method(globalThis, "fetch", async () => Response.json(body, { status: 429 }));
  let received: SmsCooldown | undefined;
  await assert.rejects(
    authRequest("heybox/complete-captcha", {}, (value) => {
      received = value;
    }),
    expected,
  );
  assert.deepEqual(received, body.smsCooldown);
});

test("the generic auth limiter has a Chinese message and honors its remaining retry time", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      {
        message: "Too many requests. Please try again later.",
      },
      { status: 429, headers: { "X-Retry-After": "7" } },
    ),
  );
  let retrySeconds = 0;
  await assert.rejects(
    authRequest("heybox/send-code", {}, (value, authoritative) => {
      assert.equal(authoritative, false);
      assert.equal(value.limits[0].rule, "auth:ip:endpoint");
      retrySeconds = (value.limits[0].retryAt - value.serverTime) / 1000;
    }),
    /登录接口.*频繁/,
  );
  assert.equal(retrySeconds, 7);
});
