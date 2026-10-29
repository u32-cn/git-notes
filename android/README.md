# Git笔记 安卓端（APK）

与 PC 版**同一份前端**（`../web/index.html` 构建时同步进 assets）+ **Kotlin 移植的同一套服务**（`LocalServer.kt` + `GitRepo.kt`，JGit + JSch 逐条对齐 `web/server.js` 语义）：本地 git 仓库存 app 沙箱 `filesDir/.git-notes/`，服务只绑 `127.0.0.1:8644`，WebView 加载。功能与 PC 版一致：仅本机模式、绑定任意远端（SSH 程序生成专用密钥）、rebase → merge → 冲突强制推送、全库搜索、密钥旋转。

**不依赖 Termux**：git 能力由 JGit（纯 Java）在 APK 内实现，SSH 由 JSch（mwiede fork，原生 ed25519）承载，无需任何外部二进制。

## 构建（本机，Windows）

前置：Android SDK（`local.properties` 的 `sdk.dir`）、JDK 17（`C:/Users/vtxf/AppData/Local/Android/jdk-17.0.2`）、首次构建走国内镜像（settings.gradle.kts + huaweicloud gradle 发行包）。

```bat
cd android
set JAVA_HOME=C:\Users\vtxf\AppData\Local\Android\jdk-17.0.2
gradlew.bat assembleRelease
:: 产物 app/build/outputs/apk/release/git-notes-v<版本>.apk → 拷 android/dist/ 交付（gradle 已配置输出改名，无需手工重命名）
```

- 版本号自动取 `../web/package.json` 的 `version`；versionCode 为日期型（同日可覆盖安装）。
- `web/index.html` 改动后**必须重新构建 APK**（assets 是构建时拷贝，不存在"改文件即生效"）。
- 改 `web/server.js` 的路由/git 行为后，**必须同步修改 LocalServer.kt / GitRepo.kt**（双端语义零分叉是硬约束）。
- 签名：`keystore.jks`（自签名，仓库内保存，口令在 `gradle.properties`）；**丢失则无法升级安装**，只能卸载重装（数据即 `~/.git-notes`，远端有备份则无损）。

## 与 PC 版的语义对齐清单（改动必守）

| 语义 | PC（server.js） | Android（Kotlin） |
|---|---|---|
| 状态机 | fresh → local → ready；cloning 瞬态 | 同（`GitRepo.stage()`） |
| 同步策略 | rebase → merge `--allow-unrelated-histories` → 冲突待处理 | JGit rebase → merge（JGit 无无关历史拒绝，语义等价）→ `syncState.conflict` |
| 冲突清单 | `git ls-files -u` | `status().conflicting`（abort 前先取） |
| 推送被拒 | fetch + 整合重试 ≤3 | 同（`pushWithRetry`） |
| 绑定三况 | 空仓直推 / 本地空 reset / pendingMerge 预览 | 同（`bindConfirm`） |
| 标签语义 | action(add/remove) 服务端合并 | 同（`writeTags`） |
| 写路径白名单 | 仅 `micro/` 与 `settings/tags.json` | 同（`assertPostPath`） |
| 密钥 | `~/.git-notes/keys/` ed25519，TOFU，0600 | `filesDir/keys/`（沙箱私有），TOFU（accept-new） |
| 安全红线 | 127.0.0.1、cookie+Host 校验、日志脱敏 | 同（`LocalServer`） |

## 手机上安装与使用

1. 把 `dist/git-notes-v<版本>.apk` 传到手机安装（需允许未知来源）。
2. 首启出引导页：**仅本机使用**，或**从远端仓库克隆**——多端同步推荐直接克隆同一个远端（如 `git@codeup.aliyun.com:...`），流程：填地址 → 克隆 → 认证失败时页面会展示本机公钥 → 复制添加到 git 服务器（每台设备一把自己的公钥）→ 重试克隆。
3. 也可「仅本机使用」后随时在设置页「绑定远端」。
4. 卸载即删 `filesDir/.git-notes`；绑定远端后远端仓库就是备份。

### 端口约定（同机共存）

手机上所有本地服务 APP 共享回环端口空间：云效笔记 v1=8642、v2=8643、**Git笔记=8644**，互不冲突；Git笔记双端统一 8644 不漂移（localStorage 按 origin 隔离）。

## 已知限制与验证披露

- 服务只绑 `127.0.0.1`，仅本机访问。
- Android 会杀后台进程：APP 退到后台一段时间后服务随之停止，再次打开 APP 会自动重启服务；无独立常驻守护（同 yunxiao-notes 方案）。
- 本机无连接的安卓设备/模拟器，构建产物经静态验证（签名、包名、assets、dex，见交付报告）；真机行为以 yunxiao-notes v2 同架构已在真机验证过的部件（WebView 壳/JGit SSH 同步/文件选择器）为参照。
