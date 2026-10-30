// Run against a local Worker with test/mock-runner.ts, never against production.
import assert from "node:assert/strict";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { router } from "../src/server/rpc.ts";
import { jobSchema, taskIds, LoginTiming, loginTimingHeader } from "@heybox/contracts";
import { decryptCredential } from "@heybox/hosting/crypto";
import { smsCooldownSchema, type LoginLimitRule } from "../src/lib/login-cooldown.ts";
import { verifySeo } from "./seo-integration.ts";

const base = process.env.TEST_SITE_URL || "http://localhost:3000";
if (!["localhost", "127.0.0.1"].includes(new URL(base).hostname))
  throw new Error("Integration tests only allow localhost");
await verifySeo(base);
const token = process.env.RUNNER_SERVICE_TOKEN || "";
async function expectRateLimit(response: Response, rule: LoginLimitRule, message: RegExp) {
  assert.equal(response.status, 429);
  const body = (await response.json()) as {
    message: string;
    rateLimit: { rule: string; serverTime: number; retryAt: number };
  };
  assert.equal(body.rateLimit.rule, rule);
  assert.match(body.message, message);
  assert.ok(body.rateLimit.retryAt > body.rateLimit.serverTime);
  assert.equal(
    Number(response.headers.get("retry-after")),
    Math.ceil((body.rateLimit.retryAt - body.rateLimit.serverTime) / 1000),
  );
  return body;
}
class Browser {
  cookies = new Map<string, string>();
  readonly ip: string;
  constructor(ip = `127.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.1`) {
    this.ip = ip;
  }
  async fetch(input: RequestInfo | URL, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("origin", base);
    headers.set("cf-connecting-ip", this.ip);
    headers.set("x-forwarded-for", this.ip);
    headers.set("cookie", [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; "));
    const response = await fetch(input, { ...init, headers });
    for (const value of response.headers.getSetCookie()) {
      assert.match(value.toLowerCase(), /httponly/);
      const [name, ...body] = value.split(";")[0].split("=");
      if (body.join("=")) this.cookies.set(name, body.join("="));
      else this.cookies.delete(name);
    }
    return response;
  }
  rpc: RouterClient<typeof router> = createORPCClient(
    new RPCLink({ url: `${base}/rpc`, fetch: (input, init) => this.fetch(input, init) }),
  );
  async auth(path: string, body: unknown) {
    const response = await this.fetch(`${base}/api/auth/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (path === "heybox/send-code") {
      assert.match(response.headers.get(loginTimingHeader)!, /^[a-f0-9-]{36}$/);
      assert.match(response.headers.get("server-timing")!, /app;dur=/);
      if (response.status === 200) {
        const timing = new LoginTiming();
        timing.merge(response.headers.get("server-timing"));
        for (const stage of ["web_accounts", "sms_quota", "sms_cooldown", "executor"] as const)
          assert.ok(timing.values[stage]! >= 0, `missing ${stage}`);
      }
    }
    return response;
  }
}
async function internal(path: string, body: unknown) {
  return fetch(`${base}/internal/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const a = new Browser();
const b = new Browser();
const guest = new Browser();
await assert.rejects(guest.rpc.dashboard(), /请先登录/);
await assert.rejects(guest.rpc.history(), /请先登录/);
await assert.rejects(guest.rpc.activities({ expectedAccount: "123" }), /请先登录/);
const humanChallenge = await guest.auth("heybox/send-code", { phone: "13900000000" });
assert.equal(humanChallenge.status, 400);
const challengeError = (await humanChallenge.json()) as { code: string; message: string };
assert.equal(challengeError.code, "captcha_required");
assert.match(challengeError.message, /人机验证/);
assert.equal(guest.cookies.size, 0);
const captchaBrowser = new Browser();
const captchaStart = await captchaBrowser.auth("heybox/send-code", { phone: "13900000001" });
assert.equal(captchaStart.status, 200);
const captchaState = (await captchaStart.json()) as {
  status: string;
  challenge: string;
  appId: string;
};
assert.equal(captchaState.status, "captcha");
assert.equal(captchaState.appId, "1234567890");
assert.ok(!JSON.stringify(captchaState).includes("integration-fixture"));
const proof = {
  challenge: captchaState.challenge,
  ticket: "valid-ticket",
  randstr: "valid-randstr",
};
assert.equal((await guest.auth("heybox/complete-captcha", proof)).status, 400);
assert.equal(
  (
    await captchaBrowser.auth("heybox/verify-code", {
      challenge: captchaState.challenge,
      code: "123456",
    })
  ).status,
  400,
);
assert.equal(
  (
    await captchaBrowser.auth("heybox/complete-captcha", {
      ...proof,
      ticket: "trerror_1001_fallback",
    })
  ).status,
  400,
);
const captchaSent = await captchaBrowser.auth("heybox/complete-captcha", proof);
assert.equal(captchaSent.status, 200);
assert.equal(((await captchaSent.json()) as { status: string }).status, "sent");
assert.equal((await captchaBrowser.auth("heybox/complete-captcha", proof)).status, 400);
assert.equal(
  (
    await captchaBrowser.auth("heybox/verify-code", {
      challenge: captchaState.challenge,
      code: "123456",
    })
  ).status,
  200,
);
assert.equal((await captchaBrowser.rpc.dashboard()).account, "00001");
await captchaBrowser.rpc.deleteAccount({
  confirm: true,
  expectedAccount: (await captchaBrowser.rpc.dashboard()).account,
});
const verificationBrowser = new Browser();
const verificationStart = await verificationBrowser.auth("heybox/send-code", {
  phone: "13900000002",
});
const verificationState = (await verificationStart.json()) as { challenge: string };
const verificationChallenge = await verificationBrowser.auth("heybox/verify-code", {
  challenge: verificationState.challenge,
  code: "123456",
});
assert.equal(((await verificationChallenge.json()) as { status: string }).status, "captcha");
const verified = await verificationBrowser.auth("heybox/complete-captcha", {
  ...proof,
  challenge: verificationState.challenge,
});
assert.equal(verified.status, 200);
assert.equal(((await verified.json()) as { status: string }).status, "authenticated");
assert.equal((await verificationBrowser.rpc.dashboard()).account, "00002");
await verificationBrowser.rpc.deleteAccount({
  confirm: true,
  expectedAccount: (await verificationBrowser.rpc.dashboard()).account,
});
assert.equal(
  (
    await fetch(`${base}/api/auth/heybox/send-code`, {
      method: "POST",
      headers: { origin: "https://evil.invalid", "content-type": "application/json" },
      body: "{}",
    })
  ).status,
  403,
);
assert.equal((await fetch(`${base}/internal/claim`, { method: "POST" })).status, 401);
assert.equal((await fetch(`${base}/rpc/setEnabled`)).status, 405);
assert.equal(
  (
    await fetch(`${base}/api/auth/heybox/send-code`, {
      method: "POST",
      headers: { origin: base },
      body: "x".repeat(5000),
    })
  ).status,
  413,
);
const suffix = String(Date.now()).slice(-5);
async function login(browser: Browser, phone: string) {
  const sent = await browser.auth("heybox/send-code", { phone });
  assert.equal(sent.status, 200, await sent.clone().text());
  const challenge = (await sent.json()) as { challenge: string };
  const oldCookies = new Map(browser.cookies);
  assert.equal(
    (await browser.auth("heybox/verify-code", { challenge: challenge.challenge, code: "111111" }))
      .status,
    400,
  );
  assert.equal(
    (await browser.auth("heybox/verify-code", { challenge: challenge.challenge, code: "123456" }))
      .status,
    200,
  );
  const authenticatedCookies = browser.cookies;
  browser.cookies = oldCookies;
  assert.equal(
    (await browser.auth("heybox/verify-code", { challenge: challenge.challenge, code: "123456" }))
      .status,
    400,
  );
  browser.cookies = authenticatedCookies;
  return challenge;
}
await login(a, `130001${suffix}`);
await login(
  b,
  `131002${String(Number(suffix) + 1)
    .padStart(5, "0")
    .slice(-5)}`,
);
const first = await a.rpc.dashboard();
const second = await b.rpc.dashboard();
const entry = await a.fetch(`${base}/`, { redirect: "manual" });
assert.equal(entry.status, 302);
assert.equal(new URL(entry.headers.get("location")!, base).pathname, "/tasks");
const taskPage = await a.fetch(`${base}/tasks`, { redirect: "manual" });
assert.equal(taskPage.status, 200);
assert.match(taskPage.headers.get("x-robots-tag") || "", /noindex/);
const historyPage = await a.fetch(`${base}/history`, { redirect: "manual" });
assert.equal(historyPage.status, 200);
assert.match(historyPage.headers.get("x-robots-tag") || "", /noindex/);
const firstHistory = await a.rpc.history();
const secondHistory = await b.rpc.history();
assert.equal(firstHistory.account, first.account);
assert.equal(secondHistory.account, second.account);
assert.deepEqual(
  firstHistory.records.map((row) => row.id),
  first.history.map((row) => row.id),
);
assert.ok(firstHistory.records.every((row) => row.taskType === "daily"));
assert.ok(
  firstHistory.records.every((row) => !secondHistory.records.some((other) => other.id === row.id)),
);
assert.deepEqual(await a.rpc.dashboard({ includeHistory: false }), { ...first, history: [] });
assert.deepEqual(await b.rpc.dashboard({ includeHistory: false }), { ...second, history: [] });
assert.notEqual(first.account, second.account);
assert.equal(first.nickname, "测试盒友");
assert.equal(first.avatar, null);
const existingSessionChallenge = await b.auth("heybox/send-code", { phone: "13900000003" });
const existingChallenge = (await existingSessionChallenge.json()) as { challenge: string };
assert.equal(
  (
    await b.auth("heybox/complete-captcha", {
      ...proof,
      challenge: existingChallenge.challenge,
      ticket: "invalid-proof",
    })
  ).status,
  400,
);
assert.equal((await b.rpc.dashboard()).account, second.account);
assert.ok(first.enabled && second.enabled);
assert.ok(!JSON.stringify(first).includes("ciphertext"));
assert.ok(!JSON.stringify(first).includes("pkey"));
const activities = await a.rpc.activities({ expectedAccount: first.account });
assert.equal(activities.length, 3);
assert.equal(activities.find((row) => row.id === "9305")?.status, "blocked");
await assert.rejects(a.rpc.activities({ expectedAccount: second.account }), /账号/);
await assert.rejects(
  a.rpc.participateActivity({
    expectedAccount: first.account,
    activityId: "9305",
    approvedFollowIds: [],
  }),
  /参与条件/,
);
await assert.rejects(
  a.rpc.participateActivity({
    expectedAccount: first.account,
    activityId: "9317",
    approvedFollowIds: [],
  }),
  /条件已变化/,
);
const participated = await a.rpc.participateActivity({
  expectedAccount: first.account,
  activityId: "9317",
  approvedFollowIds: ["104298871"],
});
assert.equal(participated.tickets, 700);
assert.equal(participated.status, "completed");
assert.deepEqual(
  await a.rpc.participateActivity({
    expectedAccount: first.account,
    activityId: "9317",
    approvedFollowIds: [],
  }),
  participated,
);
assert.equal(
  (await b.rpc.activities({ expectedAccount: second.account })).find((row) => row.id === "9317")
    ?.joined,
  false,
);
assert.ok(!JSON.stringify(activities).includes("ciphertext"));
assert.ok(!JSON.stringify(activities).includes("pkey"));
assert.equal(
  (await fetch(`${base}/internal/activities/check`, { method: "POST", body: "{}" })).status,
  401,
);
console.log(
  "PASS: activity authentication, game restrictions, explicit follow consent, repeat clicks and account isolation",
);
const accounts = new Set([first.account, second.account]);
for (let count = 0; count < 10 && accounts.size; count++) {
  const response = await internal("claim", {});
  assert.equal(response.status, 200);
  const payload = await response.json();
  if (!payload) {
    // The shared start gate can briefly return no job while known work is still queued.
    const delay = Number(response.headers.get("retry-after"));
    assert.ok(delay > 0 && delay <= 4, "pending fixture jobs must resume after the start gate");
    await new Promise((resolve) => setTimeout(resolve, delay * 1000));
    continue;
  }
  const job = jobSchema.parse(payload);
  assert.equal(
    decryptCredential(job.credential, process.env.CREDENTIAL_KEY || "").session.heybox_id,
    job.credential.account,
  );
  assert.equal(
    (
      await internal("activities/check", {
        account: job.credential.account,
        version: job.credential.version,
      })
    ).status,
    204,
  );
  assert.equal(
    (
      await internal("activities/check", {
        account: job.credential.account,
        version: crypto.randomUUID(),
      })
    ).status,
    409,
  );
  assert.equal(
    (await internal("heartbeat", { id: job.id, lease: job.lease, version: job.credential.version }))
      .status,
    204,
  );
  const result = {
    status: "completed",
    snapshot: { exp: 130, coin: 200, tasks: taskIds.map((id) => ({ id, state: "finish" })) },
    expDelta: 130,
    coinDelta: 200,
    batteryDelta: 2,
    execution: { sign: "executed", "1": "executed", "19": "skipped", "31": "skipped" },
  };
  assert.equal(
    (
      await internal("finish", {
        id: job.id,
        lease: job.lease,
        version: job.credential.version,
        result,
      })
    ).status,
    204,
  );
  accounts.delete(job.credential.account);
}
assert.equal(accounts.size, 0);
const emptyQueue = await internal("claim", {});
assert.equal(await emptyQueue.json(), null);
assert.equal(emptyQueue.headers.get("retry-after"), "1800");
assert.equal((await a.rpc.dashboard()).today?.status, "completed");
assert.equal((await a.rpc.history()).records[0].result?.batteryDelta, 2);
assert.equal((await a.rpc.history()).records[0].result?.execution?.["19"], "skipped");
await a.rpc.setEnabled({ expectedAccount: first.account, enabled: false });
assert.equal((await a.rpc.dashboard()).enabled, false);
assert.equal((await b.rpc.dashboard()).enabled, true);
await a.rpc.setEnabled({ expectedAccount: first.account, enabled: true });
assert.equal((await a.rpc.dashboard()).enabled, true);
await a.rpc.retry({ expectedAccount: first.account });
await a.rpc.setEnabled({ expectedAccount: first.account, enabled: false });
await a.rpc.deleteAccount({ confirm: true, expectedAccount: (await a.rpc.dashboard()).account });
await assert.rejects(a.rpc.dashboard(), /请先登录/);
assert.equal((await b.rpc.dashboard()).today?.status, "completed");
await b.rpc.deleteAccount({ confirm: true, expectedAccount: (await b.rpc.dashboard()).account });
await assert.rejects(b.rpc.dashboard(), /请先登录/);
// These calls stay inside the local mock runner; no real SMS is sent.
const limited = new Browser();
const response = await limited.auth("heybox/send-code", { phone: "13900000004" });
assert.equal(response.status, 400);
const error = (await response.json()) as { code: string; message: string; smsCooldown: unknown };
assert.equal(error.code, "upstream_rate_limit");
assert.match(error.message, /小黑盒.*频繁.*稍后/);
assert.ok(!error.message.includes("人机验证"));
const failedCooldown = smsCooldownSchema.parse(error.smsCooldown);
const failedPhoneLimit = failedCooldown.limits.find((limit) => limit.rule === "sms:phone:minute")!;
assert.ok(failedPhoneLimit.retryAt > failedCooldown.serverTime);
assert.ok(failedPhoneLimit.retryAt - failedCooldown.serverTime <= 60_000);
const phoneRejection = await expectRateLimit(
  await new Browser().auth("heybox/send-code", { phone: "13900000004" }),
  "sms:phone:minute",
  /手机号.*每分钟.*1 次/,
);
assert.equal(
  phoneRejection.rateLimit.retryAt,
  failedPhoneLimit.retryAt,
  "retrying must not restart the cooldown",
);
const limitedCaptcha = await limited.auth("heybox/send-code", { phone: "13900000005" });
assert.equal(limitedCaptcha.status, 200);
const limitedChallenge = (await limitedCaptcha.json()) as { challenge: string };
const limitedResult = await limited.auth("heybox/complete-captcha", {
  ...proof,
  challenge: limitedChallenge.challenge,
});
assert.equal(limitedResult.status, 400);
assert.equal(((await limitedResult.json()) as { code: string }).code, "upstream_rate_limit");
const thirdSend = await limited.auth("heybox/send-code", { phone: "13900000006" });
assert.equal(thirdSend.status, 200);
const thirdBody = (await thirdSend.json()) as { smsCooldown: unknown };
assert.ok(
  smsCooldownSchema
    .parse(thirdBody.smsCooldown)
    .limits.some((limit) => limit.rule === "sms:phone:minute"),
);
await expectRateLimit(
  await limited.auth("heybox/send-code", { phone: "13900000007" }),
  "sms:ip:minute",
  /当前网络.*每分钟.*3 次/,
);
await expectRateLimit(
  await new Browser().auth("heybox/send-code", { phone: "13900000008" }),
  "sms:phone:day",
  /手机号.*24 小时.*6 次/,
);
// The minute rule is encountered first on retry, but the longer daily block still governs the UI.
await expectRateLimit(
  await new Browser().auth("heybox/send-code", { phone: "13900000008" }),
  "sms:phone:day",
  /手机号.*24 小时.*6 次/,
);
await expectRateLimit(
  await new Browser("127.255.0.1").auth("heybox/send-code", { phone: "13900000010" }),
  "sms:ip:day",
  /当前网络.*24 小时.*30 次/,
);
const verifyLimited = new Browser("127.255.0.2");
const verifyStart = await verifyLimited.auth("heybox/send-code", { phone: "13900000009" });
assert.equal(verifyStart.status, 200);
await expectRateLimit(
  await verifyLimited.auth("heybox/verify-code", {
    challenge: ((await verifyStart.json()) as { challenge: string }).challenge,
    code: "123456",
  }),
  "verify:ip",
  /5 分钟.*30 次短信验证码/,
);
const captchaLimited = new Browser("127.255.0.3");
const captchaLimitStart = await captchaLimited.auth("heybox/send-code", { phone: "13900000011" });
assert.equal(captchaLimitStart.status, 200);
await expectRateLimit(
  await captchaLimited.auth("heybox/complete-captcha", {
    ...proof,
    challenge: ((await captchaLimitStart.json()) as { challenge: string }).challenge,
  }),
  "captcha:ip",
  /5 分钟.*30 次人机验证/,
);
assert.equal((await new Browser("127.255.0.4").fetch(`${base}/api/auth/get-session`)).status, 429);
console.log(
  "PASS: local D1 + Better Auth + oRPC + runner login, cookies, replay prevention, two-user isolation, jobs, pause, deletion and SMS quota boundaries",
);

// Device multi-account regression: separate browser sessions, no real SMS.
async function accountList(browser: Browser) {
  const response = await browser.fetch(`${base}/api/auth/heybox/accounts`);
  assert.equal(response.status, 200);
  const value = (await response.json()) as {
    activeAccount: string | null;
    accounts: Array<{ account: string; nickname: string }>;
  };
  assert.ok(!JSON.stringify(value).includes('"token"'));
  assert.ok(!JSON.stringify(value).includes('"ciphertext"'));
  return value;
}
async function stats(browser = new Browser()) {
  const response = await browser.fetch(`${base}/api/stats`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "public, max-age=300");
  const value = (await response.json()) as { accounts: number };
  assert.deepEqual(Object.keys(value), ["accounts"]);
  return value.accounts;
}
async function addOnDevice(browser: Browser, phone: string) {
  // A network change on the same device also keeps the existing account cookies.
  const network = new Browser();
  network.cookies = new Map(browser.cookies);
  await login(network, phone);
  browser.cookies = network.cookies;
}
const countBefore = await stats();
const device = new Browser();
await addOnDevice(device, "13200081001");
const observer = new Browser();
await login(observer, "13300081001");
assert.equal(
  await stats(),
  countBefore,
  "public statistics stay cached during the five-minute TTL",
);
// An old pre-upgrade primary session can still be listed and preserved when adding another.
for (const key of device.cookies.keys()) if (key.includes("_multi-")) device.cookies.delete(key);
assert.equal((await accountList(device)).accounts.length, 1);
await addOnDevice(device, "13200081002");
assert.equal((await accountList(device)).accounts.length, 2);
assert.equal((await device.rpc.dashboard()).account, "81002");
assert.equal(
  await stats(device),
  countBefore,
  "authenticated users share the same cached public count",
);
assert.equal((await guest.auth("heybox/switch", { account: "81001" })).status, 401);
const forged = new Browser();
for (const [name, value] of device.cookies) {
  if (name.includes("_multi-")) forged.cookies.set(name, `${value}tampered`);
}
assert.equal((await accountList(forged)).accounts.length, 0);
assert.equal((await forged.auth("heybox/switch", { account: "81001" })).status, 401);

assert.equal((await device.auth("heybox/switch", { account: "81001" })).status, 200);
assert.equal((await device.rpc.dashboard()).enabled, true);
await assert.rejects(
  device.rpc.setEnabled({ expectedAccount: "81002", enabled: false }),
  /账号已变化/,
);
await assert.rejects(device.rpc.retry({ expectedAccount: "81002" }), /账号已变化/);
await assert.rejects(
  device.rpc.deleteAccount({ expectedAccount: "81002", confirm: true }),
  /账号已变化/,
);
assert.equal((await device.auth("heybox/logout", { expectedAccount: "81002" })).status, 409);
assert.equal(
  (await device.auth("heybox/delete", { expectedAccount: "81002", confirm: true })).status,
  409,
);
const revoked = new Browser();
revoked.cookies = new Map(device.cookies);
assert.equal((await device.auth("heybox/logout", { expectedAccount: "81001" })).status, 200);
assert.equal((await device.rpc.dashboard()).account, "81002");
assert.equal((await device.rpc.dashboard()).enabled, true);
assert.equal(
  (await observer.rpc.dashboard()).enabled,
  false,
  "logout pauses only the selected account globally",
);
assert.equal((await observer.rpc.dashboard()).today?.status, "cancelled");
assert.equal((await accountList(device)).accounts.length, 1);
assert.equal((await revoked.auth("heybox/switch", { account: "81001" })).status, 401);
const expiredTaskPage = await revoked.fetch(`${base}/tasks`, { redirect: "manual" });
assert.equal(expiredTaskPage.status, 302);
assert.equal(new URL(expiredTaskPage.headers.get("location")!, base).pathname, "/login");
assert.equal(await stats(), countBefore, "logout does not bypass the public cache");
await addOnDevice(device, "13400081001");
assert.equal((await observer.rpc.dashboard()).enabled, true, "logging back in resumes the account");
// A successful upstream login for a different account must not change hosting or the active account.
const mismatchStart = await device.auth("heybox/send-code", {
  phone: "13200081099",
  expectedAccount: "81001",
});
assert.equal(mismatchStart.status, 200);
const mismatchChallenge = (await mismatchStart.json()) as { challenge: string };
const mismatch = await device.auth("heybox/verify-code", {
  challenge: mismatchChallenge.challenge,
  code: "123456",
});
assert.equal(mismatch.status, 400);
assert.match(await mismatch.text(), /账号不一致/);
assert.equal((await device.rpc.dashboard()).account, "81001");
assert.equal(await stats(), countBefore);
for (const account of ["81003", "81004", "81005"]) await addOnDevice(device, `132000${account}`);
assert.equal((await accountList(device)).accounts.length, 5);
const full = await device.auth("heybox/send-code", { phone: "13200081006" });
assert.equal(full.status, 400);
assert.match(await full.text(), /5 个账号/);
assert.equal(await stats(), countBefore);
assert.equal((await device.auth("heybox/switch", { account: "81001" })).status, 200);
const reauthStart = await device.auth("heybox/send-code", {
  phone: "13500081001",
  expectedAccount: "81001",
});
assert.equal(reauthStart.status, 200, await reauthStart.clone().text());
const reauth = (await reauthStart.json()) as { challenge: string };
assert.equal(
  (await device.auth("heybox/verify-code", { challenge: reauth.challenge, code: "123456" })).status,
  200,
);
assert.equal(
  (await accountList(device)).accounts.length,
  5,
  "relogin at the limit replaces the existing session",
);
assert.equal(await stats(), countBefore);
// Deletion from another browser invalidates all sessions of that account, not other accounts.
assert.equal(
  (await observer.auth("heybox/delete", { expectedAccount: "81001", confirm: true })).status,
  200,
);
await assert.rejects(observer.rpc.dashboard(), /请先登录/);
assert.equal((await accountList(device)).accounts.length, 4);
assert.equal((await device.auth("heybox/switch", { account: "81001" })).status, 401);
assert.equal((await device.auth("heybox/switch", { account: "81002" })).status, 200);
assert.equal((await device.rpc.dashboard()).enabled, true);
assert.equal(await stats(), countBefore);
for (const account of ["81002", "81003", "81004", "81005"]) {
  assert.equal((await device.auth("heybox/switch", { account })).status, 200);
  assert.equal(
    (await device.auth("heybox/delete", { expectedAccount: account, confirm: true })).status,
    200,
  );
}
assert.equal((await accountList(device)).accounts.length, 0);
assert.equal(await stats(), countBefore);
await assert.rejects(device.rpc.dashboard(), /请先登录/);
assert.equal(
  (await device.auth("sign-out", {})).status,
  404,
  "the old endpoint cannot bypass pause or log out other accounts",
);
console.log(
  "PASS: public account count, legacy sessions, five-account limit, relogin identity, switch, logout pause, stale-page protection and scoped deletion",
);
