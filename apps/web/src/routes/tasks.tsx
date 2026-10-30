import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { DAILY_ATTEMPT_LIMIT, taskIds, taskNames, publicReasons } from "@heybox/contracts";
import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";
import { useAccount } from "../components/layout";
import { client } from "../lib/client";
import { privatePageHead } from "../lib/seo";
import {
  createDashboardLoader,
  dashboardPollInterval,
  type DashboardData,
} from "../lib/dashboard-loader";
import { Activities } from "../components/activities";
import { Rewards } from "../components/rewards";
import { TaskStatus } from "../components/task-status";
import { TasksSkeleton } from "../components/tasks-skeleton";
import { taskStatus } from "../lib/task-status";
import { dateTime, readableError } from "../lib/utils";

export const Route = createFileRoute("/tasks")({
  head: () => privatePageHead("我的任务 · Heybox Daily"),
  component: Dashboard,
});
function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const { account, setAccount } = useAccount();
  const requestId = useRef(0);
  const [loader] = useState(() =>
    createDashboardLoader(
      (includeHistory) => client.dashboard({ includeHistory }),
      undefined,
      false,
    ),
  );
  const navigate = useNavigate();
  const refresh = useCallback(
    async (full = false) => {
      const id = ++requestId.current;
      try {
        const value = await loader.load(full);
        if (id !== requestId.current) return;
        setData(value);
        setAccount(value);
        setError("");
      } catch (e) {
        if (id !== requestId.current) return;
        if (e && typeof e === "object" && "code" in e && e.code === "UNAUTHORIZED") {
          setAccount(null);
          await navigate({ to: "/login", replace: true });
        } else setError(readableError(e));
      }
    },
    [navigate, setAccount, loader],
  );
  const pollingInterval = error ? 60_000 : dashboardPollInterval(data?.today);
  useEffect(() => {
    void refresh();
    const focus = () => {
      void refresh();
    };
    const visible = () => {
      if (document.visibilityState === "visible") focus();
    };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visible);
    return () => {
      requestId.current++;
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, pollingInterval);
    return () => clearInterval(timer);
  }, [refresh, pollingInterval]);
  async function change(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh(true);
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(false);
    }
  }
  if (!data || (account && data.account !== account.account))
    return error ? (
      <section className="mx-auto max-w-6xl px-6 py-20 sm:px-8">
        <p role="alert" className="text-base text-muted-foreground">
          {error}
        </p>
        <Button className="mt-4" variant="outline" onClick={() => refresh(true)}>
          重新加载
        </Button>
      </section>
    ) : (
      <TasksSkeleton />
    );
  const today = data.today;
  const running = today?.status === "running" || today?.status === "queued";
  const expired = data.credentialState !== "valid";
  const reason = today?.result?.reason;
  const verifiedAt = today?.result?.snapshot
    ? new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(today.updatedAt)
    : "—";
  return (
    <section className="mx-auto max-w-6xl px-6 pt-10 pb-12 sm:px-8 sm:pt-12">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
        <h1 className="text-3xl font-semibold tracking-tight">每日任务</h1>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <label htmlFor="automation" className="text-base font-medium">
            自动运行
          </label>
          <Switch
            id="automation"
            checked={data.enabled}
            disabled={busy || expired}
            onCheckedChange={(enabled) =>
              change(() => client.setEnabled({ enabled, expectedAccount: data.account }))
            }
          />
          {running ? (
            <span role="status" className="text-sm">
              {!data.enabled && today?.status === "running" ? (
                "本次执行完成后暂停"
              ) : (
                <TaskStatus status={today!.status} />
              )}
            </span>
          ) : !data.enabled && !expired ? (
            <p className="text-sm text-muted-foreground">已暂停，恢复后补跑今天未完成的任务</p>
          ) : data.nextRunAt ? (
            <p className="text-sm text-muted-foreground">下次执行：{dateTime(data.nextRunAt)}</p>
          ) : null}
        </div>
      </div>
      {expired && (
        <div className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-md bg-amber-50 px-4 py-3 text-sm">
          <span>需要重新登录小黑盒，自动任务已暂停。</span>
          <Link
            to="/login"
            search={{ account: data.account }}
            className="font-medium underline underline-offset-4"
          >
            重新登录
          </Link>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-6 text-sm text-destructive">
          {error}
        </p>
      )}
      {!expired &&
        data.enabled &&
        !running &&
        today?.status !== "completed" &&
        (today?.attempts ?? 0) < DAILY_ATTEMPT_LIMIT && (
          <div className="mt-6 flex justify-end">
            <Button
              className="h-10 px-4 text-base"
              disabled={busy || running}
              onClick={() => change(() => client.retry({ expectedAccount: data.account }))}
            >
              重试未完成任务
            </Button>
          </div>
        )}
      {!expired &&
        !running &&
        today?.status !== "completed" &&
        (today?.attempts ?? 0) >= DAILY_ATTEMPT_LIMIT && (
          <p className="mt-6 text-sm text-muted-foreground">
            今天已达到 {DAILY_ATTEMPT_LIMIT} 次执行上限。
          </p>
        )}
      <div className="mt-8" aria-label="每日任务状态">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 border-b pb-3 text-sm text-muted-foreground sm:grid-cols-[minmax(0,1fr)_minmax(140px,.7fr)_140px]">
          <span>任务</span>
          <span>状态</span>
          <span className="hidden sm:block">核验时间</span>
        </div>
        {taskIds.map((id) => {
          return (
            <div
              key={id}
              className="grid min-h-16 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b py-4 sm:grid-cols-[minmax(0,1fr)_minmax(140px,.7fr)_140px]"
            >
              <span className="text-base font-medium">{taskNames[id]}</span>
              <TaskStatus status={taskStatus(id, today?.status, today?.result)} />
              <span className="hidden text-sm text-muted-foreground tabular-nums sm:block">
                {verifiedAt}
              </span>
            </div>
          );
        })}
      </div>
      {reason && reason !== "auth_expired" && reason !== "cancelled" && (
        <p className="mt-4 text-sm text-muted-foreground">
          {today?.result?.failure?.category === "rate_limit"
            ? "小黑盒请求限流"
            : today?.result?.failure?.category === "captcha"
              ? "需要在小黑盒完成人机验证"
              : today?.result?.failure?.category === "protocol"
                ? "小黑盒接口返回异常，暂未确认完成"
                : publicReasons[reason]}
          {today?.retryAt ? `，预计 ${dateTime(today.retryAt)} 自动重试` : ""}
        </p>
      )}
      {today?.result && (
        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <span className="text-muted-foreground">本次获得</span>
          <Rewards result={today.result} />
        </div>
      )}
      <Activities key={`${data.account}:${expired}`} account={data.account} expired={expired} />
    </section>
  );
}
