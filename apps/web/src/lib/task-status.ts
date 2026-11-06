import type { Outcome } from "@heybox/contracts";
import { taskIds } from "@heybox/contracts/daily-tasks";

export const statusNames: Record<string, string> = {
  queued: "等待执行",
  running: "正在执行",
  completed: "已完成",
  skipped: "已跳过",
  failed: "未完成",
  cancelled: "已停止",
  auth_expired: "需要重新登录",
  waiting: "未执行",
  confirming: "等待确认",
};

export function taskStatus(id: (typeof taskIds)[number], status?: string, result?: Outcome | null) {
  if (result?.snapshot?.tasks.find((task) => task.id === id)?.state === "finish")
    return !result.uncertain && result.execution?.[id] === "skipped" ? "skipped" : "completed";
  if (status === "failed" || status === "auth_expired") return "failed";
  if (status === "running" || status === "queued") return "confirming";
  return "waiting";
}

export function runStatus(status: string, result?: Outcome | null) {
  return status === "completed" &&
    !result?.uncertain &&
    taskIds.every((id) => result?.execution?.[id] === "skipped")
    ? "skipped"
    : status;
}
