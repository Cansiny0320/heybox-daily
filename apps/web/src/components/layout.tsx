import { Link } from "@tanstack/react-router";
import {
  createContext,
  useContext,
  useEffect,
  useCallback,
  useState,
  lazy,
  Suspense,
  type ReactNode,
} from "react";
import { ChevronDown, TriangleAlert } from "lucide-react";
import { Button } from "./ui/button";
import { AccountAvatar } from "./account-avatar";
import { readAccounts, type Account } from "../lib/accounts";
export type { Account } from "../lib/accounts";
import { readableError } from "../lib/utils";
import { isPreview } from "../lib/deployment";
import { repositoryUrl } from "../lib/seo";

const AccountMenu = lazy(() => import("./account-menu"));
const Modal = lazy(() => import("./dialog").then(({ Modal }) => ({ default: Modal })));

const AccountContext = createContext<{
  account: Account | null;
  setAccount: (account: Account | null) => void;
  refreshAccounts: () => Promise<void>;
}>({ account: null, setAccount: () => {}, refreshAccounts: async () => {} });
export const useAccount = () => useContext(AccountContext);

export function Layout({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<Account | null>(null);
  const [info, setInfo] = useState<"error" | "delete" | "logout" | null>(null);
  const [actionAccount, setActionAccount] = useState<Account | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refreshAccounts = useCallback(async () => {
    const value = await readAccounts();
    setAccounts(value.accounts);
    setAccount(value.accounts.find((item) => item.account === value.activeAccount) || null);
  }, []);
  useEffect(() => {
    void refreshAccounts().catch(() => {});
    const refresh = () => {
      void refreshAccounts().catch(() => {});
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refreshAccounts]);
  useEffect(() => {
    let disposed = false;
    let pending = false;
    const refresh = async () => {
      if (document.visibilityState !== "visible" || pending) return;
      pending = true;
      try {
        const response = await fetch("/api/stats");
        if (!response.ok) return;
        const value = (await response.json()) as { accounts: number };
        if (!disposed) setCount(value.accounts);
      } catch {
        /* Keep the last known count during a network interruption. */
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 300_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      disposed = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  async function switchAccount(target: Account) {
    setBusy(true);
    try {
      const { authRequest } = await import("../lib/auth-client");
      await authRequest("heybox/switch", { account: target.account });
      window.location.assign("/tasks");
    } catch (e) {
      setError(readableError(e));
      setInfo("error");
      setBusy(false);
    }
  }
  async function leave(remove: boolean) {
    if (!actionAccount) return;
    setBusy(true);
    setError("");
    try {
      const { authRequest } = await import("../lib/auth-client");
      const result = await authRequest<{ account: string | null }>(
        remove ? "heybox/delete" : "heybox/logout",
        {
          expectedAccount: actionAccount.account,
          ...(remove ? { confirm: true } : {}),
        },
      );
      window.location.assign(result.account ? "/tasks" : "/login");
    } catch (e) {
      setError(readableError(e));
      setBusy(false);
    }
  }
  function confirmAction(action: "logout" | "delete") {
    setActionAccount(account);
    setError("");
    setInfo(action);
  }
  return (
    <AccountContext.Provider value={{ account, setAccount, refreshAccounts }}>
      <div className="flex min-h-dvh flex-col">
        {isPreview && (
          <div
            role="status"
            className="border-b bg-muted px-6 py-2 text-center text-xs text-muted-foreground"
          >
            预发布演示 · 使用模拟数据
          </div>
        )}
        <header className="border-b">
          <div className="mx-auto flex h-20 max-w-6xl items-center justify-between gap-4 px-6 sm:px-8">
            <div className="flex shrink-0 items-center gap-3 text-foreground">
              <Link
                to="/"
                className="shrink-0 whitespace-nowrap text-xl font-semibold tracking-tight sm:text-2xl"
              >
                Heybox
              </Link>
              <a
                href={repositoryUrl}
                target="_blank"
                rel="noreferrer"
                aria-label="GitHub 仓库"
                title="GitHub 仓库"
                className="inline-flex shrink-0 text-foreground"
              >
                <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="size-6">
                  <path d="M12 .75a11.25 11.25 0 0 0-3.558 21.923c.563.105.77-.244.77-.542 0-.267-.01-.975-.015-1.914-3.13.68-3.79-1.509-3.79-1.509-.512-1.3-1.25-1.646-1.25-1.646-1.022-.699.077-.685.077-.685 1.13.08 1.725 1.16 1.725 1.16 1.005 1.723 2.636 1.225 3.278.937.103-.728.393-1.225.715-1.507-2.499-.284-5.126-1.25-5.126-5.563 0-1.229.44-2.233 1.16-3.02-.116-.284-.503-1.429.11-2.978 0 0 .945-.302 3.094 1.154A10.79 10.79 0 0 1 12 6.191a10.8 10.8 0 0 1 2.818.379c2.148-1.456 3.091-1.154 3.091-1.154.615 1.549.228 2.694.112 2.978.722.787 1.159 1.791 1.159 3.02 0 4.324-2.631 5.276-5.138 5.555.404.349.765 1.039.765 2.094 0 1.512-.014 2.732-.014 3.103 0 .301.203.653.774.542A11.25 11.25 0 0 0 12 .75Z" />
                </svg>
              </a>
            </div>
            <nav
              aria-label="主导航"
              className="flex min-w-0 items-center justify-end gap-3 text-base sm:gap-8"
            >
              {account && (
                <>
                  <Link
                    to="/tasks"
                    className="hidden text-muted-foreground hover:text-foreground sm:block"
                    activeProps={{ className: "text-foreground" }}
                  >
                    我的任务
                  </Link>
                  <Link
                    to="/history"
                    className="hidden text-muted-foreground hover:text-foreground sm:block"
                    activeProps={{ className: "text-foreground" }}
                  >
                    历史记录
                  </Link>
                </>
              )}
              <Link
                to="/sponsor"
                className="shrink-0 whitespace-nowrap text-muted-foreground hover:text-foreground"
                activeProps={{ className: "text-foreground" }}
              >
                赞助
              </Link>
              {account || accounts.length ? (
                <Suspense
                  fallback={
                    <Button
                      variant="ghost"
                      className="h-11 max-w-44 gap-2.5 px-2 text-base"
                      disabled
                      aria-label="账号菜单"
                    >
                      <AccountAvatar account={account} />
                      <span className="truncate">
                        {account?.nickname || account?.account || "选择账号"}
                      </span>
                      <ChevronDown className="size-4" />
                    </Button>
                  }
                >
                  <AccountMenu
                    account={account}
                    accounts={accounts}
                    busy={busy}
                    onSwitch={switchAccount}
                    onAction={confirmAction}
                  />
                </Suspense>
              ) : (
                <Link
                  to="/login"
                  className="shrink-0 whitespace-nowrap text-muted-foreground hover:text-foreground"
                  activeOptions={{ exact: true, includeSearch: false }}
                  activeProps={{ className: "hidden" }}
                >
                  登录
                </Link>
              )}
            </nav>
          </div>
        </header>
        <aside
          aria-label="防诈骗提示"
          className="border-b border-amber-200 bg-amber-50 text-amber-950"
        >
          <div className="mx-auto flex max-w-6xl items-start gap-3 px-6 py-3 text-sm leading-6 sm:px-8">
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
            <p>
              <strong>Heybox Daily 是完全免费的开源项目。</strong>
              如果你是付费购买的，可能遭遇了盗卖或诈骗。请认准
              <a href={repositoryUrl} target="_blank" rel="noreferrer" className="underline">
                GitHub 项目仓库
              </a>
              。
              <span className="block">
                本网站免费提供服务，如果你觉得好用，欢迎
                <Link to="/sponsor" className="underline">
                  赞助支持
                </Link>
                。
              </span>
            </p>
          </div>
        </aside>
        <main className="flex-1">{children}</main>
        <footer className="mx-auto w-full max-w-6xl px-6 pb-8 text-sm text-muted-foreground sm:px-8">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-t pt-6">
            <Link to="/about">关于</Link>
            <Link to="/help">使用说明</Link>
            <Link to="/privacy">隐私说明</Link>
            {count !== null && (
              <span className="ml-auto">已接入 {count.toLocaleString("zh-CN")} 个账号</span>
            )}
          </div>
        </footer>
      </div>
      <Suspense fallback={null}>
        {info !== null && (
          <Modal
            open={info !== null}
            onOpenChange={(open) => {
              if (!open && !busy) setInfo(null);
            }}
            title={
              info === "delete"
                ? "删除托管数据？"
                : info === "logout"
                  ? "退出当前账号？"
                  : "操作失败"
            }
          >
            {info === "delete" || info === "logout" ? (
              <>
                <p className="text-base leading-7 text-muted-foreground">
                  {info === "logout"
                    ? `退出后将暂停「${actionAccount?.nickname || actionAccount?.account}」的自动任务，保留登录态和历史记录。其他账号不受影响。`
                    : `这会删除「${actionAccount?.nickname || actionAccount?.account}」的登录态和任务记录，并退出该账号。其他账号不受影响，已发送的小黑盒请求无法撤回。`}
                </p>
                {error && (
                  <p role="alert" className="mt-4 text-sm text-destructive">
                    {error}
                  </p>
                )}
                <div className="mt-6 flex justify-end gap-3">
                  <Button variant="outline" disabled={busy} onClick={() => setInfo(null)}>
                    取消
                  </Button>
                  <Button
                    variant={info === "delete" ? "destructive" : "default"}
                    disabled={busy}
                    onClick={() => leave(info === "delete")}
                  >
                    {busy ? "正在处理…" : info === "delete" ? "删除数据" : "退出登录"}
                  </Button>
                </div>
              </>
            ) : (
              <p role="alert" className="text-base leading-7 text-destructive">
                {error}
              </p>
            )}
          </Modal>
        )}
      </Suspense>
    </AccountContext.Provider>
  );
}
