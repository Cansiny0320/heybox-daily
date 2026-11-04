import { createRootRoute, HeadContent, Outlet, Scripts, Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Layout } from "../components/layout";
import css from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Heybox Daily" },
      { name: "description", content: "小黑盒每日签到和每日任务托管" },
      { name: "robots", content: "noindex, follow" },
    ],
    links: [
      { rel: "stylesheet", href: css },
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
    ],
  }),
  component: () => (
    <Layout>
      <Outlet />
    </Layout>
  ),
  shellComponent: RootDocument,
  notFoundComponent: () => (
    <div className="mx-auto max-w-5xl px-8 py-24">
      <h1 className="mb-6 text-2xl font-semibold">页面不存在</h1>
      <Link to="/" className="text-sm underline">
        返回首页
      </Link>
    </div>
  ),
  errorComponent: () => (
    <div className="mx-auto max-w-5xl px-8 py-24">
      <p>页面暂时无法加载，请刷新后重试。</p>
    </div>
  ),
});
function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <head>
        <HeadContent />
        <meta name="baidu-site-verification" content="codeva-wVGtIq5ea2" />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
