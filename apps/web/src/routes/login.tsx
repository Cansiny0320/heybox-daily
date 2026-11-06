import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { LoginFailure, phoneSchema, type LoginProgress } from "@heybox/contracts";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { authRequest } from "../lib/auth-client";
import { readableError } from "../lib/utils";
import { useAccount, type Account } from "../components/layout";
import { privatePageHead } from "../lib/seo";
import { isPreview } from "../lib/deployment";
import {
  activeCooldown,
  applySmsCooldown,
  applySentCooldown,
  cooldownStorageKey,
  emptyCooldownState,
  formatCooldown,
  loginLimitMessages,
  restoreCooldown,
  startSmsRequest,
  type CooldownState,
} from "../lib/login-cooldown";

type LoginResult = LoginProgress | (Account & { status: "authenticated"; confirmation?: string });

export const Route = createFileRoute("/login")({
  head: () => privatePageHead("登录 · Heybox Daily"),
  validateSearch: (search: Record<string, unknown>): { account?: string } => ({
    account:
      typeof search.account === "string" && /^\d{1,64}$/.test(search.account)
        ? search.account
        : undefined,
  }),
  component: () => {
    const { account } = Route.useSearch();
    return <Login key={account || "add"} />;
  },
});
function Login() {
  const { account: targetAccount } = Route.useSearch();
  const [phone, setPhone] = useState(isPreview ? "13900000009" : "");
  const [code, setCode] = useState(isPreview ? "123456" : "");
  const [challenge, setChallenge] = useState<LoginProgress | null>(null);
  const [cooldownState, setCooldownState] = useState(emptyCooldownState);
  const cooldownRef = useRef(cooldownState);
  const [now, setNow] = useState(Date.now);
  const [restored, setRestored] = useState(false);
  const [busy, setBusy] = useState<"send" | "verify" | "captcha" | null>(null);
  const [error, setError] = useState("");
  const [sentTo, setSentTo] = useState("");
  const { setAccount, refreshAccounts } = useAccount();
  const navigate = useNavigate();
  const captchaAbort = useRef<AbortController | null>(null);
  const parsedPhone = phoneSchema.safeParse(phone);
  const cooldown = activeCooldown(cooldownState, parsedPhone.success ? parsedPhone.data : "", now);
  function saveCooldown(next: CooldownState) {
    cooldownRef.current = next;
    setCooldownState(next);
    setNow(Date.now());
    try {
      if (next.entries.length) sessionStorage.setItem(cooldownStorageKey, JSON.stringify(next));
      else sessionStorage.removeItem(cooldownStorageKey);
    } catch {
      /* The server still enforces the quota if browser storage is unavailable. */
    }
  }
  useEffect(() => {
    try {
      const saved = restoreCooldown(sessionStorage.getItem(cooldownStorageKey));
      cooldownRef.current = saved;
      setCooldownState(saved);
      setPhone(saved.phone || (isPreview ? "13900000009" : ""));
      const active = activeCooldown(saved, saved.phone);
      if (active)
        setError(
          active.rule === "pending"
            ? "上次验证码请求尚未确认，请等待倒计时结束后再试"
            : loginLimitMessages[active.rule],
        );
    } catch {
      /* Continue with server-enforced limits when browser storage is unavailable. */
    }
    setRestored(true);
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(timer);
      captchaAbort.current?.abort();
    };
  }, []);
  async function applyResult(result: LoginResult) {
    if (result.status === "authenticated") {
      if (result.confirmation)
        void authRequest("heybox/confirm-login", { challenge: result.confirmation }).catch(
          () => {},
        );
      saveCooldown(emptyCooldownState());
      setAccount(result);
      await refreshAccounts();
      await navigate({ to: "/tasks" });
      return;
    }
    setChallenge(result);
    if (result.status === "sent") {
      saveCooldown(
        applySentCooldown(cooldownRef.current, phoneSchema.parse(phone), result.retryAfter),
      );
      setSentTo(phone.slice(-4));
      if (result.message) setError(result.message);
    }
  }
  async function send() {
    if (!restored || busy !== null) return;
    setError("");
    const parsed = phoneSchema.safeParse(phone);
    if (!parsed.success) {
      setError("请输入有效手机号，海外号码需包含国家或地区区号");
      return;
    }
    const active = activeCooldown(cooldownRef.current, parsed.data);
    if (active) {
      setError(
        active.rule === "pending" ? "请等待倒计时结束后再试" : loginLimitMessages[active.rule],
      );
      return;
    }
    saveCooldown(startSmsRequest(cooldownRef.current, parsed.data));
    setBusy("send");
    try {
      const result = await authRequest<LoginProgress>(
        "heybox/send-code",
        {
          phone: parsed.data,
          ...(targetAccount ? { expectedAccount: targetAccount } : {}),
        },
        (value, authoritative) =>
          saveCooldown(
            applySmsCooldown(cooldownRef.current, parsed.data, value, Date.now(), authoritative),
          ),
      );
      setSentTo("");
      await applyResult(result);
      if (result.status === "captcha") await completeCaptcha(result);
    } catch (e) {
      if (e instanceof LoginFailure && e.code === "upstream_rate_limit") {
        setChallenge(null);
        setSentTo("");
      }
      setError(readableError(e));
    } finally {
      setBusy(null);
    }
  }
  async function completeCaptcha(captcha: Extract<LoginProgress, { status: "captcha" }>) {
    if (captchaAbort.current) return;
    setError("");
    if (Date.now() >= captcha.expiresAt) {
      setChallenge(null);
      setError("登录已过期，请重新获取验证码");
      return;
    }
    setBusy("captcha");
    const controller = new AbortController();
    captchaAbort.current = controller;
    try {
      const { showCaptcha } = await import("../lib/captcha");
      const proof = await showCaptcha(captcha.appId, captcha.expiresAt, controller.signal);
      if (!proof || controller.signal.aborted) return;
      const result = await authRequest<LoginResult>(
        "heybox/complete-captcha",
        {
          challenge: captcha.challenge,
          ...proof,
        },
        (value) =>
          saveCooldown(
            applySmsCooldown(
              cooldownRef.current,
              phoneSchema.parse(phone),
              value,
              Date.now(),
              false,
            ),
          ),
      );
      await applyResult(result);
      if (result.status === "captcha") setError("小黑盒要求重新验证，请再次完成人机验证");
    } catch (e) {
      if (e instanceof LoginFailure && e.code === "upstream_rate_limit") {
        setChallenge(null);
        setSentTo("");
      }
      setError(readableError(e));
    } finally {
      captchaAbort.current = null;
      setBusy(null);
    }
  }
  async function login(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (challenge?.status !== "sent" || Date.now() >= challenge.expiresAt) {
      setError("请先获取新的验证码");
      return;
    }
    if (!/^\d{4,8}$/.test(code)) {
      setError("请输入 4 至 8 位验证码");
      return;
    }
    setBusy("verify");
    try {
      const result = await authRequest<LoginResult>("heybox/verify-code", {
        challenge: challenge.challenge,
        code,
      });
      await applyResult(result);
      if (result.status === "captcha") await completeCaptcha(result);
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(null);
    }
  }
  return (
    <section className="mx-auto w-full max-w-[528px] px-6 pt-16 pb-16 sm:pt-24">
      <h1 className="text-center text-4xl font-semibold tracking-tight">
        {targetAccount ? "重新登录" : "登录"}
      </h1>
      <p className="mt-4 text-center text-base text-muted-foreground">
        {targetAccount ? `请登录盒友 ${targetAccount} 对应的账号` : "使用小黑盒账号开启每日任务"}
      </p>
      <form className="mt-10 space-y-6" onSubmit={login}>
        <div>
          <label htmlFor="phone" className="mb-2.5 block text-base font-medium">
            手机号
          </label>
          <Input
            id="phone"
            name="phone"
            type="tel"
            autoComplete="tel"
            inputMode="tel"
            placeholder="输入小黑盒手机号"
            maxLength={16}
            value={phone}
            disabled={busy !== null}
            onChange={(event) => {
              const value = event.target.value;
              setPhone(value);
              setChallenge(null);
              setSentTo("");
              const parsed = phoneSchema.safeParse(value);
              const active = activeCooldown(cooldownRef.current, parsed.success ? parsed.data : "");
              setError(active && active.rule !== "pending" ? loginLimitMessages[active.rule] : "");
            }}
            className="h-12 rounded-md px-3"
          />
        </div>
        <div>
          <label htmlFor="code" className="mb-2.5 block text-base font-medium">
            验证码
          </label>
          <div className="flex gap-3">
            <Input
              id="code"
              name="code"
              autoComplete="one-time-code"
              inputMode="numeric"
              placeholder="输入验证码"
              maxLength={8}
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
              disabled={busy !== null || challenge?.status === "captcha"}
              className="h-12 rounded-md px-3"
            />
            <Button
              type="button"
              variant="outline"
              className="h-12 min-w-28 rounded-md px-4 text-base"
              disabled={
                !restored || busy !== null || cooldown !== null || challenge?.status === "captcha"
              }
              onClick={send}
            >
              {busy === "send"
                ? "发送中…"
                : cooldown
                  ? formatCooldown(cooldown.seconds)
                  : isPreview
                    ? "获取验证码"
                    : "发送验证码"}
            </Button>
          </div>
          {sentTo && (
            <p role="status" className="mt-2 text-sm text-muted-foreground">
              {isPreview ? "演示验证码：123456（不会发送短信）" : `验证码已发送至尾号 ${sentTo}`}
            </p>
          )}
        </div>
        {error && (
          <p role="alert" className="text-sm leading-6 text-destructive">
            {error}
          </p>
        )}
        {challenge?.status === "captcha" ? (
          <Button
            type="button"
            className="h-12 w-full rounded-md text-base"
            disabled={busy !== null}
            onClick={() => completeCaptcha(challenge)}
          >
            {busy === "captcha" ? "正在验证…" : "完成人机验证"}
          </Button>
        ) : (
          <Button
            type="submit"
            className="h-12 w-full rounded-md text-base"
            disabled={busy !== null || !challenge || !code}
          >
            {busy === "verify" ? "正在验证…" : "登录并开启自动任务"}
          </Button>
        )}
      </form>
      <p className="mt-6 text-center text-sm leading-6 text-muted-foreground">
        {isPreview
          ? "演示号码：13900000009，验证码：123456。所有操作仅影响模拟数据。"
          : "登录可能导致手机 APP 账号退出，手机重新登录一次即可，网站还是可以正常运行"}
      </p>
    </section>
  );
}
