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
| `WECOM_WEBHOOK` | 企微群机器人 webhook 地址（和 `FEISHU_WEBHOOK` 至少填一个） |
| `CLOUDFLARE_API_TOKEN` | 上一步的 API Token |
| `FEISHU_WEBHOOK` 等 | 可选，推送到飞书群，见下方「飞书推送」 |
| `CLOUDFLARE_ACCOUNT_ID` | 可选。不填会用 Token 自动获取；只有一个 Cloudflare 账号下有多个 Account 时才需要填（浏览器地址栏 `dash.cloudflare.com/` 后面那串 32 位字符） |

### 3. 部署
仓库 → Actions → 选「部署 Cloudflare Worker（每分钟转发）」→ Run workflow。
跑成功（绿色 ✓）就部署好了，之后每分钟自动检查。

以后修改 `worker/` 里的文件并推送，会自动重新部署。

## 飞书推送（可选）

除了企业微信，也可以同时推送到飞书群。每条频道消息在飞书里是一条富文本消息：正文 + 「查看原帖」链接 + 图片。

### 1. 群机器人（必需）
1. 飞书里打开要接收消息的群 → 右上角「…」→「设置」→「群机器人」→「添加机器人」→「自定义机器人」。
2. 起个名字，**复制 webhook 地址**。
3. 安全设置建议勾选「签名校验」，**复制密钥**。不要勾选「自定义关键词」（会导致消息被拦截）。

### 2. 自建应用（用来发图片，可选）
飞书群机器人不能直接发图片，要先用一个「应用」把图片上传到飞书。不配也能用，只是图片要点原帖查看。
1. 打开 [飞书开放平台](https://open.feishu.cn/app) →「创建企业自建应用」，名字随意。
2. 左侧「添加应用能力」→ 添加「**机器人**」。
3. 左侧「权限管理」→ 搜索并开通「**获取与上传图片或文件资源**」（`im:resource`）。
4. 左侧「版本管理与发布」→ 创建版本 → 申请发布（自己是管理员的话直接通过）。
5. 左侧「凭证与基础信息」→ 复制 **App ID** 和 **App Secret**。

### 3. 添加 GitHub Secrets 并重新部署
| Name | Value |
|---|---|
| `FEISHU_WEBHOOK` | 群机器人 webhook 地址 |
| `FEISHU_SECRET` | 签名校验的密钥（开启了签名校验才填） |
| `FEISHU_APP_ID` | 自建应用 App ID（发图片用） |
| `FEISHU_APP_SECRET` | 自建应用 App Secret（发图片用） |

同时配置企业微信和飞书时两边都会收到；飞书出错不影响企业微信。想停用某一边，删掉对应的 Secret 后重新部署即可。

## 说明

- 首次运行只记录当前位置，不会把历史消息刷屏；如果之前用过 GitHub Actions 版本，会接着 `state.json` 里的进度转发。
- 进度保存在 Cloudflare KV（`tg2wecom-state`），由 Worker 自动维护。
- 想换频道：改 `worker/wrangler.toml` 里的 `TG_CHANNEL`，推送后自动重新部署，新频道会从当前位置开始。
- 视频、文件无法转发，会附原帖链接；超过 2MB 的图片也只附链接。
- 想看频道每天发多少条：Actions →「统计频道发帖量」→ Run workflow。
- 企微接口报错（比如 webhook 失效）时不会推进进度，恢复后会补发，不会漏消息。
- 查看运行日志：Cloudflare 控制台 → Workers & Pages → tg2wecom → Logs。

## 备用：GitHub Actions 版本

`forward.py` + `.github/workflows/forward.yml` 是最初的版本（每 5～15 分钟一次），定时任务已经停用，只保留手动运行。
不要和 Worker 同时开着，否则会重复转发。
