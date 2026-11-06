<h1 align="center">Heybox Daily</h1>
<p align="center">小黑盒自动签到和每日任务，支持在线托管和 Docker 运行。</p>
<p align="center">
  <a href="https://github.com/Cansiny0320/heybox-daily/actions/workflows/ci.yml"><img src="https://github.com/Cansiny0320/heybox-daily/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License"></a>
</p>
<p align="center">
  <a href="https://heybox.cansiny.top/about">https://heybox.cansiny.top/about</a> ·
  <a href="https://heybox.cansiny.top/login">https://heybox.cansiny.top/login</a> ·
  <a href="#自部署">自部署</a> ·
  <a href="docs/usage.md">使用说明</a> ·
  <a href="https://github.com/Cansiny0320/heybox-daily/issues">问题反馈</a>
</p>

## 在线使用

在线登录后会自动运行当天任务，之后每天自动执行。

支持多账号登录和切换，可以查看任务结果、暂停、补跑或删除托管数据。退出登录会暂停当前账号的自动任务。

在“我的任务”展开“抽奖活动”，可按账号资格选择参与，完成分享并查看抽奖券。需要关注的活动会明确显示“关注并参与”。

## 自部署

服务器先装好 Docker 和 Docker Compose，然后拉取项目：

```bash
git clone https://github.com/Cansiny0320/heybox-daily.git
cd heybox-daily
```

构建镜像，按提示输入手机号和验证码：

```bash
docker compose build heybox login
docker compose run --rm login
```

登录后就可以查看和执行任务：

```bash
# 看今天的任务进度
docker compose run --rm heybox check

# 完成今天剩下的任务
docker compose run --rm heybox run
```

想每天自动运行，需要在服务器上加一个 cron 任务，配置方法和更新步骤见 [使用说明](docs/usage.md)。

网站的开发、部署和数据备份见 [网站部署说明](docs/hosting.md)。

## 几点说明

- 登录可能会让手机上的小黑盒退出登录。手机重新登录后，留意下一次任务是否正常。
- 提示登录过期时，在线使用的用户重新登录；自部署的用户执行 `docker compose run --rm login`。
- 这里的分享任务不会真的给微信好友发消息，也不会替你发帖或写评价。

## 反馈

有问题可以提 [Issue](https://github.com/Cansiny0320/heybox-daily/issues)，带上服务器架构和报错信息。发日志前先删掉账号、Cookie 等个人信息。

## 许可证

代码采用 [MIT License](LICENSE)，第三方代码和 APP 资源的许可说明见 [NOTICE.md](NOTICE.md)。

## 赞助

觉得好用的话，欢迎通过微信或支付宝支持一下。

![微信与支付宝赞助二维码](.github/sponsorship/sponsorship-cats.webp)
