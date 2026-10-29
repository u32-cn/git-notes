# Git笔记（git-notes）

![数据的掌控权必须留在本地](web/assets/help-syc.png)

> **"AI 时代，数据的掌控权必须留在本地，不被任何一家 SaaS 供应商绑定。"**

本地 git 仓库架构的微笔记信息流。**两种模式**：

- **仅本机使用**：`git init` 本地仓库，零配置零依赖（只需 git），数据只在 `~/.git-notes/repo`
- **绑定远端**：任意 git 服务器（SSH/HTTPS/本地路径均可，地址自己填），自动 `fetch + rebase/merge + push` 多设备同步

数据格式沿用 `micro/YYYY/MM/YYYYMMDD-HHMMSS.md`（front matter: type/tags/created/images/files）与 `settings/tags.json`，commit 规范 `micro: add|update|delete <摘要>` / `settings: add|remove tag <名>`。支持配图（≤9 张）与**任意附件**（单个 ≤10MB、每帖 ≤9 个，原始文件名保留在 `files:` 字段；附件经 `/media/` 一律以下载形式给出）。

## 特点

**数据留在本地，通过远端 git 库同步，不被任何一家 SaaS 供应商绑定。**

<table>
<tr>
<td width="33%" align="center"><img src="web/assets/help-store-free.png" alt="存储自由" /><br><b>存储自由，随时搬家</b><br>远端可自建或放 GitHub / Gitee / 阿里云云效（均免费），换地址即搬家，零锁定</td>
<td width="33%" align="center"><img src="web/assets/help-ai-friendly.png" alt="AI 友好" /><br><b>数据在本地，AI 更友好</b><br>内置 AI 助手直接读写本地笔记：检索、批量整理、找回历史版本</td>
<td width="33%" align="center"><img src="web/assets/help-git-history.png" alt="git 历史" /><br><b>全量历史，随时追溯</b><br>每步操作都是 git 提交，误删可找回，任何版本可回看</td>
</tr>
</table>

更多介绍见[帮助文档](docs/help.md)。

## 使用

```bash
cd web
npm i -g .          # 全局安装
git-notes           # 启动并打开 http://127.0.0.1:8644；status / stop / -v / help
```

- 依赖：Node ≥ 18、系统 PATH 有 git（SSH 远端另需 ssh-keygen，Git for Windows 自带）。
- 安卓端：APK（Kotlin + JGit 移植同一套服务与界面，功能与 PC 版一致、可多端同步），见 `android/README.md`。
- 首次打开页面出引导页：**「仅本机使用」**一键开始；或 **「从远端仓库克隆」**（填仓库地址；SSH 地址时程序自动生成专用 ed25519 密钥，把公钥贴到 git 服务器后重试克隆）。
- 设置页「绑定远端」：随时把仅本机模式升级为多设备同步——填地址 → 探测 → 确认。远端为空仓则直接推送本地历史；远端已有笔记则提示合并预览（本地提交叠加到远端历史之上）；也可「解绑」回到仅本机（本地与远端数据都不动）。

## 同步与冲突策略

- 写操作（发布/编辑/删除/改标签）= 先同步拉齐远端 → 本地写文件 → 单个 commit → push（被拒自动整合重试 ≤3 次）。
- 整合策略：**优先 rebase，其次 merge（--allow-unrelated-histories）**；仍冲突则进入「冲突待处理」，页面提供**「强制推送（本地为准）」**（覆盖远端历史，远端本地没有的提交将丢失，按钮有二次确认）；AI 分析处理为后续版本。
- 全库搜索：服务端扫本地仓库全部笔记，词 AND 语义、命中高亮，毫秒级；**支持拼音与首字母**（如 `biji`/`bj` 命中「笔记」，内置 8105 常用字拼音表）。
- 分支：**定死 `main`，不可改**（2026-10-27 起，设置页无分支项）。本地 main ↔ 远端 origin/main；远端没有 main（空仓或只有 master 等旧分支）时绑定/同步会直接把本地 main 推上去建立，远端旧分支与 HEAD 不动；AI 工具 `git_branch` 仅剩列表（无创建/切换）。
- 长笔记（>10 行）信息流自动折叠，可展开/收起；灯箱图片右键菜单支持「复制图片 / 保存图片」。

## 架构与安全

```
web/（前端：index.html + assets/app.css + js/*.js，无构建无 CDN，全局作用域按序加载）
   │ 同源 fetch /api/*（cookie 凭证，服务启动时生成）+ /assets/* /js/* 静态文件
web/server.js（Node ≥18 零 npm 依赖，spawn 系统 git）
   │ 只绑 127.0.0.1:8644
   ▼
本地仓库 ~/.git-notes/repo ──fetch/rebase/push（SSH 专用密钥 ~/.git-notes/keys/）──▶ 任意 git 服务器
```

- 服务只绑 `127.0.0.1`；页面凭证用随机 cookie（SameSite=Lax, HttpOnly）+ Host 校验（防跨站驱动/DNS rebinding）；日志不打印请求头、cookie 与查询串。
- SSH 专用密钥按需自动生成（不复用 `~/.ssh`），首次连接 TOFU（`StrictHostKeyChecking=accept-new`）；私钥 0600。
- 写路径白名单：仅 `micro/` 与 `settings/main.json`，严禁全仓提交；删除以 git 提交落地，历史可找回。

## 验证

无自动化测试框架；改动后用浏览器全功能实测（发布文字/带图/标签/筛选/搜索高亮/编辑/删除/灯箱/设置页/绑定向导/强制推送），390/820/1440 三视口，截图存 `web/gui-regression/`。API 层可用临时 bare 仓 + node fetch 脚本做全场景断言（见 gui-regression 同目录开发记录）。

## 三端

| 端 | 目录 | 说明 |
|---|---|---|
| PC Web | `web/` | Node ≥18 零 npm 依赖，`cd web && npm i -g .` 后运行 `git-notes` |
| Android | `android/` | Kotlin + JGit 移植同一套服务与界面，构建见 `android/README.md` |
| Windows 桌面 | `electron/` | Electron 纯单机（零端口零鉴权），`cd electron && npm i && npm run dist` |

三端共享同一套前端（`web/index.html` + `assets/` + `js/`）与数据格式，改 `web/server.js` 路由/git 行为需三端同步。

## License

[MIT](LICENSE)
