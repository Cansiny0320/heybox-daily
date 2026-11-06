import { createFileRoute, Link } from "@tanstack/react-router";
import { useAccount } from "../components/layout";
import { publicPageHead, repositoryUrl, siteDescription, websiteData } from "../lib/seo";

export const Route = createFileRoute("/about")({
  head: () => {
    const head = publicPageHead(
      "/about",
      "小黑盒自动签到与每日任务 · Heybox Daily",
      siteDescription,
    );
    return {
      ...head,
      scripts: [
        {
          type: "application/ld+json",
          children: JSON.stringify(websiteData).replace(/</g, "\\u003c"),
        },
      ],
    };
  },
  component: About,
});

function About() {
  const { account } = useAccount();
  return (
    <article className="mx-auto max-w-6xl px-6 pt-14 pb-16 sm:px-8 sm:pt-20">
      <div className="max-w-2xl">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          小黑盒自动签到与每日任务
        </h1>
        <p className="mt-6 text-lg leading-8 text-muted-foreground">
          Heybox Daily
          支持每日签到、分享帖子、分享游戏和分享游戏评价。在线登录后自动执行，也可以通过 Docker
          自部署。
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-6">
          <Link
            to={account ? "/tasks" : "/login"}
            className="inline-flex h-11 items-center justify-center rounded-lg bg-primary px-5 text-base font-medium text-primary-foreground hover:bg-primary/80"
          >
            {account ? "我的任务" : "登录并开启任务"}
          </Link>
        </div>
        <section className="mt-14 border-t pt-8 text-base leading-7">
          <h2 className="text-xl font-semibold">在线使用</h2>
          <p className="mt-4">
            用小黑盒手机号和短信验证码登录，首次登录会补跑当天未完成的任务，之后每天北京时间 00:30
            开始执行。
          </p>
          <p className="mt-4">
            在线托管免费使用，支持在同一浏览器切换账号。每个账号单独管理任务，退出登录会暂停当前账号的自动任务。
          </p>
        </section>
        <section className="mt-10 border-t pt-8 text-base leading-7">
          <h2 className="text-xl font-semibold">怎么确认签到成功？</h2>
          <p className="mt-4">
            登录后打开「我的任务」，查看「每日签到」是否显示「已完成」。桌面端的任务列表还会显示核验时间。「本次获得」会列出实际取得的奖励。要核对往日的执行状态和收益，可以从账号菜单打开「历史记录」。
          </p>
          <p className="mt-4">
            <Link to="/help" className="underline underline-offset-4">
              查看小黑盒每日任务使用说明
            </Link>
          </p>
        </section>
        <section className="mt-10 border-t pt-8 text-base leading-7">
          <h2 className="text-xl font-semibold">Docker 自部署</h2>
          <p className="mt-4">
            项目代码采用 MIT License，可在自己的服务器通过 Docker Compose 运行，定时任务需自行配置。
          </p>
          <p className="mt-4">
            <a
              href={`${repositoryUrl}/blob/main/docs/usage.md`}
              className="underline underline-offset-4"
            >
              查看安装和更新步骤
            </a>
          </p>
        </section>
        <p className="mt-10 text-sm leading-6 text-muted-foreground">
          Heybox Daily 是独立开源项目，与小黑盒官方无隶属关系。登录可能让手机 APP
          退出；登录态失效时需要重新登录。数据处理方式见
          <Link to="/privacy" className="underline underline-offset-4">
            隐私说明
          </Link>
          。
        </p>
      </div>
    </article>
  );
}
