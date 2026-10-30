import { historyPollInterval } from "../lib/dashboard-loader";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount } from "../components/layout";
import { Button } from "../components/ui/button";
import { Rewards } from "../components/rewards";
import { TaskStatus } from "../components/task-status";
import { client } from "../lib/client";
import { privatePageHead } from "../lib/seo";
import { runStatus } from "../lib/task-status";
import { readableError } from "../lib/utils";

export const Route = createFileRoute("/history")({
  head: () => privatePageHead("历史记录 · Heybox Daily"),
  component: History,
});

type HistoryData = Awaited<ReturnType<typeof client.history>>;

function History() {
  const [data, setData] = useState<HistoryData | null>(null);
  const [error, setError] = useState("");
  const { account, setAccount } = useAccount();
  const navigate = useNavigate();
  const pending = useRef(false);
  const requestId = useRef(0);
  const refresh = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    const id = ++requestId.current;
    try {
      const value = await client.history();
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
    } finally {
      pending.current = false;
    }
  }, [navigate, setAccount]);
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
  const pollingInterval = error ? 60_000 : historyPollInterval(data?.records);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, pollingInterval);
    return () => clearInterval(timer);
  }, [refresh, pollingInterval]);
  const loaded = data && (!account || data.account === account.account);
  return (
    <section className="mx-auto max-w-6xl px-6 pt-10 pb-12 sm:px-8 sm:pt-12">
      <h1 className="text-3xl font-semibold tracking-tight">历史记录</h1>
      {error && (
        <div className="mt-6 flex flex-wrap items-center gap-4">
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
          <Button variant="outline" onClick={() => refresh()}>
            重新加载
          </Button>
        </div>
      )}
      {!loaded ? (
        !error && (
          <p role="status" className="mt-8 text-base text-muted-foreground">
            正在读取历史记录…
          </p>
        )
      ) : data.records.length ? (
        <div className="mt-8 overflow-x-auto">
          <table className="w-full min-w-[600px] text-left text-base">
            <thead className="border-b text-sm text-muted-foreground">
              <tr>
                <th scope="col" className="pb-3 pr-6 font-normal">
                  日期
                </th>
                <th scope="col" className="pb-3 pr-6 font-normal">
                  任务类型
                </th>
                <th scope="col" className="pb-3 pr-6 font-normal">
                  状态
                </th>
                <th scope="col" className="pb-3 font-normal">
                  实际收益
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {data.records.map((row) => (
                <tr key={`${row.taskType}:${row.id}`}>
                  <td className="py-5 pr-6 tabular-nums whitespace-nowrap">{row.date}</td>
                  <td className="py-5 pr-6 whitespace-nowrap">{row.taskName}</td>
                  <td className="py-5 pr-6">
                    <TaskStatus status={runStatus(row.status, row.result)} />
                  </td>
                  <td className="py-5">
                    <Rewards result={row.result} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="mt-8 border-t py-8 text-base text-muted-foreground">还没有历史记录</p>
      )}
    </section>
  );
}
