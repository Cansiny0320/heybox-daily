import { os, ORPCError } from "@orpc/server";
import { z } from "zod";
import { sessionAuth } from "./session-auth.ts";
import { Store } from "@heybox/hosting/store";
import type { Env } from "./env.ts";
import { notifyRunnerInBackground } from "./notify.ts";
import { activityConsentSchema } from "@heybox/contracts";
import { activityRequest } from "./activities.ts";

const authenticated = os
  .$context<{ env: Env; request: Request; execution: Pick<ExecutionContext, "waitUntil"> }>()
  .use(async ({ context, next }) => {
    const session = await sessionAuth(context.env).api.getSession({
      headers: context.request.headers,
    });
    if (!session) throw new ORPCError("UNAUTHORIZED", { message: "请先登录" });
    return next({ context: { userId: session.user.id, store: new Store(context.env.DB) } });
  });
const accountInput = z.object({ expectedAccount: z.string().min(1).max(64) });
function checkAccount(userId: string, expectedAccount: string) {
  if (userId !== `heybox:${expectedAccount}`)
    throw new ORPCError("CONFLICT", { message: "当前账号已变化，请刷新页面后重试" });
}
export const router = {
  activities: authenticated.input(accountInput).handler(async ({ context, input }) => {
    const result = await activityRequest(
      context.env,
      context.store,
      context.userId,
      {
        mode: "list",
        ...input,
      },
      context.request.signal,
    );
    if (result.mode !== "list") throw new ORPCError("BAD_GATEWAY");
    return result.activities;
  }),
  participateActivity: authenticated
    .input(accountInput.extend(activityConsentSchema.shape))
    .handler(async ({ context, input }) => {
      const result = await activityRequest(
        context.env,
        context.store,
        context.userId,
        {
          mode: "participate",
          ...input,
        },
        context.request.signal,
      );
      if (result.mode !== "participate") throw new ORPCError("BAD_GATEWAY");
      return result.activity;
    }),
  dashboard: authenticated
    .input(z.object({ includeHistory: z.boolean().optional() }).optional())
    .handler(async ({ context, input }) => {
      const dashboard = await context.store.dashboard(
        context.userId,
        input?.includeHistory ?? true,
      );
      if (!dashboard) throw new ORPCError("UNAUTHORIZED", { message: "请重新登录" });
      return dashboard;
    }),
  history: authenticated.handler(async ({ context }) => {
    const history = await context.store.history(context.userId);
    if (!history) throw new ORPCError("UNAUTHORIZED", { message: "请重新登录" });
    return history;
  }),
  setEnabled: authenticated
    .input(accountInput.extend({ enabled: z.boolean() }))
    .handler(async ({ context, input }) => {
      checkAccount(context.userId, input.expectedAccount);
      await context.store.setEnabled(context.userId, input.enabled);
      if (input.enabled) notifyRunnerInBackground(context.env, context.execution);
      return { ok: true };
    }),
  retry: authenticated.input(accountInput).handler(async ({ context, input }) => {
    checkAccount(context.userId, input.expectedAccount);
    if (!(await context.store.quota(`retry:${context.userId}`, 3, 3600_000)))
      throw new ORPCError("TOO_MANY_REQUESTS", { message: "补跑次数过多，请稍后重试" });
    await context.store.enqueue(context.userId, true);
    notifyRunnerInBackground(context.env, context.execution);
    return { ok: true };
  }),
  deleteAccount: authenticated
    .input(accountInput.extend({ confirm: z.literal(true) }))
    .handler(async ({ context, input }) => {
      checkAccount(context.userId, input.expectedAccount);
      await context.store.deleteUser(context.userId);
      return { ok: true };
    }),
};
