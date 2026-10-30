import { useEffect, useRef, useState } from "react";
import { ChevronDown, RefreshCw } from "lucide-react";
import type { ActivityView } from "@heybox/contracts";
import { client } from "../lib/client";
import { readableError } from "../lib/utils";
import { Button } from "./ui/button";
import { ActivityListSkeleton } from "./tasks-skeleton";

const actionNames = {
  available: "参与",
  follow_required: "关注并参与",
  blocked: "暂不可参与",
  joined: "完成分享",
  completed: "已参与",
  ended: "已结束",
};
export function Activities({ account, expired }: { account: string; expired: boolean }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ActivityView[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const active = useRef(true);
  const pending = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, [account]);
  useEffect(() => {
    if (open && !expired && items === null) void refresh();
  }, [open, expired]);
  async function refresh() {
    if (pending.current || expired) return;
    pending.current = true;
    setLoading(true);
    setError("");
    try {
      const result = await client.activities({ expectedAccount: account });
      if (active.current) setItems(result);
    } catch (e) {
      if (active.current) setError(readableError(e));
    } finally {
      pending.current = false;
      if (active.current) setLoading(false);
    }
  }
  async function participate(item: ActivityView) {
    if (
      pending.current ||
      expired ||
      !["available", "follow_required", "joined"].includes(item.status)
    )
      return;
    pending.current = true;
    setBusy(item.id);
    setError("");
    try {
      const result = await client.participateActivity({
        expectedAccount: account,
        activityId: item.id,
        approvedFollowIds:
          item.status === "follow_required" ? item.followAccounts.map((target) => target.id) : [],
      });
      if (active.current)
        setItems((current) => current?.map((row) => (row.id === result.id ? result : row)) || null);
    } catch (e) {
      if (active.current) setError(readableError(e));
      // A write may have succeeded before the response was lost. Refresh without repeating it.
      try {
        const result = await client.activities({ expectedAccount: account });
        if (active.current) setItems(result);
      } catch {
        /* Keep the last view and let the user refresh after the operation settles. */
      }
    } finally {
      pending.current = false;
      if (active.current) setBusy(null);
    }
  }
  return (
    <section className="mt-12" aria-labelledby="activities-title">
      <div className="flex items-center justify-between gap-4">
        <h2 id="activities-title">
          <button
            type="button"
            aria-expanded={open}
            aria-controls="activities-list"
            className="flex items-center gap-2 text-2xl font-semibold tracking-tight"
            onClick={() => {
              setOpen((value) => !value);
            }}
          >
            抽奖活动
            <ChevronDown
              aria-hidden="true"
              className={`size-5 transition-transform ${open ? "rotate-180" : ""}`}
            />
          </button>
        </h2>
        {open && !expired && (
          <Button
            variant="ghost"
            size="icon"
            title="刷新活动"
            aria-label={loading ? "正在读取活动" : "刷新活动"}
            aria-busy={loading}
            disabled={loading || busy !== null}
            onClick={() => void refresh()}
          >
            <RefreshCw
              aria-hidden="true"
              className={`size-4${loading ? " animate-spin motion-reduce:animate-none" : ""}`}
            />
          </Button>
        )}
      </div>
      {open && (
        <div id="activities-list" className="mt-5">
          {expired ? (
            <p className="text-sm text-muted-foreground">重新登录小黑盒后可查看活动。</p>
          ) : (
            <>
              {error && (
                <p role="alert" className="mb-4 text-sm text-destructive">
                  {error}
                </p>
              )}
              {loading && items === null && <ActivityListSkeleton />}
              {items?.length === 0 && (
                <p className="border-t py-6 text-muted-foreground">暂无进行中的活动</p>
              )}
              {items?.map((item) => (
                <div
                  key={item.id}
                  className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4 border-t py-5"
                >
                  <div className="min-w-0 flex-1 basis-56">
                    <h3 className="text-base font-medium break-words">{item.name}</h3>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">
                      {[
                        item.prizeCount === null ? null : `${item.prizeCount} 份`,
                        item.endTime ? `${item.endTime} 开奖` : null,
                        item.tickets === null ? null : `${item.tickets} 张抽奖券`,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                    {item.reason && (
                      <p className="mt-1 text-sm text-muted-foreground">{item.reason}</p>
                    )}
                    {item.status === "follow_required" && (
                      <p className="mt-1 text-sm text-muted-foreground">
                        {item.followAccounts.map((target) => target.name).join("；")}
                      </p>
                    )}
                  </div>
                  {item.status === "completed" || item.status === "ended" ? (
                    <span className="text-sm text-muted-foreground">
                      {actionNames[item.status]}
                    </span>
                  ) : (
                    <Button
                      className="h-10 px-4 text-base"
                      variant="outline"
                      disabled={busy !== null || loading || item.status === "blocked"}
                      onClick={() => void participate(item)}
                    >
                      {busy === item.id ? "正在处理…" : actionNames[item.status]}
                    </Button>
                  )}
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </section>
  );
}
