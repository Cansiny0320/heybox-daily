import { createFileRoute, Link } from "@tanstack/react-router";
import { publicPageHead, repositoryUrl } from "../lib/seo";

export const Route = createFileRoute("/help")({
  head: () =>
    publicPageHead(
      "/help",
      "小黑盒每日任务使用说明 · Heybox Daily",
      "查看 Heybox Daily 的小黑盒每日任务执行时间和奖励，了解如何重新登录、恢复自动运行和补跑未完成的任务。",
    ),
  component: Help,
});

function Help() {
  return (
    <article className="mx-auto max-w-6xl px-6 pt-14 pb-16 sm:px-8 sm:pt-16">
      <div className="max-w-2xl">
        <h1 className="text-3xl font-semibold tracking-tight">小黑盒每日任务使用说明</h1>
        <section className="mt-8 space-y-4 text-base leading-7">
          <h2 className="text-xl font-semibold">如何开始自动签到？</h2>
          <p>
            在
            <Link to="/login" className="underline underline-offset-4">
              登录页
            </Link>
            输入小黑盒手机号和短信验证码，按提示完成人机验证。首次登录成功后会开启自动任务，补跑当天未完成项。
          </p>
          <p>
            之后每天北京时间 00:30 开始执行每日签到、分享帖子、分享游戏和分享游戏评价。打开
            <Link to="/tasks" className="underline underline-offset-4">
              我的任务
            </Link>
            查看各项任务状态和本次获得的奖励。要核对经验或 H
            币变化，可在账号菜单进入「历史记录」，按日期查看「实际收益」。
          </p>
        </section>
        <section className="mt-10 space-y-4 text-base leading-7">
          <h2 className="text-xl font-semibold">多账号与任务管理</h2>
          <p>同一浏览器最多登录 5 个账号，在顶部账号菜单添加或切换。切换账号不会暂停任务。</p>
          <p>
            在“我的任务”可暂停、恢复或重试未完成任务。退出登录会暂停当前账号的自动任务并保留记录，其他账号不受影响；重新登录后会开启任务并补跑当天未完成项。
          </p>
          <p>
            删除托管数据会移除当前账号的登录态和任务记录，撤销该账号的网站会话，停止后续任务。已经发送的小黑盒请求无法撤回。
          </p>
        </section>
        <section className="mt-10 text-base leading-7">
          <h2 className="mb-4 text-xl font-semibold">常见问题</h2>
          <div className="divide-y border-y">
            <details className="py-4">
              <summary className="cursor-pointer font-medium">如何参与抽奖活动？</summary>
              <p className="mt-3 text-muted-foreground">
                在“我的任务”展开“抽奖活动”，选择要参与的活动。需要关注时，点击“关注并参与”会关注活动要求的账号；需要拥有游戏时，以小黑盒已同步的游戏库资格为准。参与后会完成分享任务，并显示核实后的抽奖券数量。
              </p>
            </details>
            <details className="py-4">
              <summary className="cursor-pointer font-medium">登录会影响手机 APP 吗？</summary>
              <p className="mt-3 text-muted-foreground">
                可能会让手机上的小黑盒退出登录。手机重新登录后，请留意网站上的任务状态。若「我的任务」提示需要重新登录小黑盒，点击提示旁的「重新登录」并完成短信验证。登录成功后会恢复自动任务，补跑当天未完成的项目。
              </p>
            </details>
            <details className="py-4">
              <summary className="cursor-pointer font-medium">分享任务会给好友发消息吗？</summary>
              <p className="mt-3 text-muted-foreground">
                不会真的给微信好友发消息，也不会替你发帖或写评价。任务结果会通过小黑盒任务接口核验。
              </p>
            </details>
            <details className="py-4">
              <summary className="cursor-pointer font-medium">任务失败了怎么办？</summary>
              <p className="mt-3 text-muted-foreground">
                先查看「我的任务」中任务列表下方的失败原因。如果页面显示预计自动重试时间，可以等到该时间再查看结果。接口暂时不可用时，可稍后点「重试未完成任务」。如果已暂停，打开「自动运行」即可补跑当天未完成的任务。页面提示已达当天执行上限时，等下一次定时执行。
              </p>
            </details>
            <details className="py-4">
              <summary className="cursor-pointer font-medium">可以自己部署吗？</summary>
              <p className="mt-3 text-muted-foreground">
                可以。项目代码采用 MIT License，支持 Docker Compose
                运行。服务器定时任务需自行配置，安装和更新步骤见{" "}
                <a
                  href={`${repositoryUrl}/blob/main/docs/usage.md`}
                  className="underline underline-offset-4"
                >
                  Docker 使用说明
                </a>
                。
              </p>
            </details>
          </div>
        </section>
        <p className="mt-8 text-sm leading-6 text-muted-foreground">
          Heybox Daily 是独立开源项目，与小黑盒官方无隶属关系。支持的任务和运行方式见
          <Link to="/about" className="underline underline-offset-4">
            Heybox Daily 项目介绍
          </Link>
          。数据处理方式见
          <Link to="/privacy" className="underline underline-offset-4">
            隐私说明
          </Link>
          ；遇到问题可在{" "}
          <a href={`${repositoryUrl}/issues`} className="underline underline-offset-4">
            GitHub 反馈
          </a>
          ，请勿附带手机号、验证码或 Cookie。
        </p>
      </div>
    </article>
  );
}
