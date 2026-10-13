# TG 频道 → 企业微信 自动转发

每 5 分钟抓取 Telegram 公开频道 的网页版，把新消息（文字 + 图片 + 原帖链接）推送到企业微信群机器人。不需要服务器，不需要 Telegram 账号。

## 部署（约 3 分钟）

1. 在 GitHub 新建一个 **Public** 仓库，把本目录所有文件上传（注意 `.github/workflows/forward.yml` 的路径要保持）。
   公开仓库的 Actions 免费不限时长；私有仓库每月只有 2000 分钟，按 5 分钟一次会超额。webhook 放在 Secrets 里，公开仓库也不会泄露。
2. 仓库 → Settings → Secrets and variables → Actions → New repository secret
   - Name: `WECOM_WEBHOOK`
   - Value: 企微群机器人 webhook 地址
3. 仓库 → Actions → 选中「TG 频道转发到企业微信」→ Run workflow，手动跑一次。
   企微群收到「✅ 已开始监听」就说明通了，之后每 5 分钟自动检查。

## 说明

- 首次运行只记录当前位置，不会把历史消息刷屏。
- 进度存在 `state.json`，由 Actions 自动提交回仓库。
- 想换频道：改 `forward.yml` 里的 `TG_CHANNEL`，并删掉 `state.json`。
- 延迟：GitHub 定时任务高峰期会排队，实际间隔常在 5～15 分钟。
- 视频、文件无法转发，会附原帖链接。
