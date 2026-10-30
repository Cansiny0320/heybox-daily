import { beijingDate } from "@heybox/contracts";
import type { client } from "./client.ts";

export type DashboardData = Awaited<ReturnType<typeof client.dashboard>>;
const active = (data: DashboardData) => ["queued", "running"].includes(data.today?.status || "");

type PollRow = { status: string; date: string; retryAt?: number | null };
export function historyPollInterval(rows: readonly PollRow[] | undefined, now = Date.now()) {
  const day = beijingDate(now);
  const midnight = Date.parse(`${day}T00:00:00+08:00`) + 86400_000;
  let interval = rows ? 300_000 : 60_000;
  for (const row of rows || []) {
    if (row.date !== day) continue;
    if (row.status === "running") interval = Math.min(interval, 5_000);
    if (row.status === "queued")
      interval = Math.min(
        interval,
        row.retryAt != null && row.retryAt > now ? Math.min(60_000, row.retryAt - now) : 5_000,
      );
  }
  return Math.max(1_000, Math.min(interval, midnight - now));
}
export function dashboardPollInterval(today: DashboardData["today"] | undefined, now = Date.now()) {
  return historyPollInterval(today === undefined ? undefined : today ? [today] : [], now);
}

export function createDashboardLoader(
  read: (includeHistory: boolean) => Promise<DashboardData>,
  day = () => beijingDate(),
  includeHistory = true,
) {
  let current: DashboardData | undefined;
  let loadedDay: string | undefined;
  let pending: Promise<DashboardData> | undefined;
  async function refresh(full: boolean) {
    if (!includeHistory) return read(false);
    const date = day();
    const previous = current;
    full ||= !previous || loadedDay !== date;
    let value = await read(full);
    if (
      !full &&
      previous &&
      (value.account !== previous.account ||
        value.today?.date !== previous.today?.date ||
        (active(previous) && !active(value)))
    ) {
      value = await read(true);
      full = true;
    }
    current = full
      ? value
      : {
          ...value,
          history: previous!.history.map((row) =>
            value.today && row.id === value.today.id ? value.today : row,
          ),
        };
    loadedDay = date;
    return current;
  }
  function load(full = false): Promise<DashboardData> {
    if (pending && !full) return pending;
    // Queue mutation refreshes after older reads; later polls join the newest read.
    const work = pending ? pending.catch(() => {}).then(() => refresh(true)) : refresh(full);
    const tracked = work.finally(() => {
      if (pending === tracked) pending = undefined;
    });
    pending = tracked;
    return tracked;
  }
  return { load };
}
