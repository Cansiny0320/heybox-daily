import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint, APIError, getSessionFromCtx } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";
import {
  phoneSchema,
  codeSchema,
  idSchema,
  beginResultSchema,
  runnerLoginResultSchema,
  captchaProofSchema,
  LoginFailure,
  LoginTiming,
} from "@heybox/contracts";
import {
  accountEndpoints,
  deviceSessions,
  forgetAccount,
  rememberSession,
  requireAccount,
} from "./accounts.ts";
import { authOptions } from "./auth-options.ts";
import { Store } from "@heybox/hosting/store";
import type { Env } from "./env.ts";
import { runnerRequest } from "./security.ts";
import { privateKey } from "@heybox/hosting/security";
import { notifyRunnerInBackground } from "./notify.ts";
import {
  loginLimitMessages,
  type LoginLimitRule,
  type SmsCooldown,
} from "../lib/login-cooldown.ts";

function logRateLimit(rule: LoginLimitRule, limit: number, windowMs: number) {
  console.warn(
    JSON.stringify({ event: "auth_rate_limited", rule, limit, windowSeconds: windowMs / 1000 }),
  );
}

const smsRules = (phone: string, ip: string) =>
  [
    ["sms:ip:minute", ip, 3, 60_000],
    ["sms:ip:day", ip, 30, 86400_000],
    ["sms:phone:minute", phone, 1, 60_000],
    ["sms:phone:day", phone, 6, 86400_000],
  ] as const;

export function createAuth(
  env: Env,
  execution: Pick<ExecutionContext, "waitUntil">,
  loginTiming?: LoginTiming,
) {
  const store = new Store(env.DB);
  const cookie =
    new URL(env.SITE_URL).protocol === "https:" ? "__Host-heybox-challenge" : "heybox-challenge";
  function clearIntent(ctx: Parameters<typeof setSessionCookie>[0]) {
    for (const name of [cookie, `${cookie}-intent`])
      ctx.setCookie(name, "", {
        httpOnly: true,
        secure: cookie.startsWith("__Host-"),
        sameSite: "strict",
        path: "/",
        maxAge: 0,
      });
  }
  function loginError(error: LoginFailure) {
    if (error.code !== "sms_cooldown")
      return new APIError("BAD_REQUEST", { code: error.code, message: error.message });
    const serverTime = Date.now();
    const retryAt = error.retryAt ?? serverTime + 60_000;
    const limit = { rule: "sms:phone:minute" as const, retryAt };
    return new APIError(
      "TOO_MANY_REQUESTS",
      {
        code: error.code,
        message: error.message,
        retryAt,
        rateLimit: { ...limit, serverTime },
        smsCooldown: { serverTime, limits: [limit] },
      },
      { "Retry-After": String(Math.max(0, Math.ceil((retryAt - serverTime) / 1000))) },
    );
  }
  async function loginBackend(ctx: Parameters<typeof setSessionCookie>[0]) {
    const signed = await ctx.getSignedCookie(`${cookie}-intent`, ctx.context.secret);
    if (typeof signed !== "string")
      throw new APIError("BAD_REQUEST", { message: "登录已过期，请重新获取验证码" });
    const saved = JSON.parse(signed) as { binding: string; expires: number; executor?: string };
    if (saved.binding !== ctx.getCookie(cookie) || saved.expires < Date.now())
      throw new APIError("BAD_REQUEST", { message: "登录已过期，请重新获取验证码" });
    // Pre-migration challenges have no executor field and must finish on their original runner.
    return saved.executor === "cloudflare" ? ("cloudflare" as const) : ("legacy" as const);
  }
  async function limit(rule: LoginLimitRule, subject: string, count: number, window: number) {
    const key = await privateKey(`${rule}:${subject}`, env.BETTER_AUTH_SECRET);
    if (!(await store.quota(key, count, window))) {
      logRateLimit(rule, count, window);
      const [state] = await store.quotaStates([key]);
      const serverTime = Date.now();
      const retryAt = state?.retryAt ?? serverTime;
      throw new APIError(
        "TOO_MANY_REQUESTS",
        {
          code: "rate_limited",
          message: loginLimitMessages[rule],
          rateLimit: { rule, serverTime, retryAt },
        },
        { "Retry-After": String(Math.max(0, Math.ceil((retryAt - serverTime) / 1000))) },
      );
    }
  }
  async function limitSms(phone: string, ip: string) {
    const rules = smsRules(phone, ip);
    const quotas = await Promise.all(
      rules.map(async ([rule, subject, limit, windowMs]) => ({
        key: await privateKey(`${rule}:${subject}`, env.BETTER_AUTH_SECRET),
        limit,
        windowMs,
      })),
    );
    const rejected = await store.quotas(quotas);
    if (rejected === null) return;
    const [rule, , count, window] = rules[rejected];
    logRateLimit(rule, count, window);
    const [state] = await store.quotaStates([quotas[rejected].key]);
    const serverTime = Date.now();
    const retryAt = state?.retryAt ?? serverTime;
    throw new APIError(
      "TOO_MANY_REQUESTS",
      {
        code: "rate_limited",
        message: loginLimitMessages[rule],
        rateLimit: { rule, serverTime, retryAt },
      },
      { "Retry-After": String(Math.max(0, Math.ceil((retryAt - serverTime) / 1000))) },
    );
  }
  async function smsCooldown(
    phone: string,
    ip: string,
    timing?: LoginTiming,
  ): Promise<SmsCooldown> {
    const started = performance.now();
    try {
      const rules = smsRules(phone, ip);
      const keys = await Promise.all(
        rules.map(([rule, subject]) => privateKey(`${rule}:${subject}`, env.BETTER_AUTH_SECRET)),
      );
      const states = await store.quotaStates(keys);
      const serverTime = Date.now();
      return {
        serverTime,
        limits: rules.flatMap(([rule, , max], i) => {
          const state = states.find((item) => item.key === keys[i]);
          return state && state.count >= max && state.retryAt > serverTime
            ? [{ rule, retryAt: state.retryAt }]
            : [];
        }),
      };
    } finally {
      timing?.add("sms_cooldown", performance.now() - started);
    }
  }
  async function withSmsCooldown<T extends object>(
    phone: string,
    ip: string,
    run: () => Promise<T>,
    timing?: LoginTiming,
  ) {
    try {
      return { ...(await run()), smsCooldown: await smsCooldown(phone, ip, timing) };
    } catch (error) {
      if (error instanceof APIError) {
        const cooldown = await smsCooldown(phone, ip, timing);
        if (error.body?.code === "sms_cooldown" && typeof error.body.retryAt === "number")
          cooldown.limits.push({ rule: "sms:phone:minute", retryAt: error.body.retryAt });
        const blocking = cooldown.limits.toSorted((a, b) => b.retryAt - a.retryAt)[0];
        const headers = new Headers(error.headers);
        const detail =
          error.body?.code === "rate_limited" && blocking
            ? {
                message: loginLimitMessages[blocking.rule],
                rateLimit: { ...blocking, serverTime: cooldown.serverTime },
              }
            : {};
        if (detail.rateLimit)
          headers.set(
            "Retry-After",
            String(Math.max(0, Math.ceil((detail.rateLimit.retryAt - cooldown.serverTime) / 1000))),
          );
        throw new APIError(
          error.status,
          { ...error.body, ...detail, smsCooldown: cooldown },
          headers,
        );
      }
      throw error;
    }
  }
  async function finish(
    ctx: Parameters<typeof setSessionCookie>[0],
    result: z.infer<typeof runnerLoginResultSchema>,
    challenge: string,
  ) {
    if (result.status !== "authenticated") return ctx.json(result);
    const intent = await ctx.getSignedCookie(`${cookie}-intent`, ctx.context.secret);
    const binding = ctx.getCookie(cookie);
    if (typeof intent !== "string")
      throw new APIError("BAD_REQUEST", { message: "登录已过期，请重新获取验证码" });
    const saved = JSON.parse(intent) as {
      binding: string;
      account?: string;
      expires: number;
      executor?: string;
      challenge?: string;
    };
    if (saved.binding !== binding || saved.expires < Date.now())
      throw new APIError("BAD_REQUEST", { message: "登录已过期，请重新获取验证码" });
    const recovery = saved.executor === "cloudflare" ? result.recovery : undefined;
    if (
      (saved.challenge && saved.challenge !== challenge) ||
      (recovery && recovery.challenge !== challenge)
    )
      throw new APIError("BAD_REQUEST", { message: "登录挑战不匹配" });
    if (saved.account) {
      await requireAccount(ctx, saved.account);
      if (result.credential.account !== saved.account)
        throw new APIError("BAD_REQUEST", {
          message: "登录的账号与当前账号不一致，请使用当前账号的手机号",
        });
    }
    const sessions = await deviceSessions(ctx);
    const id = `heybox:${result.credential.account}`;
    if (
      !sessions.some((item) => item.user.id === id) &&
      new Set(sessions.map((item) => item.user.id)).size >= 5
    )
      throw new APIError("BAD_REQUEST", { message: "最多同时登录 5 个账号，请先退出一个账号" });
    const userId = await store.enroll(result.credential, recovery);
    const user = await ctx.context.internalAdapter.findUserById(userId);
    if (!user) throw new APIError("INTERNAL_SERVER_ERROR", { message: "无法建立网站会话，请重试" });
    const adapter = ctx.context.internalAdapter;
    const token = recovery
      ? await privateKey(`login-session:${challenge}:${binding}`, ctx.context.secret)
      : undefined;
    let session = token ? (await adapter.findSession(token))?.session : undefined;
    if (!session) {
      try {
        session =
          (await adapter.createSession(user.id, false, token ? { token } : undefined, !!token)) ??
          undefined;
      } catch (error) {
        session = token ? (await adapter.findSession(token))?.session : undefined;
        if (!session) throw error;
      }
    }
    if (!session)
      throw new APIError("INTERNAL_SERVER_ERROR", { message: "无法建立网站会话，请重试" });
    // Preserve the other browser accounts, including pre-upgrade sessions.
    for (const existing of sessions.filter((item) => item.user.id !== userId))
      await rememberSession(ctx, existing);
    await forgetAccount(
      ctx,
      userId,
      sessions.filter((item) => item.session.token !== session.token),
    );
    await rememberSession(ctx, { session, user });
    await setSessionCookie(ctx, { session, user });
    if (!recovery) clearIntent(ctx);
    notifyRunnerInBackground(env, execution);
    return ctx.json({
      status: "authenticated",
      account: result.credential.account,
      nickname: user.name,
      avatar: user.image || null,
      ...(recovery ? { confirmation: challenge } : {}),
    });
  }
  const heyboxPlugin = {
    id: "heybox",
    endpoints: {
      ...accountEndpoints(store),
      confirmHeyboxLogin: createAuthEndpoint(
        "/heybox/confirm-login",
        { method: "POST", body: z.object({ challenge: idSchema }) },
        async (ctx) => {
          const signed = await ctx.getSignedCookie(`${cookie}-intent`, ctx.context.secret);
          if (typeof signed !== "string") return ctx.json({ confirmed: true });
          const saved = JSON.parse(signed) as {
            binding: string;
            challenge?: string;
            expires: number;
          };
          const binding = ctx.getCookie(cookie);
          if (
            saved.binding !== binding ||
            saved.expires <= Date.now() ||
            (saved.challenge && saved.challenge !== ctx.body.challenge)
          )
            throw new APIError("BAD_REQUEST", { message: "登录挑战已过期或不匹配" });
          const current = await getSessionFromCtx(ctx);
          const token = await privateKey(
            `login-session:${ctx.body.challenge}:${binding}`,
            ctx.context.secret,
          );
          if (!current || current.session.token !== token)
            throw new APIError("UNAUTHORIZED", { message: "请先完成登录" });
          await runnerRequest(
            env,
            "/login/confirm",
            { challenge: ctx.body.challenge, binding },
            await loginBackend(ctx),
          );
          clearIntent(ctx);
          return ctx.json({ confirmed: true });
        },
      ),
      sendHeyboxCode: createAuthEndpoint(
        "/heybox/send-code",
        {
          method: "POST",
          body: z.object({
            phone: phoneSchema,
            expectedAccount: z.string().min(1).max(64).optional(),
          }),
        },
        async (ctx) => {
          const timing = loginTiming || new LoginTiming();
          const devices = await timing.measure("web_accounts", async () => {
            if (ctx.body.expectedAccount) await requireAccount(ctx, ctx.body.expectedAccount);
            return deviceSessions(ctx);
          });
          if (!ctx.body.expectedAccount && new Set(devices.map((item) => item.user.id)).size >= 5)
            throw new APIError("BAD_REQUEST", {
              message: "最多同时登录 5 个账号，请先退出一个账号",
            });
          const ip = ctx.request?.headers.get("cf-connecting-ip") || "local";
          const binding = [...crypto.getRandomValues(new Uint8Array(32))]
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
          const data = await withSmsCooldown(
            ctx.body.phone,
            ip,
            async () => {
              await timing.measure("sms_quota", () => limitSms(ctx.body.phone, ip));
              try {
                return beginResultSchema.parse(
                  await runnerRequest(
                    env,
                    "/login/begin",
                    { phone: ctx.body.phone, binding },
                    undefined,
                    timing,
                  ),
                );
              } catch (error) {
                if (error instanceof LoginFailure) throw loginError(error);
                console.warn("登录执行端暂时不可用");
                throw new APIError("BAD_GATEWAY", {
                  message: "小黑盒暂时无法发送验证码，请稍后重试",
                });
              }
            },
            timing,
          );
          ctx.setCookie(cookie, binding, {
            httpOnly: true,
            secure: cookie.startsWith("__Host-"),
            sameSite: "strict",
            path: "/",
            maxAge: 300,
          });
          await ctx.setSignedCookie(
            `${cookie}-intent`,
            JSON.stringify({
              binding,
              challenge: data.challenge,
              account: ctx.body.expectedAccount,
              executor: env.EXECUTOR_ENABLED === "true" ? "cloudflare" : "legacy",
              expires: data.expiresAt,
            }),
            ctx.context.secret,
            {
              httpOnly: true,
              secure: cookie.startsWith("__Host-"),
              sameSite: "strict",
              path: "/",
              maxAge: 300,
            },
          );
          return ctx.json(data);
        },
      ),
      verifyHeyboxCode: createAuthEndpoint(
        "/heybox/verify-code",
        { method: "POST", body: z.object({ challenge: idSchema, code: codeSchema }) },
        async (ctx) => {
          const binding = ctx.getCookie(cookie);
          if (!binding || !/^[a-f0-9]{64}$/.test(binding))
            throw new APIError("BAD_REQUEST", { message: "登录已过期，请重新获取验证码" });
          await limit(
            "verify:ip",
            ctx.request?.headers.get("cf-connecting-ip") || "local",
            30,
            300_000,
          );
          let result: z.infer<typeof runnerLoginResultSchema>;
          try {
            result = runnerLoginResultSchema.parse(
              await runnerRequest(
                env,
                "/login/verify",
                { ...ctx.body, binding },
                await loginBackend(ctx),
              ),
            );
          } catch (error) {
            if (error instanceof LoginFailure) throw loginError(error);
            throw new APIError("BAD_REQUEST", {
              message: "验证码错误、已过期或小黑盒暂时不可用，请稍后重试",
            });
          }
          return finish(ctx, result, ctx.body.challenge);
        },
      ),
      completeHeyboxCaptcha: createAuthEndpoint(
        "/heybox/complete-captcha",
        { method: "POST", body: captchaProofSchema.extend({ challenge: idSchema }) },
        async (ctx) => {
          const binding = ctx.getCookie(cookie);
          if (!binding || !/^[a-f0-9]{64}$/.test(binding))
            throw new APIError("BAD_REQUEST", { message: "登录已过期，请重新获取验证码" });
          await limit(
            "captcha:ip",
            ctx.request?.headers.get("cf-connecting-ip") || "local",
            30,
            300_000,
          );
          let result: z.infer<typeof runnerLoginResultSchema>;
          try {
            result = runnerLoginResultSchema.parse(
              await runnerRequest(
                env,
                "/login/captcha",
                { ...ctx.body, binding },
                await loginBackend(ctx),
              ),
            );
          } catch (error) {
            if (error instanceof LoginFailure) throw loginError(error);
            throw new APIError("BAD_REQUEST", {
              message: "人机验证未通过、已过期或小黑盒暂时不可用，请重新验证",
            });
          }
          return finish(ctx, result, ctx.body.challenge);
        },
      ),
    },
  } satisfies BetterAuthPlugin;
  return betterAuth({
    ...authOptions(env),
    plugins: [heyboxPlugin],
    rateLimit: {
      enabled: true,
      customStorage: {
        consume: async (key, rule) => {
          const started = performance.now();
          try {
            const hashed = await privateKey(`auth:${key}`, env.BETTER_AUTH_SECRET);
            const allowed = await store.quota(hashed, rule.max, rule.window * 1000);
            if (allowed) return { allowed, retryAfter: 0 };
            logRateLimit("auth:ip:endpoint", rule.max, rule.window * 1000);
            const [state] = await store.quotaStates([hashed]);
            return {
              allowed,
              retryAfter: Math.max(
                0,
                Math.ceil(((state?.retryAt ?? Date.now()) - Date.now()) / 1000),
              ),
            };
          } finally {
            loginTiming?.add("auth_quota", performance.now() - started);
          }
        },
      },
    },
  });
}
