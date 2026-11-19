# AGENTS.md

## 仓库内容纪律（硬性规定，永久有效）

**禁止把以下内容加入 git 仓库**（不 commit、不 add，即使工作区生成了也不要提交）：

1. **测试文件**：API 测试脚本、e2e 测试脚本、冒烟测试脚本等（如曾经的 `web/gui-regression/*.js`）。测试脚本放仓库外或临时目录，用完即删。
2. **测试截图**：任何 `.png` / `.jpg` 截图产物（如曾经的 `web/gui-regression/*.png`）。测试截图留在仓库外的临时目录。
3. **没用的备选/草稿**：设计稿备选方案、废弃预览页等（如曾经的 `homepage/preview/a`、`homepage/preview/b`）。定稿后落选方案直接删掉，不留在仓库里。

仓库只保留产品源码、构建配置与文档。新增目录前先想清楚它是不是这三类东西，是就不要放进仓库。

## 发布纪律（硬性规定，永久有效）

**发布版本时必须先询问用户如何发布，禁止自作主张。** 未经用户明确确认，不得自行执行任何发布动作（发版提交、打 tag、推送、打包、上传、发渠道等）；具体发布方式、范围、目标渠道一律以用户的指示为准。

**发布版本必须打 tag（硬性习惯）**：每次正式发布版本，都要在版本号提交上打 annotated tag `v<版本号>`（如 `v0.7.0`，注明该版本要点），并随分支推送到所有远端（`git push <remote> main --follow-tags`）。

## 发布流程（2026-11-19 迁移后：GitHub Pages + Releases + EdgeOne）

发布渠道架构：
- **官网**：`homepage/` → push main 自动部署到 GitHub Pages（`u32-cn.github.io/git-notes/`）→ EdgeOne 回源加速，域名 `git-notes.u32.cn`
- **安装包**：GitHub Releases 资产 → EdgeOne 回源跟随重定向加速，下载路径 `git-notes.u32.cn/download/<文件名>`
- **更新清单**：`homepage/data/latest.yml`（Windows）/ `homepage/data/latest.json`（Android）随官网同源发布，取数路径 `git-notes.u32.cn/data/`
- **AI 服务商预设**：`web/tools/mode_providers.json` 改动后需同步复制到 `homepage/data/mode_providers.json`

每次发版的固定步骤：

1. 改版本号（`web/package.json` / `electron/package.json` / android versionName 继承）→ 构建 exe 与 apk
2. 在版本号提交上打 annotated tag 并推送（见上方发布纪律）
3. **更新两个清单文件**：`homepage/data/latest.yml`（version / files[0].url / sha512 / size，对齐 exe 实测值）与 `homepage/data/latest.json`（version / url 绝对地址指向 `git-notes.u32.cn/download/<apk 文件名>` / sha512），随代码一起 push
4. 创建 GitHub Release（tag 复用已打的）并上传 4 个资产：exe、apk、`latest.yml`、`latest.json`（Release 里的清单是给 `releases/latest/download/` 直连兜底用的，内容与 `homepage/data/` 保持一致）
5. 验证：`git-notes.u32.cn/data/latest.yml`、`.../latest.json` 返回 200 且版本正确；`git-notes.u32.cn/download/<exe>`、`<apk>` 可下载；官网首页两个平台版本号都显示正常
6. 若 EdgeOne 缓存导致官网/清单内容滞后，刷新对应 URL 的缓存（purge 任务）

注意事项：
- **元数据只走 Pages 源（/data/），安装包只走 Releases 源（/download/）**。不要把 latest.yml/json 再挂回 /download/ 路径——EdgeOne 回源 Releases 不稳定（实测约 30% 超时），元数据必须走稳定的 Pages 源
- 官网取数代码不带 `?t=` 防缓存参数（会绕过 EdgeOne 缓存强制回源，暴露失败率）
- 仓库内禁止提交 `.workbuddy/` 目录（已在 .gitignore）
