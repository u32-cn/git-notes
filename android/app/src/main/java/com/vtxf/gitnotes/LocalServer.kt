package com.vtxf.gitnotes

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.Process
import java.io.BufferedInputStream
import java.io.File
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.HttpURLConnection
import java.net.ServerSocket
import java.net.Socket
import java.net.URL
import java.net.URLDecoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.Executors
import org.json.JSONArray
import org.json.JSONObject

/**
 * 本地服务：web/server.js 的 Kotlin 移植，路由逐条对齐。
 *
 * - 只绑 127.0.0.1:8644。端口固定不漂移（localStorage 按 origin 隔离）。
 *   与云效笔记 v1(8642)/v2(8643) 错开，手机上同装多 APP 也不冲突。
 * - GET / 与 /index.html → assets/index.html + CSP 脚本内容哈希 + 种下页面凭证 cookie
 * - /healthz → {"ok":true,"version":...,"pid":...}
 * - /media/micro/... → 仓库配图直出（cookie 鉴权 + 路径白名单）
 * - /api/status | setup/local | setup/key(+rotate) | setup/clone | bind 系五端点 | unbind | sync |
 *   force-push | posts(GET/POST/PUT/DELETE) | tags | search | git 历史三端点(log/show/restore) | repo/open(移动端返回不支持) → 本地 GitRepo（JGit）
 *
 * 安全红线：只绑回环；Host 校验防 DNS rebinding；cookie（SameSite=Lax）+ 随机令牌防跨站；
 * 日志不打印请求头、cookie 与查询串。
 */
class LocalServer(private val context: Context) {

    companion object {
        const val PORT = 8644
    }

    private val repo = GitRepo(context)
    private val pageToken: String = ByteArray(24).let {
        SecureRandom().nextBytes(it)
        it.joinToString("") { b -> "%02x".format(b) }
    }
    private val indexBytes: ByteArray by lazy {
        context.assets.open("index.html").use { it.readBytes() }
    }
    private val helpBytes: ByteArray by lazy {
        context.assets.open("help.html").use { it.readBytes() }
    }

    /* CSP：与 web/server.js 同规则——前端拆分为 assets/js 静态文件后放行同源（self）。
       style-src 保留 unsafe-inline：页面仍用 style 属性与 JS 内联样式 */
    private val csp: String =
        "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'"

    @Volatile
    var started = false
        private set

    private var serverSocket: ServerSocket? = null
    private val pool = Executors.newFixedThreadPool(16)

    /** @return 启动是否成功；端口被占返回 false */
    fun start(): Boolean {
        if (started) return true
        return try {
            val ss = ServerSocket()
            ss.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), PORT), 64)
            serverSocket = ss
            started = true
            Thread({ acceptLoop() }, "gn-accept").apply { isDaemon = true }.start()
            true
        } catch (_: java.io.IOException) {
            false
        }
    }

    private fun acceptLoop() {
        val ss = serverSocket ?: return
        while (started) {
            val sock = try {
                ss.accept()
            } catch (_: java.io.IOException) {
                break
            }
            pool.execute { handle(sock) }
        }
    }

    // ---------- 请求解析 ----------

    private class Req(
        val method: String,
        val url: String,
        val headers: Map<String, String>,
        val body: ByteArray,
    )

    private fun handle(sock: Socket) {
        try {
            sock.soTimeout = 300_000
            sock.use { s ->
                val req = parseRequest(BufferedInputStream(s.getInputStream())) ?: return
                route(req, s.getOutputStream())
            }
        } catch (_: Exception) {
            // 单连接异常不影响服务整体
        }
    }

    private fun parseRequest(input: BufferedInputStream): Req? {
        val requestLine = readLine(input) ?: return null
        val sp1 = requestLine.indexOf(' ')
        val sp2 = requestLine.lastIndexOf(' ')
        if (sp1 <= 0 || sp2 <= sp1) return null
        val method = requestLine.substring(0, sp1)
        val url = requestLine.substring(sp1 + 1, sp2)
        val headers = HashMap<String, String>()
        while (true) {
            val line = readLine(input) ?: return null
            if (line.isEmpty()) break
            val idx = line.indexOf(':')
            if (idx > 0) headers[line.substring(0, idx).trim().lowercase()] = line.substring(idx + 1).trim()
        }
        val len = headers["content-length"]?.toIntOrNull() ?: 0
        if (len > 64 * 1024 * 1024) return null
        val body = ByteArray(len)
        var off = 0
        while (off < len) {
            val n = input.read(body, off, len - off)
            if (n < 0) return null
            off += n
        }
        return Req(method, url, headers, body)
    }

    private fun readLine(input: BufferedInputStream): String? {
        val sb = StringBuilder()
        while (true) {
            val b = input.read()
            if (b == -1) return if (sb.isEmpty()) null else sb.toString()
            if (b == '\n'.code) {
                if (sb.isNotEmpty() && sb.last() == '\r') sb.setLength(sb.length - 1)
                return sb.toString()
            }
            sb.append(b.toChar())
        }
    }

    // ---------- 路由（对齐 server.js） ----------

    private fun route(req: Req, out: OutputStream) {
        val path = req.url.substringBefore('?')
        val query = req.url.substringAfter('?', "").split('&')
            .filter { it.contains('=') }
            .associate { URLDecoder.decode(it.substringBefore('='), "UTF-8") to URLDecoder.decode(it.substringAfter('='), "UTF-8") }
        try {
            if (!hostOk(req)) {
                writeJson(out, 403, JSONObject().put("error", "Host 不合法"))
                return
            }
            when {
                req.method == "GET" && (path == "/" || path == "/index.html") -> {
                    val headers = mapOf(
                        "Content-Security-Policy" to csp,
                        "Cache-Control" to "no-store",
                        "Set-Cookie" to "gn_token=$pageToken; Path=/; HttpOnly; SameSite=Lax",
                    )
                    writeResp(out, 200, "text/html; charset=utf-8", indexBytes, headers)
                }

                // 帮助独立页：静态文档不调 API、无 cookie 需求，仍带 CSP（对齐 server.js /help.html）
                req.method == "GET" && path == "/help.html" -> {
                    val headers = mapOf(
                        "Content-Security-Policy" to csp,
                        "Cache-Control" to "no-store",
                    )
                    writeResp(out, 200, "text/html; charset=utf-8", helpBytes, headers)
                }

                // 前端静态文件（assets/ 与 js/ 白名单目录，防目录穿越；对齐 server.js serveStatic）
                req.method == "GET" && (path.startsWith("/assets/") || path.startsWith("/js/")) ->
                    serveStatic(path, out)

                path == "/healthz" ->
                    writeJson(out, 200, JSONObject().put("ok", true).put("version", BuildConfig.VERSION_NAME).put("pid", Process.myPid()))

                path.startsWith("/media/") && req.method == "GET" -> serveMedia(req, path, out)

                path.startsWith("/api/") -> {
                    if (!authOk(req)) {
                        writeJson(out, 401, JSONObject().put("error", "页面凭证失效，请刷新页面"))
                        return
                    }
                    if (path == "/api/ai/proxy" && req.method == "POST") {
                        proxyAi(req, out)   // 流式透传，不走 JSON 路由
                        return
                    }
                    handleApi(req, path, query, out)
                }

                else -> writeJson(out, 404, JSONObject().put("error", "not found"))
            }
        } catch (e: LocalApiError) {
            val payload = JSONObject().put("error", e.message ?: e.toString())
            e.conflict?.let { payload.put("conflict", JSONArray(it)) }
            if (e.needPubKey) payload.put("needPubKey", true)
            android.util.Log.e("GitNotes", "api ${req.method} $path -> ${e.status}: ${e.message}")
            runCatching { writeJson(out, e.status, payload) }
        } catch (e: Exception) {
            android.util.Log.e("GitNotes", "api ${req.method} $path -> 500", e)
            runCatching { writeJson(out, 500, JSONObject().put("error", e.message ?: e.toString())) }
        }
    }

    private fun hostOk(req: Req): Boolean {
        val h = req.headers["host"] ?: return false
        return h == "127.0.0.1:$PORT" || h == "localhost:$PORT"
    }

    private fun authOk(req: Req): Boolean {
        val cookies = req.headers["cookie"]?.split(";\\s*".toRegex()) ?: return false
        return cookies.any { it.startsWith("gn_token=") && it.substringAfter('=') == pageToken }
    }

    private fun serveMedia(req: Req, path: String, out: OutputStream) {
        val rel = URLDecoder.decode(path.removePrefix("/media/"), "UTF-8")
        if (!Regex("^micro/[A-Za-z0-9._/\\-]+$").matches(rel) || rel.contains("..")) {
            writeJson(out, 400, JSONObject().put("error", "非法路径"))
            return
        }
        val f = File(repo.repoDir, rel)
        if (!f.canonicalPath.startsWith(File(repo.repoDir, "micro").canonicalPath + File.separator) || !f.isFile) {
            writeJson(out, 404, JSONObject().put("error", "not found"))
            return
        }
        val ext = f.extension.lowercase()
        val diskName = f.name
        val headers = mutableMapOf("Cache-Control" to "private, max-age=3600", "X-Content-Type-Options" to "nosniff")
        val ctype: String
        if (GitRepo.IMG_MIME.containsKey(ext)) {
            ctype = GitRepo.IMG_MIME[ext]!!   // 图片维持内联（卡片/灯箱 img 依赖）
        } else {
            // 非图片一律 attachment 下载：防同源 html/svg 执行窃取 cookie，nosniff 防 MIME 嗅探（对齐 web/server.js）
            ctype = GitRepo.FILE_MIME[ext] ?: "application/octet-stream"
            val ascii = diskName.replace(Regex("[^A-Za-z0-9._-]"), "_")
            headers["Content-Disposition"] = "attachment; filename=\"$ascii\"; filename*=UTF-8''" + java.net.URLEncoder.encode(diskName, "UTF-8").replace("+", "%20")
        }
        writeResp(out, 200, ctype, f.readBytes(), headers)
    }

    private fun serveStatic(path: String, out: OutputStream) {
        val rel = java.net.URLDecoder.decode(path.removePrefix("/"), "UTF-8")
        if (!Regex("^(assets|js)/[A-Za-z0-9._-]+$").matches(rel)) {
            writeJson(out, 404, JSONObject().put("error", "not found"))
            return
        }
        val bytes = try {
            context.assets.open(rel).use { it.readBytes() }
        } catch (_: Exception) {
            writeJson(out, 404, JSONObject().put("error", "not found"))
            return
        }
        val ctype = when (rel.substringAfterLast('.').lowercase()) {
            "css" -> "text/css; charset=utf-8"
            "js" -> "text/javascript; charset=utf-8"
            else -> "application/octet-stream"
        }
        writeResp(out, 200, ctype, bytes, mapOf("Cache-Control" to "no-store"))
    }

    private fun handleApi(req: Req, path: String, query: Map<String, String>, out: OutputStream) {
        val body: JSONObject? = if (req.method == "POST" || req.method == "PUT" || req.method == "DELETE") {
            try {
                if (req.body.isEmpty()) JSONObject() else JSONObject(String(req.body, Charsets.UTF_8))
            } catch (_: Exception) {
                throw LocalApiError(400, "JSON 解析失败")
            }
        } else {
            null
        }
        val result: JSONObject = when {
            path == "/api/status" -> statusJson()

            path == "/api/update/check" && req.method == "GET" -> checkUpdate()

            // 应用内一键更新：POST 立即返回、后台下载 APK 到 ready 即止（不自动拉起安装器）
            path == "/api/update/install" && req.method == "POST" -> installUpdate()

            // 用户在 UI 点「安装」后拉起系统安装器（系统仍强制人工点「安装」，此处只是不自动弹窗）
            path == "/api/update/run" && req.method == "POST" -> runInstallReady()

            // 更新进度轮询（与 electron 端 /api/update/progress 同构，phase ∈ idle|checking|downloading|ready|none）
            path == "/api/update/progress" && req.method == "GET" -> updateProgress()

            // 移动端服务进程无法代表用户拉起文件管理器，返回明确语义（前端按 platform=android 已隐藏按钮）
            path == "/api/repo/open" && req.method == "POST" ->
                throw LocalApiError(400, "移动端不支持从服务端打开仓库文件夹")

            path == "/api/setup/local" && req.method == "POST" -> repo.setupLocal()

            path == "/api/setup/key" && req.method == "POST" ->
                JSONObject().put("pubKey", repo.ensureKey())

            path == "/api/setup/key/rotate" && req.method == "POST" ->
                JSONObject().put("pubKey", repo.rotateKey()).put("rotated", true)

            path == "/api/setup/key/import" && req.method == "POST" ->
                JSONObject().put("pubKey", repo.importKey(body?.optString("privateKey") ?: "")).put("imported", true)

            path == "/api/setup/key/private" && req.method == "POST" ->
                JSONObject().put("privateKey", repo.exportPrivateKey())

            path == "/api/setup/clone" && req.method == "POST" ->
                JSONObject().put("started", repo.startClone(body?.optString("remote") ?: ""))

            path == "/api/bind/probe" && req.method == "POST" -> repo.bindProbe(body?.optString("remote") ?: "")

            path == "/api/bind/confirm" && req.method == "POST" -> {
                if (repo.syncState.busy || repo.writeBusy) throw LocalApiError(409, "同步或写入进行中")
                repo.enqueueWrite { repo.bindConfirm(body?.optString("remote") ?: "") }
            }

            path == "/api/bind/merge" && req.method == "POST" -> {
                if (repo.syncState.busy || repo.writeBusy) throw LocalApiError(409, "同步或写入进行中")
                repo.enqueueWrite { repo.bindMerge() }
            }

            path == "/api/bind/force-push" && req.method == "POST" -> {
                if (repo.syncState.busy || repo.writeBusy) throw LocalApiError(409, "同步或写入进行中")
                repo.enqueueWrite { repo.bindForcePush() }
            }

            path == "/api/bind/cancel" && req.method == "POST" -> {
                if (repo.syncState.busy || repo.writeBusy) throw LocalApiError(409, "同步或写入进行中")
                repo.enqueueWrite { repo.cancelBind(); JSONObject() }
            }

            path == "/api/unbind" && req.method == "POST" -> {
                repo.unbind(); JSONObject()
            }

            path == "/api/sync" && req.method == "POST" -> {
                if (repo.syncState.busy || repo.writeBusy) throw LocalApiError(409, "同步或写入进行中")
                repo.doSync()
            }

            path == "/api/force-push" && req.method == "POST" -> {
                if (repo.syncState.busy || repo.writeBusy) throw LocalApiError(409, "同步或写入进行中")
                repo.enqueueWrite { repo.forcePush(); JSONObject() }
            }

            path == "/api/posts" && req.method == "GET" -> {
                repo.ensureReady()
                val page = repo.pagePosts(query["before"])
                JSONObject()
                    .put("month", page.month ?: JSONObject.NULL)
                    .put("posts", JSONArray().apply { page.posts.forEach { put(it.toJson()) } })
                    .put("pins", JSONArray().apply { page.pins.forEach { put(it.toJson()) } })
                    .put("more", page.more)
            }

            path == "/api/posts/pin" && req.method == "POST" -> {
                if (repo.syncState.busy || repo.writeBusy) throw LocalApiError(409, "已有写操作进行中，请稍候")
                JSONObject().put("pins", JSONArray(repo.setPin(body?.optString("path") ?: "", body?.optBoolean("pinned") ?: false)))
            }

            path == "/api/posts" && req.method == "POST" -> {
                if (repo.syncState.busy || repo.writeBusy) throw LocalApiError(409, "已有写操作进行中，请稍候")
                val tags = stringList(body?.optJSONArray("tags"))
                repo.writePost(body?.optString("text") ?: "", tags, body?.optJSONArray("images"), body?.optJSONArray("files"), body?.optBoolean("ai") ?: false).toJson()
            }

            path == "/api/posts" && req.method == "PUT" -> {
                if (repo.syncState.busy || repo.writeBusy) throw LocalApiError(409, "已有写操作进行中，请稍候")
                val tags = stringList(body?.optJSONArray("tags"))
                repo.updatePost(
                    body?.optString("path") ?: "", body?.optString("text") ?: "", tags,
                    body?.optJSONArray("keepNames")?.let { ja -> (0 until ja.length()).map { ja.optString(it) } },
                    body?.optJSONArray("newImages"),
                    body?.optJSONArray("keepFileNames")?.let { ja -> (0 until ja.length()).map { ja.optString(it) } },
                    body?.optJSONArray("newFiles"),
                    body?.optBoolean("ai") ?: false,
                ).toJson()
            }

            path == "/api/posts" && req.method == "DELETE" -> {
                if (repo.syncState.busy || repo.writeBusy) throw LocalApiError(409, "已有写操作进行中，请稍候")
                repo.deletePost(body?.optString("path") ?: "", body?.optBoolean("ai") ?: false)
                JSONObject()
            }

            path == "/api/tags" && req.method == "GET" -> {
                repo.ensureReady()
                JSONObject().put("tags", JSONArray(repo.readTags()))
            }

            path == "/api/tags" && req.method == "PUT" -> {
                if (repo.syncState.busy || repo.writeBusy) throw LocalApiError(409, "已有写操作进行中，请稍候")
                JSONObject().put("tags", JSONArray(repo.writeTags(body?.optJSONArray("tags"), body?.optString("action"), body?.optString("tag"))))
            }

            path == "/api/search" && req.method == "GET" -> {
                repo.ensureReady()
                val r = repo.searchAll(query["q"] ?: "")
                JSONObject()
                    .put("hits", JSONArray().apply { r.hits.forEach { put(it.toJson()) } })
                    .put("total", r.total).put("ms", r.ms)
            }

            // git 历史三端点（AI 工具）：只读查阅 / 时点读取 / 恢复=新提交
            path == "/api/git/log" && req.method == "GET" -> {
                repo.ensureReady()
                val limit = (query["limit"]?.toIntOrNull() ?: 50).coerceIn(1, 200)
                JSONArray().apply { repo.gitLog(limit, query["path"] ?: "").forEach { put(it) } }.let {
                    JSONObject().put("commits", it)
                }
            }

            path == "/api/git/show" && req.method == "GET" -> {
                repo.ensureReady()
                JSONObject().put("text", repo.gitShow(query["path"] ?: "", query["commit"] ?: ""))
            }

            path == "/api/git/restore" && req.method == "POST" -> {
                if (repo.syncState.busy || repo.writeBusy) throw LocalApiError(409, "已有写操作进行中，请稍候")
                repo.enqueueWrite {
                    repo.gitRestore(body?.optString("path") ?: "", body?.optString("commit") ?: "", body?.optBoolean("ai") ?: false)
                    JSONObject()
                }
            }

            path == "/api/ai/settings" && req.method == "GET" -> repo.readAiSettings()

            path == "/api/ai/providers" && req.method == "GET" -> aiProviders()

            path == "/api/ai/settings" && req.method == "POST" -> {
                if (repo.syncState.busy || repo.writeBusy) throw LocalApiError(409, "已有写操作进行中，请稍候")
                // 规范化（对齐 web validAiConfig）：未知字段丢弃，extra 须为对象（权限模式不入仓，各端存本机）
                val extra = body?.optJSONObject("extra")
                val cfg = JSONObject()
                    .put("baseURL", (body?.optString("baseURL") ?: "").trim().trimEnd('/').take(300))
                    .put("apiKey", (body?.optString("apiKey") ?: "").take(300))
                    .put("model", (body?.optString("model") ?: "").trim().take(100))
                    .put("extra", extra ?: JSONObject.NULL)
                repo.enqueueWrite {
                    repo.setAiSettings(cfg)
                    cfg
                }
            }

            // AI 文件操作与全量 git（语义对齐 web server.js；路径作用域由 GitRepo.assertRepoPath 把关）
            path == "/api/fs/list" && req.method == "GET" -> repo.fsList(query["path"] ?: "")

            path == "/api/fs/read" && req.method == "GET" -> repo.fsRead(query["path"] ?: "")

            path == "/api/fs/write" && req.method == "POST" -> {
                if (repo.syncState.busy || repo.writeBusy) throw LocalApiError(409, "已有写操作进行中，请稍候")
                repo.fsWrite(body)
            }

            path == "/api/fs/delete" && req.method == "POST" -> {
                if (repo.syncState.busy || repo.writeBusy) throw LocalApiError(409, "已有写操作进行中，请稍候")
                repo.fsDelete(body)
            }

            path == "/api/fs/move" && req.method == "POST" -> {
                if (repo.syncState.busy || repo.writeBusy) throw LocalApiError(409, "已有写操作进行中，请稍候")
                repo.fsMove(body)
            }

            path == "/api/fs/mkdir" && req.method == "POST" -> {
                if (repo.syncState.busy || repo.writeBusy) throw LocalApiError(409, "已有写操作进行中，请稍候")
                repo.fsMkdir(body)
            }

            path == "/api/git/status" && req.method == "GET" -> repo.gitStatus()

            path == "/api/git/add" && req.method == "POST" -> {
                if (repo.syncState.busy || repo.writeBusy) throw LocalApiError(409, "已有写操作进行中，请稍候")
                repo.gitAdd(body)
            }

            path == "/api/git/commit" && req.method == "POST" -> {
                if (repo.syncState.busy || repo.writeBusy) throw LocalApiError(409, "已有写操作进行中，请稍候")
                repo.gitCommit(body)
            }

            path == "/api/git/push" && req.method == "POST" -> repo.gitPush()

            path == "/api/git/pull" && req.method == "POST" -> repo.gitPull()

            path == "/api/git/diff" && req.method == "GET" -> repo.gitDiff(
                query["from"] ?: "", query["to"] ?: "", query["path"] ?: "", query["mode"] ?: "",
            )

            path == "/api/git/branch" && req.method == "POST" -> repo.gitBranchOp(body)

            path == "/api/git/restore-files" && req.method == "POST" -> repo.gitRestoreFiles(body)

            else -> throw LocalApiError(404, "not found")
        }
        writeJson(out, 200, result)
    }

    private fun stringList(ja: JSONArray?): List<String> =
        ja?.let { (0 until it.length()).map { i -> it.optString(i) } } ?: emptyList()

    private fun statusJson(): JSONObject {
        val key = JSONObject().put("exists", repo.keyFile.isFile)
        if (repo.pubFile.isFile) key.put("pubKey", repo.pubFile.readText().trim())
        val sync = JSONObject()
            .put("busy", repo.syncState.busy || repo.writeBusy).put("phase", repo.syncState.phase)
            .put("lastError", repo.syncState.lastError)
        sync.put("conflict", repo.syncState.conflict?.let { JSONArray(it) } ?: JSONObject.NULL)
        sync.put("lastAt", repo.syncState.lastAt ?: JSONObject.NULL)
        sync.put("ahead", repo.syncState.ahead).put("behind", repo.syncState.behind)
        return JSONObject()
            .put("stage", repo.stage())
            .put("platform", "android")
            .put("remote", repo.remoteUrl())
            .put("branch", if (repo.hasRepo()) repo.MAIN_BRANCH else "")
            .put("key", key)
            .put(
                "clone",
                JSONObject().put("active", repo.cloneState.active).put("phase", repo.cloneState.phase)
                    .put("progress", repo.cloneState.progress).put("error", repo.cloneState.error),
            )
            .put("sync", sync)
    }

    // 检测新版本：拉 OSS 更新源 update/android/latest.json 与 BuildConfig.VERSION_NAME 比对（8s 超时；失败装 error 不抛，前端展示）
    // 语义化比较：latest 逐段数值大于 current 才算有新版（更新源过期/回滚时不得误报）
    private fun isNewerVersion(latest: String, current: String): Boolean {
        val a = latest.split('.').map { it.toIntOrNull() ?: 0 }
        val b = current.split('.').map { it.toIntOrNull() ?: 0 }
        for (i in 0 until maxOf(a.size, b.size)) {
            val d = (a.getOrElse(i) { 0 }) - (b.getOrElse(i) { 0 })
            if (d != 0) return d > 0
        }
        return false
    }

    // 应用内一键更新（与 electron 端方案对齐）：POST /api/update/install 立即返回、后台线程 检测→下载 APK →
    // 落盘校验通过即置 ready，不自动拉起安装器；用户点 UI「安装」后 POST /api/update/run 才拉起
    // ACTION_INSTALL_PACKAGE（系统仍强制人工点「安装」）。进度状态供前端轮询 GET /api/update/progress，
    // phase 语义与 electron 端对齐：idle|checking|downloading|ready|none，error 随 idle 附带。
    // 下载目录用 filesDir/update（持久，cacheDir 可能被系统清掉导致重复下载），目录内最多保留一个 APK：
    // 已有目标版本且 sha512 校验通过直接免重下，否则清空目录重下。
    // 首次安装若未授予「安装未知应用」权限，系统会先引导到授权页，回来再点一次「安装」即可。
    private val updLock = Any()
    private val updState = JSONObject().put("phase", "idle").put("percent", 0).put("received", 0L)
        .put("total", 0L).put("latest", "").put("error", "").put("active", false)
    private var updBusy = false

    private fun updSet(patch: JSONObject.() -> Unit) {
        synchronized(updLock) { updState.patch() }
    }

    private fun updateProgress(): JSONObject = synchronized(updLock) { JSONObject(updState.toString()) }

    private fun apkSha512(file: File): String =
        MessageDigest.getInstance("SHA-512").digest(file.readBytes()).joinToString("") { "%02x".format(it) }

    private fun installUpdate(): JSONObject {
        synchronized(updLock) {
            if (updBusy) return JSONObject().put("ok", true).put("already", true)
            updBusy = true
        }
        updSet {
            put("phase", "checking").put("percent", 0).put("received", 0L).put("total", 0L)
                .put("latest", "").put("error", "").put("active", true)
        }
        Thread { runUpdateFlow() }.start()
        return JSONObject().put("ok", true).put("started", true)
    }

    // ready 态用户点击「安装」：APK 在位才拉起系统安装器；保持 ready 以便用户取消授权/安装后可再点
    private fun runInstallReady(): JSONObject {
        val (phase, ver) = synchronized(updLock) { updState.optString("phase") to updState.optString("latest") }
        if (phase != "ready" || ver.isEmpty()) throw LocalApiError(409, "安装包尚未就绪，请先下载")
        val apk = File(File(context.filesDir, "update"), "git-notes-v$ver.apk")
        if (!apk.exists()) throw LocalApiError(409, "安装包已丢失，请重新下载")
        val uri = Uri.parse("content://com.vtxf.gitnotes.apk/update/" + apk.name)
        val intent = Intent(Intent.ACTION_INSTALL_PACKAGE).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        Handler(Looper.getMainLooper()).post { context.startActivity(intent) }
        return JSONObject().put("ok", true)
    }

    private fun runUpdateFlow() {
        try {
            val cur = checkUpdate()
            if (!cur.optBoolean("updateAvailable")) {
                updSet { put("phase", "none").put("latest", cur.optString("latest")) }
                return
            }
            val url = cur.optString("url")
            if (url.isEmpty()) throw LocalApiError(500, "更新源缺少下载地址")
            val ver = cur.optString("latest")
            val dir = File(context.filesDir, "update").apply { mkdirs() }
            val apk = File(dir, "git-notes-v$ver.apk")
            updSet { put("phase", "downloading").put("latest", ver) }
            val wantSha = cur.optString("sha512")
            // 复用已下载的 APK 也强校验 sha512，防残留损坏包：仅当校验通过才保留，否则删掉重下
            if (apk.exists() && !(wantSha.isNotEmpty() && apkSha512(apk).equals(wantSha, ignoreCase = true))) {
                apk.delete()
            }
            if (!apk.exists()) {
                // 目录内最多保留一个安装包：下载前清掉旧版本残留
                dir.listFiles()?.forEach { it.delete() }
                // 先写临时名再原子改名：中途断流不留半截 APK 冒充完整包
                val tmp = File(dir, "git-notes-v$ver.apk.part")
                val conn = URL(url).openConnection() as HttpURLConnection
                conn.connectTimeout = 10000
                conn.readTimeout = 60000
                try {
                    if (conn.responseCode !in 200..299) throw LocalApiError(502, "下载失败：HTTP " + conn.responseCode)
                    val total = conn.contentLengthLong
                    var received = 0L
                    conn.inputStream.use { input ->
                        tmp.outputStream().use { out ->
                            val buf = ByteArray(64 * 1024)
                            while (true) {
                                val n = input.read(buf)
                                if (n < 0) break
                                out.write(buf, 0, n)
                                received += n
                                updSet {
                                    put("received", received).put("total", total)
                                        .put("percent", if (total > 0) (received * 100 / total).toInt().coerceAtMost(100) else 0)
                                }
                            }
                        }
                    }
                    if (tmp.length() < 1024 * 1024) throw LocalApiError(502, "下载不完整")
                    // 更新源带 sha512 时强校验，不符拒绝安装（比依赖系统安装期签名校验更早暴露包损坏/被替换）
                    if (wantSha.isNotEmpty() && !apkSha512(tmp).equals(wantSha, ignoreCase = true)) {
                        throw LocalApiError(502, "APK 校验失败（sha512 不符），已拒绝安装")
                    }
                    if (!tmp.renameTo(apk)) throw LocalApiError(500, "APK 落盘失败")
                } catch (e: Exception) {
                    tmp.delete()
                    throw e
                } finally {
                    conn.disconnect()
                }
            }
            // 到此即止：置 ready 等用户在 UI 点「安装」，不自动拉起系统安装器
            updSet { put("phase", "ready").put("percent", 100) }
        } catch (e: Exception) {
            updSet { put("phase", "idle").put("error", e.message ?: e.toString()) }
        } finally {
            synchronized(updLock) { updBusy = false }
            updSet { put("active", false) }
        }
    }

    private fun checkUpdate(): JSONObject {
        val cur = BuildConfig.VERSION_NAME
        return try {
            val conn = URL("https://u32.cn/bd/apps/git-notes/update/android/latest.json").openConnection() as HttpURLConnection
            conn.connectTimeout = 8000
            conn.readTimeout = 8000
            val manifest = JSONObject(conn.inputStream.bufferedReader().readText())
            conn.disconnect()
            val ver = manifest.optString("version")
            // 清单 url 兼容相对文件名（旧清单）：Java URL 不做相对解析，须补全基址
            val rawUrl = manifest.optString("url")
            val absUrl = if (rawUrl.startsWith("http")) rawUrl
                else "https://u32.cn/bd/apps/git-notes/update/android/" + rawUrl.removePrefix("/")
            JSONObject()
                .put("supported", true)
                .put("current", cur)
                .put("latest", ver)
                .put("updateAvailable", ver.isNotEmpty() && isNewerVersion(ver, cur))
                .put("url", absUrl)
                .put("sha512", manifest.optString("sha512"))
        } catch (e: Exception) {
            JSONObject()
                .put("supported", true)
                .put("current", cur)
                .put("latest", JSONObject.NULL)
                .put("updateAvailable", false)
                .put("url", "")
                .put("error", e.message ?: e.toString())
        }
    }

    // ---------- 响应输出 ----------

    private fun writeResp(
        out: OutputStream,
        code: Int,
        contentType: String,
        body: ByteArray,
        extra: Map<String, String> = emptyMap(),
    ) {
        val sb = StringBuilder()
        sb.append("HTTP/1.1 ").append(code).append(' ').append(reasonOf(code)).append("\r\n")
        sb.append("Content-Type: ").append(contentType).append("\r\n")
        sb.append("Content-Length: ").append(body.size).append("\r\n")
        sb.append("Connection: close\r\n")
        for ((k, v) in extra) sb.append(k).append(": ").append(v).append("\r\n")
        sb.append("\r\n")
        out.write(sb.toString().toByteArray(Charsets.ISO_8859_1))
        out.write(body)
        out.flush()
    }

    private fun writeJson(out: OutputStream, code: Int, obj: JSONObject) {
        writeResp(out, code, "application/json; charset=utf-8", obj.toString().toByteArray(Charsets.UTF_8))
    }

    /* AI 代理：浏览器统一经本机服务转发 AI 请求并逐块透传流式响应（SSE）。
       部分服务商不支持浏览器跨域，同源代理对前端零差别；url/key 来自本机页面 localStorage，不落日志。
       关键：每读一块就 flush——攒着不 flush 的话流式会退化成一次性吐出。 */
    /* AI 提供商预设：远端 JSON（OSS 托管，可随时更新）→ 内存缓存；拉取失败/不合法回退内置清单。
       对齐 web/server.js aiProviders（三端同语义）。HTTP 拉取必须在 IO 线程，路由已在线程池执行。 */
    private val AI_PROVIDERS_URL = "https://u32.cn/bd/apps/git-notes/info/mode_providers.json"
    private val BUILTIN_AI_PROVIDERS = arrayOf(
        arrayOf("zhipu-free", "智谱免费（glm-4.7-flash，免费但不稳定，开放平台 key）", "https://open.bigmodel.cn/api/paas/v4", "glm-4.7-flash", "https://bigmodel.cn/apikey/platform", """{"thinking":{"type":"disabled"}}"""),
        arrayOf("zhipu-fast", "智谱快速（glm-5.3-flash，开放平台 key）", "https://open.bigmodel.cn/api/paas/v4", "glm-5.3-flash", "https://bigmodel.cn/apikey/platform", """{"thinking":{"type":"disabled"}}"""),
        arrayOf("zhipu-coding", "智谱编程套餐快速（glm-5.3-flash，Coding 套餐 key）", "https://open.bigmodel.cn/api/coding/paas/v4", "glm-5.3-flash", "https://bigmodel.cn/apikey/platform", """{"thinking":{"type":"disabled"}}"""),
        arrayOf("deepseek", "深度求索（deepseek-flash，极速）", "https://api.deepseek.com", "deepseek-flash", "https://platform.deepseek.com/api_keys", """{"thinking":{"type":"disabled"}}"""),
        arrayOf("custom", "自定义大模型（手动填写）", "", "", "", "")
    )
    @Volatile private var aiProvidersCacheData: JSONArray? = null
    @Volatile private var aiProvidersCacheOkAt: Long = 0
    @Volatile private var aiProvidersCacheFailAt: Long = 0
    @Volatile private var aiProvidersLastBuiltin: Boolean = false

    private fun validProviderJo(o: JSONObject): JSONObject? {
        val id = o.optString("id").trim().take(40)
        val label = o.optString("label").trim().take(100)
        if (id.isEmpty() || label.isEmpty()) return null
        return JSONObject()
            .put("id", id)
            .put("label", label)
            .put("baseURL", o.optString("baseURL").trim().trimEnd('/').take(300))
            .put("model", o.optString("model").trim().take(100))
            .put("keyLink", o.optString("keyLink").trim().take(300))
            .put("extra", o.optJSONObject("extra") ?: JSONObject.NULL)
    }

    private fun aiProviders(): JSONObject {
        val now = System.currentTimeMillis()
        val cached = aiProvidersCacheData
        if (cached != null && now - aiProvidersCacheOkAt < 3600_000L) {
            return JSONObject().put("version", 1).put("builtin", false).put("providers", cached)
        }
        try {
            val conn = java.net.URL(AI_PROVIDERS_URL).openConnection() as java.net.HttpURLConnection
            conn.connectTimeout = 10000
            conn.readTimeout = 10000
            try {
                if (conn.responseCode in 200..299) {
                    val text = conn.inputStream.bufferedReader().readText()
                    val arr = JSONObject(text).optJSONArray("providers")
                    if (arr != null && arr.length() > 0) {
                        val cleaned = JSONArray()
                        for (i in 0 until arr.length()) {
                            val jo = validProviderJo(arr.optJSONObject(i) ?: continue) ?: continue
                            cleaned.put(jo)
                        }
                        if (cleaned.length() > 0) {
                            aiProvidersCacheData = cleaned
                            aiProvidersCacheOkAt = now
                            aiProvidersCacheFailAt = 0
                            aiProvidersLastBuiltin = false
                            return JSONObject().put("version", 1).put("builtin", false).put("providers", cleaned)
                        }
                    }
                }
            } finally {
                conn.disconnect()
            }
        } catch (e: Exception) {
            android.util.Log.e("LocalServer", "aiProviders fetch failed", e)
        }
        if (aiProvidersLastBuiltin && cached != null && now - aiProvidersCacheFailAt < 300_000L) {
            return JSONObject().put("version", 1).put("builtin", true).put("providers", cached)
        }
        val builtin = JSONArray()
        for (row in BUILTIN_AI_PROVIDERS) {
            builtin.put(JSONObject().put("id", row[0]).put("label", row[1]).put("baseURL", row[2]).put("model", row[3]).put("keyLink", row[4]).put("extra", if (row[5].isEmpty()) JSONObject.NULL else JSONObject(row[5])))
        }
        aiProvidersCacheOkAt = 0
        aiProvidersCacheFailAt = now
        aiProvidersLastBuiltin = true
        return JSONObject().put("version", 1).put("builtin", true).put("providers", builtin)
    }

    private fun proxyAi(req: Req, out: OutputStream) {
        val body: JSONObject = try {
            if (req.body.isEmpty()) JSONObject() else JSONObject(String(req.body, Charsets.UTF_8))
        } catch (_: Exception) {
            throw LocalApiError(400, "JSON 解析失败")
        }
        val target = body.optString("url")
        if ((!target.startsWith("http://") && !target.startsWith("https://")) || target.length > 2000) {
            throw LocalApiError(400, "url 非法")
        }
        val conn = (java.net.URL(target).openConnection() as java.net.HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 15000
            readTimeout = 600000
            doOutput = true
            setRequestProperty("Content-Type", "application/json")
            setRequestProperty("Accept-Encoding", "identity")
            val key = body.optString("key")
            if (key.isNotEmpty()) setRequestProperty("Authorization", "Bearer $key")
        }
        try {
            val payload = body.optJSONObject("body") ?: JSONObject()
            conn.outputStream.use { it.write(payload.toString().toByteArray(Charsets.UTF_8)); it.flush() }
            val code = conn.responseCode
            val ctype = conn.getHeaderField("Content-Type") ?: "application/octet-stream"
            out.write(buildString {
                append("HTTP/1.1 ").append(code).append(' ').append(reasonOf(code)).append("\r\n")
                append("Content-Type: ").append(ctype).append("\r\n")
                append("Cache-Control: no-store\r\n")
                append("Connection: close\r\n")
                append("\r\n")
            }.toByteArray(Charsets.ISO_8859_1))
            val input = if (code >= 400) conn.errorStream else conn.inputStream
            input?.use { src ->
                val buf = ByteArray(8192)
                while (true) {
                    val n = src.read(buf)
                    if (n < 0) break
                    out.write(buf, 0, n)
                    out.flush()
                }
            }
            out.flush()
        } finally {
            conn.disconnect()
        }
    }

    private fun reasonOf(code: Int): String = when (code) {
        200 -> "OK"
        400 -> "Bad Request"
        401 -> "Unauthorized"
        403 -> "Forbidden"
        404 -> "Not Found"
        409 -> "Conflict"
        413 -> "Payload Too Large"
        500 -> "Internal Server Error"
        else -> "Status"
    }
}
