# TG 频道 → 企业微信 自动转发

抓取 Telegram 公开频道的网页版，把新消息（文字 + 图片 + 原帖链接）推送到企业微信群机器人。不需要服务器，也不需要 Telegram 账号。

运行在 **Cloudflare Workers**（免费）上，每分钟检查一次，新消息一般 1 分钟内就会转到群里。代码在 `worker/`，通过 GitHub Actions 自动部署。

## 部署

### 1. 准备 Cloudflare
1. 注册并登录 [Cloudflare](https://dash.cloudflare.com/sign-up)，免费套餐就够。
2. **API Token**：右上角头像 → My Profile → API Tokens → Create Token →
   选「**Edit Cloudflare Workers**」模板 → Account Resources 选你的账号，Zone Resources 选 All zones →
   Continue → Create Token → 复制 Token（只显示一次）。

### 2. 添加 GitHub Secrets
仓库 → Settings → Secrets and variables → Actions → New repository secret：

| Name | Value |
|---|---|
| `WECOM_WEBHOOK` | 企微群机器人 webhook 地址（和 `NTFY_URL` 至少填一个） |
| `CLOUDFLARE_API_TOKEN` | 上一步的 API Token |
| `NTFY_URL` | 可选，推送到 ntfy App，见下方「手机 App 推送（ntfy）」 |
| `NTFY_TOKEN` | 可选，ntfy 访问令牌（用自己的 ntfy 账号或服务器时才需要） |
| `CLOUDFLARE_ACCOUNT_ID` | 可选。不填会用 Token 自动获取；只有一个 Cloudflare 账号下有多个 Account 时才需要填（浏览器地址栏 `dash.cloudflare.com/` 后面那串 32 位字符） |

### 3. 部署
仓库 → Actions → 选「部署 Cloudflare Worker（每分钟转发）」→ Run workflow。
跑成功（绿色 ✓）就部署好了，之后每分钟自动检查。

以后修改 `worker/` 里的文件并推送，会自动重新部署。

## 手机 App 推送（ntfy）

除了企业微信，也可以推送到手机上的 [ntfy](https://ntfy.sh) App（开源，安卓不依赖谷歌推送，国内手机也能用）。图片会作为附件上传，国内也能直接看到。

1. 想一个别人猜不到的主题名，比如 `tg-` 加一串随机字符。**主题名就相当于密码**，知道的人都能收到消息。
2. 仓库 Secrets 里添加 `NTFY_URL` = `https://ntfy.sh/<主题名>`，然后重新运行部署。
3. 手机安装 ntfy（安卓：应用商店、F-Droid 或 GitHub Releases；iOS：App Store），点「+」订阅同一个主题名。
4. 安卓上建议：设置里开启「即时送达」(Instant delivery)，并在系统设置里允许 ntfy 后台运行、关闭电池优化，否则可能收不到或有延迟。

同时配置企业微信和 ntfy 时，两边都会收到；ntfy 出错不影响企业微信。想停用某一边，删掉对应的 Secret 后重新部署即可。

## 说明

- 首次运行只记录当前位置，不会把历史消息刷屏；如果之前用过 GitHub Actions 版本，会接着 `state.json` 里的进度转发。
- 进度保存在 Cloudflare KV（`tg2wecom-state`），由 Worker 自动维护。
- 想换频道：改 `worker/wrangler.toml` 里的 `TG_CHANNEL`，推送后自动重新部署，新频道会从当前位置开始。
- 视频、文件无法转发，会附原帖链接；超过 2MB 的图片也只附链接。
- 企微接口报错（比如 webhook 失效）时不会推进进度，恢复后会补发，不会漏消息。
- 查看运行日志：Cloudflare 控制台 → Workers & Pages → tg2wecom → Logs。

## 备用：GitHub Actions 版本

`forward.py` + `.github/workflows/forward.yml` 是最初的版本（每 5～15 分钟一次），定时任务已经停用，只保留手动运行。
不要和 Worker 同时开着，否则会重复转发。
