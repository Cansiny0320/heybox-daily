import { LoginFailure, loginFailureSchema } from "@heybox/contracts";
import { loginLimitMessages, smsCooldownSchema, type SmsCooldown } from "./login-cooldown.ts";

export async function authRequest<T>(
  path: string,
  body: unknown,
  onCooldown?: (cooldown: SmsCooldown, authoritative?: boolean) => void,
): Promise<T> {
  const response = await fetch(`/api/auth/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response.json()) as T & {
    message?: string;
    smsCooldown?: unknown;
    code?: string;
  };
  const cooldown = smsCooldownSchema.safeParse(data.smsCooldown);
  if (cooldown.success) onCooldown?.(cooldown.data, true);
  if (!response.ok) {
    const failure = loginFailureSchema.safeParse(data);
    if (failure.success) throw new LoginFailure(failure.data.code, failure.data.retryAt);
    if (response.status === 429 && data.code !== "rate_limited") {
      const retryAfter = Number(
        response.headers.get("retry-after") ?? response.headers.get("x-retry-after"),
      );
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        const serverTime = Date.now();
        onCooldown?.(
          {
            serverTime,
            limits: [{ rule: "auth:ip:endpoint", retryAt: serverTime + retryAfter * 1000 }],
          },
          false,
        );
      }
      throw new Error(loginLimitMessages["auth:ip:endpoint"]);
    }
    throw new Error(data.message || "请求未完成，请稍后重试");
  }
  return data;
}
