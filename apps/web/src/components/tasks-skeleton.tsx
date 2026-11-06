import { taskIds, taskNames } from "@heybox/contracts/daily-tasks";

function Skeleton({ className }: { className: string }) {
  return (
    <div
      aria-hidden="true"
      className={`animate-pulse rounded-md bg-muted motion-reduce:animate-none ${className}`}
    />
  );
}

export function ActivityListSkeleton() {
  return (
    <div role="status" aria-label="正在读取活动">
      <span className="sr-only">正在读取活动…</span>
      <div aria-hidden="true">
        {[0, 1].map((row) => (
          <div
            key={row}
            className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4 border-t py-5"
          >
            <div className="min-w-0 flex-1 basis-56">
              <Skeleton className="h-6 w-64 max-w-full" />
              <Skeleton className="mt-1 h-6 w-40 max-w-full" />
            </div>
            <Skeleton className="h-10 w-20" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function TasksSkeleton() {
  return (
    <section
      className="mx-auto max-w-6xl px-6 pt-10 pb-12 sm:px-8 sm:pt-12"
      aria-busy="true"
      aria-label="每日任务"
    >
      <p role="status" className="sr-only">
        正在读取任务…
      </p>
      <div aria-hidden="true">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
          <h1 className="text-3xl font-semibold tracking-tight">每日任务</h1>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <span className="text-base font-medium">自动运行</span>
            <Skeleton className="h-6 w-10 rounded-full" />
            <Skeleton className="h-5 w-48" />
          </div>
        </div>
        <div className="mt-8">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 border-b pb-3 text-sm text-muted-foreground sm:grid-cols-[minmax(0,1fr)_minmax(140px,.7fr)_140px]">
            <span>任务</span>
            <span>状态</span>
            <span className="hidden sm:block">核验时间</span>
          </div>
          {taskIds.map((id) => (
            <div
              key={id}
              className="grid min-h-16 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b py-4 sm:grid-cols-[minmax(0,1fr)_minmax(140px,.7fr)_140px]"
            >
              <span className="text-base font-medium">{taskNames[id]}</span>
              <Skeleton className="h-5 w-20" />
              <Skeleton className="hidden h-5 w-14 sm:block" />
            </div>
          ))}
        </div>
        <div className="mt-12">
          <h2 className="text-2xl font-semibold tracking-tight">抽奖活动</h2>
        </div>
      </div>
    </section>
  );
}
