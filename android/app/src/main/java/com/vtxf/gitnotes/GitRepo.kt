package com.vtxf.gitnotes

import android.content.Context
import android.util.Base64
import com.jcraft.jsch.JSch
import com.jcraft.jsch.KeyPair
import com.jcraft.jsch.Session
import org.eclipse.jgit.api.Git
import org.eclipse.jgit.api.RebaseCommand
import org.eclipse.jgit.api.RebaseResult
import org.eclipse.jgit.api.TransportConfigCallback
import org.eclipse.jgit.lib.Constants
import org.eclipse.jgit.lib.ProgressMonitor
import org.eclipse.jgit.lib.Repository
import org.eclipse.jgit.revwalk.RevWalk
import org.eclipse.jgit.treewalk.TreeWalk
import org.eclipse.jgit.transport.RefSpec
import org.eclipse.jgit.transport.RemoteRefUpdate
import org.eclipse.jgit.transport.SshSessionFactory
import org.eclipse.jgit.transport.SshTransport
import org.eclipse.jgit.transport.ssh.jsch.JschConfigSessionFactory
import org.eclipse.jgit.transport.ssh.jsch.OpenSshConfig.Host
import org.eclipse.jgit.util.FS
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 本地 git 仓库：JGit + JSch（mwiede fork，原生 ssh-ed25519）。
 * 语义与 web/server.js 逐条对齐：状态机（fresh/cloning/local/ready，克隆中强制 cloning）、
 * 仅本机模式（local，只 commit 不 push）、绑定五端点（probe/confirm 三况/merge/force-push/cancel）、
 * 同步策略 rebase → merge（JGit 无「无关历史」拒绝，语义等价 --allow-unrelated-histories）→
 * 冲突记录 syncState.conflict 由用户强制推送、推送被拒整合重试 ≤3、
 * 标签动作语义（add/remove 基于磁盘现状合并）、写操作单飞队列、路径白名单。
 * 密钥与仓库只存 app 私有目录（filesDir/.git-notes），不对外暴露。
 */
class GitRepo(context: Context) {

    companion object {
        val DEFAULT_TAGS = listOf("待办", "已完成待办", "备忘", "日记", "杂记", "收藏", "想法", "感悟")
        const val MAX_IMAGES = 9
        const val MAX_FILES = 9
        val IMG_MIME = mapOf(
            "png" to "image/png", "jpg" to "image/jpeg", "jpeg" to "image/jpeg",
            "gif" to "image/gif", "webp" to "image/webp", "bmp" to "image/bmp", "avif" to "image/avif",
        )
        // 非图片附件的 Content-Type 猜测表；不在表内一律 octet-stream，且 /media 直出统一 attachment 下载，防同源 html/svg 执行
        val FILE_MIME = mapOf(
            "pdf" to "application/pdf", "txt" to "text/plain; charset=utf-8", "csv" to "text/csv; charset=utf-8",
            "json" to "application/json", "zip" to "application/zip", "7z" to "application/x-7z-compressed",
            "rar" to "application/vnd.rar", "gz" to "application/gzip",
            "mp3" to "audio/mpeg", "wav" to "audio/wav", "ogg" to "audio/ogg",
            "mp4" to "video/mp4", "webm" to "video/webm",
            "doc" to "application/msword",
            "docx" to "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "xls" to "application/vnd.ms-excel",
            "xlsx" to "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "ppt" to "application/vnd.ms-powerpoint",
            "pptx" to "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        )

        init {
            // 安卓无 JCE Ed25519（Java 15+ 才有），jsch 默认的 jce 实现是直接抛
            // UnsupportedOperationException("KeyPairGenEdDSA requires Java15+") 的桩。
            // 显式切到 jsch 自带的 BC 实现（配合 bcprov 依赖）：
            // keypairgen.eddsa 管密钥生成，signature.ed25519 管客户端验签与 ssh-ed25519 主机密钥。
            JSch.setConfig("keypairgen.eddsa", "com.jcraft.jsch.bc.KeyPairGenEdDSA")
            JSch.setConfig("signature.ed25519", "com.jcraft.jsch.bc.SignatureEd25519")
        }
    }

    val homeDir = File(context.filesDir, ".git-notes")
    val keyDir = File(homeDir, "keys")
    val keyFile = File(keyDir, "id_ed25519")
    val pubFile = File(keyDir, "id_ed25519.pub")
    val repoDir = File(homeDir, "repo")

    /* ---------- 远端绑定的唯一事实源：repo/.git/config 的 origin（对齐 server.js） ----------
       同一配置信息只存一份：origin 由 JGit（clone / remoteAdd|remoteRemove）落盘到 .git/config，
       应用启动时解析一次入内存，此后绑定/解绑只改内存。不再有 config.json——
       避免两处存储不一致导致的状态错乱（2026-10-28）。 */

    @Volatile private var cfgRemote: String = readOriginFromGitConfig()

    init {
        // 遗留清理（单一事实源改造遗留，若干版本后可移除）：旧版把远端地址存 config.json、日志名叫 log，均已废弃
        for (legacy in listOf("config.json", "log")) {
            try { File(homeDir, legacy).delete() } catch (_: Exception) {}
        }
    }

    private fun readOriginFromGitConfig(): String {
        return try {
            val txt = File(repoDir, ".git/config").readText()
            val m = Regex("""\[remote "origin"\][^\[]*?\burl\s*=\s*(\S+)""").find(txt)
            m?.groupValues?.get(1) ?: ""
        } catch (_: Exception) {
            ""   /* repo 不存在（fresh）或尚无 origin（local） */
        }
    }

    @Synchronized
    fun saveConfig(patchRemote: String? = null) {
        if (patchRemote != null) cfgRemote = patchRemote
        /* 仅内存；磁盘真相由相邻的 JGit remoteAdd|remoteRemove / clone 落盘 */
    }

    /* 分支定死 main（2026-10-27）：本地 main ↔ 远端 origin/main，无切换、无改名；远端无 main 时推送自动建立 */
    val MAIN_BRANCH = "main"
    fun remoteUrl(): String = cfgRemote
    fun hasRemote(): Boolean = cfgRemote.isNotEmpty()
    fun isSshRemote(u: String?): Boolean =
        Regex("^[\\w.-]+@[\\w.-]+:").containsMatchIn(u ?: "") || (u ?: "").startsWith("ssh://")

    class CloneState {
        @Volatile var active = false
        @Volatile var phase = ""
        @Volatile var progress = 0
        @Volatile var error = ""
    }

    class SyncState {
        @Volatile var busy = false
        @Volatile var phase = ""
        @Volatile var lastError = ""
        @Volatile var conflict: List<String>? = null
        @Volatile var lastAt: String? = null
        @Volatile var ahead = 0
        @Volatile var behind = 0
    }

    val cloneState = CloneState()
    val syncState = SyncState()
    @Volatile var writeBusy = false
    private val writeLock = Any()

    /* ---------- SSH（密钥生成 + JGit 会话工厂） ---------- */

    private val sshFactory: SshSessionFactory = object : JschConfigSessionFactory() {
        override fun configure(host: Host?, session: Session?) {
            // TOFU：known_hosts 缺记录时自动写入，已记录后严格校验
            session?.setConfig("StrictHostKeyChecking", "accept-new")
            session?.setConfig("PreferredAuthentications", "publickey")
        }

        override fun createDefaultJSch(fs: FS?): JSch {
            val jsch = super.createDefaultJSch(fs)
            jsch.removeAllIdentity()
            jsch.addIdentity(keyFile.absolutePath)
            val kh = File(keyDir, "known_hosts")
            if (!kh.exists()) kh.createNewFile()
            jsch.setKnownHosts(kh.absolutePath)
            return jsch
        }
    }

    private val sshCallback = TransportConfigCallback { transport ->
        (transport as SshTransport).sshSessionFactory = sshFactory
    }

    /** 已有则直接返回公钥；否则生成 ed25519 密钥对（私钥在 app 私有目录，0600 由沙箱保证）。
     *  设置页「查看公钥」无密钥时也走这里按需生成（apiSetupKey 无阶段守卫，双端一致）。
     *  注意：ed25519 私钥必须用 OpenSSH 格式写入（writeOpenSSHv1PrivateKey）；
     *  旧 PEM 写入器 writePrivateKey 会调 getPrivateKey()，Ed25519 上故意裸抛。 */
    fun ensureKey(): String {
        keyDir.mkdirs()
        if (keyFile.isFile && pubFile.isFile) return pubFile.readText().trim()
        val kp = KeyPair.genKeyPair(JSch(), KeyPair.ED25519)
        try {
            kp.writeOpenSSHv1PrivateKey(keyFile.absolutePath)
        } catch (e: Exception) {
            keyFile.delete()
            throw LocalApiError(500, "私钥写入失败：" + (e.message ?: e.toString()))
        }
        kp.writePublicKey(pubFile.absolutePath, "git-notes-android-" + stampFormat("yyyyMMdd").format(Date()))
        return pubFile.readText().trim()
    }

    /** 密钥泄漏时的用户自救：删除旧密钥对并重新生成（旧公钥在 git 服务器上立即失效） */
    fun rotateKey(): String {
        if (syncState.busy || writeBusy) throw LocalApiError(409, "同步或写入进行中")
        keyFile.delete()
        pubFile.delete()
        return ensureKey()
    }

    /** 导入用户已有私钥（OpenSSH 格式、无口令；任意算法类型）。
     *  与 web/server.js importKey 语义对齐：校验头部 → 写临时文件 → JSch 解析校验并派生公钥
     *  （格式错/带口令在 load 时抛错，等价 PC 版 ssh-keygen -y 失败）→ 通过才落地覆盖。 */
    fun importKey(privateKeyRaw: String): String {
        if (syncState.busy || writeBusy) throw LocalApiError(409, "同步或写入进行中")
        val raw = privateKeyRaw.replace("\r\n", "\n").trim()
        val firstLine = raw.lineSequence().firstOrNull() ?: ""
        if (!Regex("^-----BEGIN [A-Z ]*PRIVATE KEY-----$").matches(firstLine)) {
            throw LocalApiError(400, "不是 OpenSSH 私钥：内容需以 -----BEGIN … PRIVATE KEY----- 开头")
        }
        keyDir.mkdirs()
        val tmp = File(keyDir, "id_ed25519.import-tmp")
        try {
            tmp.writeText(raw + "\n")
            val pub = try {
                val kp = KeyPair.load(JSch(), tmp.absolutePath)
                val pubTmp = File(keyDir, "id_ed25519.import-pub-tmp")
                kp.writePublicKey(pubTmp.absolutePath, "")
                val p = pubTmp.readText().trim()
                pubTmp.delete()
                p
            } catch (e: LocalApiError) {
                throw e
            } catch (_: Exception) {
                throw LocalApiError(400, "私钥无效或带口令：仅支持无口令的 OpenSSH 格式私钥")
            }
            if (!Regex("^(ssh-[a-z0-9-]+|ecdsa-sha2-[a-z0-9-]+)\\s+[A-Za-z0-9+/=]+").containsMatchIn(pub)) {
                throw LocalApiError(400, "私钥无效：无法派生公钥")
            }
            // 校验通过才落地覆盖（PC 版为 rename 覆盖）
            keyFile.delete()
            pubFile.delete()
            if (!tmp.renameTo(keyFile)) throw LocalApiError(500, "私钥写入失败")
            pubFile.writeText(pub + "\n")
            return pub
        } catch (e: LocalApiError) {
            tmp.delete()
            throw e
        } catch (e: Exception) {
            tmp.delete()
            throw LocalApiError(500, "私钥导入失败：" + (e.message ?: e.toString()))
        }
    }

    /** 导出本机私钥内容（仅本机回环 + 页面凭证边界内，供用户迁移/备份） */
    fun exportPrivateKey(): String {
        if (!keyFile.isFile) throw LocalApiError(404, "本机尚无 SSH 私钥")
        return keyFile.readText()
    }

    /* ---------- 状态机：fresh → local →（绑定）→ ready；cloning 为瞬态 ---------- */

    fun hasRepo(): Boolean = File(repoDir, ".git").exists()

    fun stage(): String {
        // 克隆进行中 .git 会被提前创建，必须先看 active 标志（对齐 server.js stage()）
        if (cloneState.active) return "cloning"
        if (!hasRepo()) return "fresh"
        if (!hasRemote()) return "local"
        return "ready"
    }

    private fun ensureReadyForInternal() {
        if (stage() != "ready" && stage() != "local") throw LocalApiError(409, "尚未完成首次配置")
    }

    /** 读接口守卫：local 与 ready 均可读（对齐 server.js ensureReady） */
    fun ensureReady() {
        ensureReadyForInternal()
    }

    /** 后台克隆；返回 false 表示已在进行中 */
    fun startClone(remoteUrl: String): Boolean {
        if (cloneState.active) throw LocalApiError(409, "克隆正在进行中")
        if (hasRepo()) throw LocalApiError(409, "本地已存在仓库（如需重新克隆请先卸载重装应用）")
        if (remoteUrl.isBlank()) throw LocalApiError(400, "缺少远端地址")
        if (isSshRemote(remoteUrl)) ensureKey()
        homeDir.mkdirs()
        cloneState.active = true
        cloneState.phase = "连接远端"
        cloneState.progress = 0
        cloneState.error = ""
        Thread({
            try {
                Git.cloneRepository()
                    .setURI(remoteUrl)
                    .setDirectory(repoDir)
                    .setProgressMonitor(monitor { pct, ph -> cloneState.progress = pct; cloneState.phase = ph })
                    .setTransportConfigCallback(sshCallback)
                    .call().use { g ->
                        ensureAuthor(g)
                        // 绑定落库必须先行（空仓克隆时分支改名可能异常，不能连累 saveConfig 导致克隆成果被删）
                        saveConfig(remoteUrl)
                        // 分支定死 main：远端 HEAD 可能指向别的分支（如老仓库的 master），克隆后统一改名对齐
                        val br = g.repository.branch
                        if (br.isNotEmpty() && br != MAIN_BRANCH) {
                            g.branchRename().setOldName(br).setNewName(MAIN_BRANCH).call()
                        }
                    }
                cloneState.phase = "完成"
                cloneState.progress = 100
            } catch (e: Exception) {
                val msg = rootMessage(e)
                // 归一化认证失败消息，让前端 publickey 正则命中后展示公钥引导
                cloneState.error = if (isAuthError(msg)) "远端认证失败（publickey）：请把本机公钥添加到 git 服务器后重试" else msg
                repoDir.deleteRecursively()
            } finally {
                cloneState.active = false
            }
        }, "gn-clone").start()
        return true
    }

    private fun monitor(onPct: (Int, String) -> Unit) = object : ProgressMonitor {
        private var title = ""
        private var total = 0
        override fun start(totalTasks: Int) {}
        override fun beginTask(title: String?, totalWork: Int) {
            this.title = title ?: ""
            total = totalWork
        }

        override fun update(completed: Int) {
            if (total > 0) onPct((completed * 100L / total).toInt().coerceIn(0, 100), title.ifEmpty { "进行中" })
        }

        override fun endTask() {}
        override fun isCancelled(): Boolean = false
        override fun showDuration(enabled: Boolean) {}
    }

    /* ---------- 仅本机模式（setup/local：git init + 初始 tags） ---------- */

    fun setupLocal(): JSONObject {
        if (hasRepo()) return JSONObject().put("ready", true)
        repoDir.mkdirs()
        Git.init().setDirectory(repoDir).setInitialBranch("main").call().use { g ->
            ensureAuthor(g)
        }
        File(repoDir, "settings").mkdirs()
        writeMainRaw(defaultMain())
        git().use { g ->
            g.add().addFilepattern(MAIN_JSON).call()
            g.commit().setMessage("settings: init").call()
        }
        saveConfig(patchRemote = "")
        return JSONObject().put("ready", true)
    }

    /* ---------- 连接远端（local → ready）：只登记远端地址，不做任何 git 网络操作 ----------
       fetch/分支校验/合并/推送全部延迟到「立即同步」（doSync）时才发生 */

    fun bindConnect(remoteUrl: String): JSONObject {
        if (stage() != "local") throw LocalApiError(409, "仅「仅本机使用」模式可连接远端")
        if (remoteUrl.isBlank() || Regex("\\s").containsMatchIn(remoteUrl)) {
            throw LocalApiError(400, "远端地址不能为空且不能含空格")
        }
        git().use { g ->
            if (g.remoteList().call().any { it.name == "origin" }) {
                g.remoteRemove().setRemoteName("origin").call()
            }
            g.remoteAdd().setName("origin").setUri(org.eclipse.jgit.transport.URIish(remoteUrl)).call()
        }
        saveConfig(patchRemote = remoteUrl)
        return JSONObject().put("connected", true)
    }

    fun unbind() {
        if (stage() != "ready") throw LocalApiError(409, "当前未连接远端")
        git().use { g ->
            if (g.remoteList().call().any { it.name == "origin" }) {
                g.remoteRemove().setRemoteName("origin").call()
            }
        }
        syncState.conflict = null
        saveConfig(patchRemote = "")
    }

    fun forcePush() {
        if (stage() != "ready") throw LocalApiError(409, "当前未连接远端")
        pushBranch(force = true, setUpstream = false)
        syncState.ahead = 0
        syncState.conflict = null
        syncState.lastError = ""
        syncState.lastAt = nowIso()
    }

    /** 同步冲突二选一之一：远端覆盖本地（reset --hard 到 origin/main），本地未推送的提交将丢失 */
    fun remoteOverwrite(): JSONObject {
        if (stage() != "ready") throw LocalApiError(409, "当前未连接远端")
        git().use { g ->
            g.reset().setRef("refs/remotes/origin/$MAIN_BRANCH")
                .setMode(org.eclipse.jgit.api.ResetCommand.ResetType.HARD).call()
        }
        syncState.ahead = 0
        syncState.behind = 0
        syncState.conflict = null
        syncState.lastError = ""
        syncState.lastAt = nowIso()
        pyCache.clear()
        return JSONObject().put("overwritten", true)
    }

    private fun originUrl(): String? = git().use { g ->
        g.remoteList().call().firstOrNull { it.name == "origin" }?.getURIs()?.firstOrNull()?.toString()
    }

    /** push 等价（-u / --force 由参数控制）；失败抛出与 PC 一致格式的错误 */
    private fun pushBranch(force: Boolean, setUpstream: Boolean) {
        val branch = MAIN_BRANCH
        val results = git().use { g ->
            g.push()
                .setRemote("origin")
                .setRefSpecs(RefSpec("refs/heads/$branch:refs/heads/$branch"))
                .setForce(force)
                .setTransportConfigCallback(sshCallback)
                .call()
        }
        val updates = results.flatMap { it.remoteUpdates }
        val ok = updates.isNotEmpty() && updates.all {
            it.status == RemoteRefUpdate.Status.OK || it.status == RemoteRefUpdate.Status.UP_TO_DATE
        }
        if (!ok) {
            val detail = updates.firstOrNull { it.message != null }?.message ?: "远端拒绝"
            throw Exception("推送失败：$detail")
        }
        if (setUpstream) {
            git().use { g ->
                val cfg = g.repository.config
                cfg.setString("branch", branch, "remote", "origin")
                cfg.setString("branch", branch, "merge", "refs/heads/$branch")
                cfg.save()
            }
        }
    }

    /* ---------- 同步策略：rebase → merge（无关历史放行）→ 冲突待处理 ---------- */

    private fun git(): Git = Git.open(repoDir)

    fun doSync(): JSONObject {
        if (!hasRemote()) return JSONObject().put("local", true).put("ahead", 0).put("behind", 0)
        syncState.busy = true
        syncState.lastError = ""
        try {
            git().use { g ->
                syncState.phase = "获取远端"
                g.fetch().setRemote("origin").setTransportConfigCallback(sshCallback).call()
                // 本地分支必须是 main（应用创建的仓库恒为 main，若不是说明仓库被外部改动过），不自动改名
                val cur = g.repository.branch
                if (cur != MAIN_BRANCH) {
                    throw LocalApiError(409, "本地分支不是 $MAIN_BRANCH（应用创建的仓库不应出现此情况），请检查本地仓库")
                }
                // 远端没有 main：不管远端其他分支，直接把本地 main 推上去新建，完成
                val remoteId = g.repository.resolve("origin/" + MAIN_BRANCH)
                if (remoteId == null) {
                    syncState.phase = "新建远端 $MAIN_BRANCH 分支"
                    pushBranch(force = false, setUpstream = true)
                    syncState.ahead = 0; syncState.behind = 0; syncState.conflict = null
                    syncState.lastAt = nowIso()
                    return JSONObject().put("ahead", 0).put("behind", 0).put("created", MAIN_BRANCH)
                }
                val (ahead, behind) = aheadBehind(g)
                syncState.ahead = ahead
                syncState.behind = behind
                // 本地还没有提交：直接采用远端内容（补上本地缺的）
                val localCount = countCommits(g.repository, g.repository.resolve(Constants.HEAD))
                if (localCount == 0) {
                    g.reset().setRef("refs/remotes/origin/$MAIN_BRANCH")
                        .setMode(org.eclipse.jgit.api.ResetCommand.ResetType.HARD).call()
                    syncState.ahead = 0; syncState.behind = 0
                    syncState.lastAt = nowIso()
                    return JSONObject().put("ahead", 0).put("behind", 0).put("fastForward", true)
                }
                if (behind > 0) {
                    syncState.phase = "整合远端（落后 $behind 个提交）"
                    integrateRemote(g)
                    syncState.behind = 0
                }
                if (syncState.ahead > 0) {
                    syncState.phase = "推送（领先 ${syncState.ahead} 个提交）"
                    pushWithRetry(g)
                }
                syncState.lastAt = nowIso()
            }
            return JSONObject().put("ahead", syncState.ahead).put("behind", 0)
        } catch (e: Exception) {
            syncState.lastError = if (syncState.conflict != null) "存在冲突，等待处理" else rootMessage(e)
            throw e
        } finally {
            syncState.busy = false
            syncState.phase = ""
            pyCache.clear()   // 同步后远端内容可能已并入，拼音索引失效
        }
    }

    private fun aheadBehind(g: Git): Pair<Int, Int> {
        val repo = g.repository
        val localId = repo.resolve(MAIN_BRANCH) ?: return 0 to 0
        // 远端还没有本地分支（如本地刚改名分支）：ahead=全部本地提交，推送会在远端建立新分支
        val remoteId = repo.resolve("origin/" + MAIN_BRANCH) ?: return countCommits(repo, localId) to 0
        return countNotIn(repo, localId, remoteId) to countNotIn(repo, remoteId, localId)
    }

    private fun countNotIn(repo: Repository, fromId: org.eclipse.jgit.lib.AnyObjectId, notInId: org.eclipse.jgit.lib.AnyObjectId): Int {
        RevWalk(repo).use { walk ->
            walk.isRetainBody = false
            walk.markStart(walk.parseCommit(fromId))
            walk.markUninteresting(walk.parseCommit(notInId))
            var n = 0
            while (walk.next() != null) n++
            return n
        }
    }

    private fun countCommits(repo: Repository, id: org.eclipse.jgit.lib.AnyObjectId?): Int {
        if (id == null) return 0
        RevWalk(repo).use { walk ->
            walk.isRetainBody = false
            walk.markStart(walk.parseCommit(id))
            var n = 0
            while (walk.next() != null) n++
            return n
        }
    }

    /** 优先 rebase，失败转 merge（JGit 不拒绝无关历史，等价 --allow-unrelated-histories）；仍冲突则记录冲突清单并中止 */
    private fun integrateRemote(g: Git) {
        val upstream = "origin/" + MAIN_BRANCH
        val rr = try {
            g.rebase().setUpstream(upstream).call()
        } catch (e: Exception) {
            runCatching { g.rebase().setOperation(RebaseCommand.Operation.ABORT).call() }
            null
        }
        if (rr != null) {
            when (rr.status) {
                RebaseResult.Status.OK, RebaseResult.Status.UP_TO_DATE, RebaseResult.Status.FAST_FORWARD -> return
                else -> runCatching { g.rebase().setOperation(RebaseCommand.Operation.ABORT).call() }
            }
        }
        val mergeId = g.repository.resolve(upstream)
        val mr = g.merge().include(mergeId).call()
        if (mr.mergeStatus == org.eclipse.jgit.api.MergeResult.MergeStatus.MERGED ||
            mr.mergeStatus == org.eclipse.jgit.api.MergeResult.MergeStatus.FAST_FORWARD ||
            mr.mergeStatus == org.eclipse.jgit.api.MergeResult.MergeStatus.ALREADY_UP_TO_DATE
        ) return
        // 用 status.conflicting 取冲突清单（等价 ls-files -u；abort 前必须先取）
        val conflicts = g.status().call().conflicting.toList().sorted()
        runCatching {
            g.reset().setRef(Constants.HEAD).setMode(org.eclipse.jgit.api.ResetCommand.ResetType.HARD).call()
        }
        listOf("MERGE_HEAD", "MERGE_MSG").forEach { File(File(repoDir, ".git"), it).delete() }
        syncState.conflict = conflicts
        throw LocalApiError(409, "存在无法自动合并的冲突：" + conflicts.joinToString("、"), conflicts)
    }

    private fun pushWithRetry(g: Git) {
        for (attempt in 1..3) {
            val results = g.push()
                .setRemote("origin")
                .setRefSpecs(RefSpec("refs/heads/" + MAIN_BRANCH + ":refs/heads/" + MAIN_BRANCH))
                .setTransportConfigCallback(sshCallback)
                .call()
            val updates = results.flatMap { it.remoteUpdates }
            val ok = updates.isNotEmpty() && updates.all {
                it.status == RemoteRefUpdate.Status.OK || it.status == RemoteRefUpdate.Status.UP_TO_DATE
            }
            if (ok) {
                syncState.ahead = 0
                syncState.conflict = null
                return
            }
            g.fetch().setRemote("origin").setTransportConfigCallback(sshCallback).call()
            syncState.phase = "整合远端重试 $attempt"
            integrateRemote(g)
        }
        throw Exception("推送失败：远端持续有新提交，请稍后手动同步重试。")
    }

    private fun ensureAuthor(g: Git) {
        val cfg = g.repository.config
        if (!cfg.getString("user", null, "name").isNullOrEmpty()) return
        cfg.setString("user", null, "name", "git-notes")
        cfg.setString("user", null, "email", "git-notes@local")
        cfg.save()
    }

    /* ---------- 写前同步 + 提交推送（仅本机模式只 commit） ---------- */

    private fun writePreSync() {
        if (hasRemote()) doSync()
    }

    private fun commitAndPush(paths: List<String>, msg: String) {
        git().use { g ->
            paths.forEach { g.add().addFilepattern(it).call() }
            val commit = g.commit().setMessage(msg).call() // null = 无实际变化
            if (commit != null) pyCache.clear() // 写后拼音索引失效
            if (commit != null && hasRemote()) {
                syncState.phase = "推送"
                pushWithRetry(g)
                syncState.lastAt = nowIso()
            }
        }
    }

    /* ---------- 数据格式（与 web/server.js 完全一致） ---------- */

    fun pad2(n: Int): String = n.toString().padStart(2, '0')
    private fun stampFormat(pattern: String) = SimpleDateFormat(pattern, Locale.US)

    private fun tsOf(d: Date): String = stampFormat("yyyyMMdd-HHmmss").format(d)
    private fun createdStr(d: Date): String = stampFormat("yyyyMMdd HHmmss").format(d)
    fun nowIso(): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", Locale.US).format(Date())

    private fun summarize(text: String?, imgCount: Int): String {
        val t = (text ?: "").replace(Regex("\\s+"), " ").trim()
        if (t.isNotEmpty()) return t.take(12)
        return if (imgCount > 0) "图${imgCount}张" else "微笔记"
    }

    private fun buildMicroMd(tags: List<String>, created: String, images: List<String>, text: String, files: List<String> = emptyList()): String {
        val L = mutableListOf("---", "type: micro")
        if (tags.isNotEmpty()) L.add("tags: " + JSONArray(tags).toString())
        L.add("created: \"$created\"")
        if (images.isNotEmpty()) {
            L.add("images:")
            images.forEach { L.add("  - $it") }
        }
        if (files.isNotEmpty()) {
            L.add("files:")
            files.forEach { L.add("  - $it") }
        }
        L.add("---")
        L.add("")
        L.add(text.trim())
        return L.joinToString("\n") + "\n"
    }

    /** 与前端 parsePost 同构的 front matter 解析 */
    fun parsePost(raw: String, relPath: String): Post {
        val name = relPath.substringAfterLast('/')
        val stem = name.removeSuffix(".md")
        val fm = LinkedHashMap<String, Any>()
        var body = raw
        val m = Regex("^---\\r?\\n([\\s\\S]*?)\\r?\\n---\\r?\\n?").find(raw)
        if (m != null) {
            body = raw.substring(m.value.length)
            var lastKey: String? = null
            m.groupValues[1].split(Regex("\\r?\\n")).forEach { line ->
                val item = Regex("^\\s+-\\s*(.*)$").find(line)
                val lk = lastKey
                if (item != null && lk != null && (fm[lk] == "" || fm[lk] is MutableList<*>)) {
                    @Suppress("UNCHECKED_CAST")
                    val arr = (fm[lk] as? MutableList<String>) ?: mutableListOf<String>().also { fm[lk] = it }
                    arr.add(item.groupValues[1].trim().trim('"', '\''))
                    return@forEach
                }
                val kv = Regex("^(\\w+):\\s*(.*)$").find(line) ?: return@forEach
                var v = kv.groupValues[2].trim()
                lastKey = kv.groupValues[1]
                if (v.isEmpty()) {
                    fm[kv.groupValues[1]] = ""
                    return@forEach
                }
                if (v.startsWith("[") && v.endsWith("]")) {
                    fm[kv.groupValues[1]] = v.substring(1, v.length - 1).split(",")
                        .map { it.trim().trim('"', '\'') }.filter { it.isNotEmpty() }
                } else {
                    fm[kv.groupValues[1]] = v.trim('"', '\'')
                }
            }
        }
        return Post(
            path = relPath, name = name, stem = stem,
            dir = relPath.substringBeforeLast('/', ""),
            created = fm["created"] as? String ?: "",
            tags = (fm["tags"] as? List<String>) ?: emptyList(),
            images = (fm["images"] as? List<String>) ?: emptyList(),
            files = ((fm["files"] as? List<String>) ?: emptyList()).map { s ->
                val i = s.indexOf('|')
                if (i == -1) FileRef(s, s) else FileRef(s.take(i).ifEmpty { s.substring(i + 1) }, s.substring(i + 1))
            },
            text = body.trim(),
        )
    }

    class FileRef(val name: String, val path: String)

    class Post(
        val path: String, val name: String, val stem: String, val dir: String,
        val created: String, val tags: List<String>, val images: List<String>, val text: String,
        val files: List<FileRef> = emptyList(),
    ) {
        fun toJson(): JSONObject = JSONObject()
            .put("path", path).put("name", name).put("stem", stem).put("dir", dir)
            .put("created", created).put("tags", JSONArray(tags)).put("images", JSONArray(images)).put("text", text)
            .put("files", JSONArray().apply { files.forEach { put(JSONObject().put("name", it.name).put("path", it.path)) } })
    }

    private fun parseTagList(bytes: ByteArray): List<String> = try {
        val arr = JSONArray(String(bytes, Charsets.UTF_8))
        (0 until arr.length()).mapNotNull { i -> val s = arr.optString(i); s.ifBlank { null } }
    } catch (_: Exception) {
        emptyList()
    }

    private fun formatTags(tags: List<String>): String = JSONArray(tags).toString(2) + "\n"

    /* ---------- 读：按月列举 / 全库搜索 ---------- */

    private fun listMonths(): List<String> {
        val out = mutableListOf<String>()
        val yearsRoot = File(repoDir, "micro")
        val years = yearsRoot.listFiles()?.filter { it.isDirectory && it.name.matches(Regex("\\d{4}")) }
            ?.map { it.name }?.sortedDescending() ?: return out
        for (y in years) {
            val months = File(yearsRoot, y).listFiles()?.filter { it.isDirectory && it.name.matches(Regex("\\d{2}")) }
                ?.map { it.name }?.sortedDescending() ?: continue
            months.forEach { out.add(y + it) }
        }
        return out
    }

    private fun monthMdFiles(ym: String): List<String> {
        val d = File(repoDir, "micro/${ym.take(4)}/${ym.takeLast(2)}")
        return d.listFiles()?.filter { it.isFile && it.name.endsWith(".md") }
            ?.map { "micro/${ym.take(4)}/${ym.takeLast(2)}/${it.name}" } ?: emptyList()
    }

    private fun readPost(rel: String): Post? = try {
        parsePost(File(repoDir, rel).readText(Charsets.UTF_8), rel)
    } catch (_: Exception) {
        null
    }

    class Page(val month: String?, val posts: List<Post>, val pins: List<Post>, val more: Boolean)

    /** 返回一个「有内容的月份」：before 缺省取最新，否则取严格早于 before 的最近一个 */
    fun pagePosts(before: String?): Page {
        if (!before.isNullOrEmpty() && !before.matches(Regex("\\d{6}"))) throw LocalApiError(400, "before 须为 YYYYMM")
        val months = listMonths()
        val pool = if (before.isNullOrEmpty()) months else months.filter { it < before }
        val ym = pool.firstOrNull { monthMdFiles(it).isNotEmpty() } ?: return Page(null, emptyList(), emptyList(), false)
        val posts = monthMdFiles(ym).mapNotNull { readPost(it) }.sortedByDescending { it.stem }
        val idx = months.indexOf(ym)
        val more = months.drop(idx + 1).any { monthMdFiles(it).isNotEmpty() }
        /* 钉住帖随每次分页响应全量返回（来源 main.json pins，读单文件非全库扫描）；磁盘上已不存在的静默剔除 */
        val pins = readMain().optJSONArray("pins") ?: JSONArray()
        val pinPosts = (0 until pins.length()).mapNotNull { i ->
            val rel = pins.optString(i)
            if (File(repoDir, rel).isFile) readPost(rel) else null
        }
        return Page(ym, posts, pinPosts, more)
    }

    class Search(val hits: List<Post>, val total: Int, val ms: Long)

    /* ---------- 拼音索引（对齐 web/server.js pyIndexOf）：汉字转音节、其余字符原样保留 ---------- */
    private val pyCache = HashMap<String, Pair<String, String>>()
    private val cjkRegex = Regex("[\\u2e80-\\u9fff\\uf900-\\ufaff]")

    private fun pinyinIndexOf(p: Post): Pair<String, String> {
        pyCache[p.path]?.let { return it }
        val hay = p.text + "\n" + p.tags.joinToString(" ")
        val full = StringBuilder()
        val initials = StringBuilder()
        hay.forEach { ch ->
            val py = if (cjkRegex.matches(ch.toString())) PinyinData.charPinyin[ch.toString()] else null
            if (py != null) {
                full.append(py)
                initials.append(py[0])
            } else {
                full.append(ch)
                initials.append(ch)
            }
        }
        val e = Pair(full.toString().lowercase(), initials.toString().lowercase())
        pyCache[p.path] = e
        return e
    }

    fun searchAll(q: String): Search {
        val t0 = System.currentTimeMillis()
        val terms = q.lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }
        if (terms.isEmpty()) return Search(emptyList(), 0, 0)
        val hits = mutableListOf<Post>()
        var total = 0
        outer@ for (ym in listMonths()) {
            for (p in monthMdFiles(ym).mapNotNull { readPost(it) }) {
                total++
                val hay = (p.text + "\n" + p.tags.joinToString(" ")).lowercase()
                val py = pinyinIndexOf(p)
                if (terms.all { hay.contains(it) || py.first.contains(it) || py.second.contains(it) }) {
                    hits.add(p)
                    if (hits.size >= 200) break@outer
                }
            }
        }
        return Search(hits, total, System.currentTimeMillis() - t0)
    }

    /* ---------- 标签（动作语义：服务端基于磁盘现状合并） ---------- */

    /* ---------- 仓库统一设置 settings/main.json（version:1，收编原 tags.json/ai.json；对齐 web/electron） ---------- */

    private val MAIN_JSON = "settings/main.json"
    private val PIN_PATH_RE = Regex("^micro/\\d{4}/\\d{2}/[A-Za-z0-9._-]+\\.md$")

    /** AI 配置规范化（对齐 web validAiConfig）：未知字段丢弃，extra 须为对象 */
    fun validAiConfigJson(o: JSONObject?): JSONObject {
        val cfg = JSONObject()
            .put("baseURL", o?.optString("baseURL")?.trim()?.trimEnd('/')?.take(300) ?: "")
            .put("apiKey", o?.optString("apiKey")?.take(300) ?: "")
            .put("model", o?.optString("model")?.trim()?.take(100) ?: "")
        val extra = o?.optJSONObject("extra")
        cfg.put("extra", extra ?: JSONObject.NULL)
        return cfg
    }

    private fun defaultMain(): JSONObject = JSONObject()
        .put("version", 1)
        .put("tags", JSONArray(DEFAULT_TAGS))
        .put("pins", JSONArray())
        .put("ai", validAiConfigJson(null))

    private fun writeMainRaw(o: JSONObject) {
        File(repoDir, MAIN_JSON).writeText(o.toString(2) + "\n")
    }

    private fun normalizeMain(o: JSONObject): JSONObject {
        val m = JSONObject().put("version", 1)
        val tags = o.optJSONArray("tags")
        m.put("tags", if (tags != null) JSONArray(
            (0 until tags.length()).mapNotNull { i -> tags.optString(i).trim().take(16).ifBlank { null } }
        ) else JSONArray(DEFAULT_TAGS))
        val pins = o.optJSONArray("pins")
        m.put("pins", if (pins != null) JSONArray(
            (0 until pins.length()).mapNotNull { i -> pins.optString(i).takeIf { PIN_PATH_RE.matches(it) } }
        ) else JSONArray())
        m.put("ai", validAiConfigJson(o.optJSONObject("ai")))
        return m
    }

    fun readMain(): JSONObject {
        val raw = try { File(repoDir, MAIN_JSON).readText(Charsets.UTF_8) } catch (_: Exception) { null }
        if (raw != null) {
            /* 已有 main.json：解析失败或 version!=1 一律拒绝（为将来兼容留钩子），不走迁移 */
            val o = try { JSONObject(raw) } catch (_: Exception) { throw LocalApiError(500, "main.json 解析失败") }
            if (o.optInt("version") != 1) throw LocalApiError(500, "main.json version 非法")
            return normalizeMain(o)
        }
        /* 一次性收编旧配置（存量数据不丢）；写盘不提交，待下次设置写操作一并提交 */
        val m = defaultMain()
        try {
            val old = parseTagList(File(repoDir, "settings/tags.json").readBytes())
            if (old.isNotEmpty()) m.put("tags", JSONArray(old.map { it.trim().take(16) }))
        } catch (_: Exception) {}
        try {
            m.put("ai", validAiConfigJson(JSONObject(File(repoDir, "settings/ai.json").readText(Charsets.UTF_8))))
        } catch (_: Exception) {}
        try { writeMainRaw(m) } catch (_: Exception) {}
        return m
    }

    /** 写 main.json（提交推送；调用方需已持有单飞队列或自行包 enqueueWrite） */
    private fun commitMain(msg: String) {
        File(repoDir, "settings").mkdirs()
        git().use { g ->
            g.add().addFilepattern(MAIN_JSON).call()
            val commit = g.commit().setMessage(msg).call()
            if (commit != null) pyCache.clear() // 写后拼音索引失效
            if (commit != null && hasRemote()) {
                syncState.phase = "推送"
                pushWithRetry(g)
                syncState.lastAt = nowIso()
            }
        }
    }

    fun readTags(): List<String> {
        val tags = readMain().optJSONArray("tags") ?: return DEFAULT_TAGS
        return (0 until tags.length()).map { tags.optString(it) }
    }

    private fun validTags(tags: List<String>): List<String> {
        if (tags.size > 20) throw LocalApiError(400, "标签数量超限")
        return tags.map { t -> t.trim().replace(Regex("[\\[\\]\",{}]"), "").replace(Regex("\\s+"), " ").take(16) }
            .filter { it.isNotEmpty() }
    }

    fun writeTags(rawTags: JSONArray?, action: String?, tag: String?): List<String> {
        ensureReady()
        writePreSync()
        val m = readMain()
        val cur = readTags().toMutableList()
        var msg = "settings: init"
        val list: List<String>
        if (action == "add" && !tag.isNullOrBlank()) {
            if (!cur.contains(tag)) cur.add(tag)
            list = cur
            msg = "settings: add tag $tag"
        } else if (action == "remove" && !tag.isNullOrBlank()) {
            list = cur.filter { x -> x != tag }
            msg = "settings: remove tag $tag"
        } else {
            // 与 PC 一致：全量清单必须是合法数组，否则按超限报错
            val ja = rawTags ?: throw LocalApiError(400, "标签数量超限")
            list = validTags((0 until ja.length()).map { ja.optString(it) })
        }
        m.put("tags", JSONArray(list))
        writeMainRaw(m)
        commitMain(msg)
        return list
    }

    /** 钉住清单：main.json 的 pins（path 数组，上限 9；对齐 web/electron setPin） */
    fun setPin(rel: String, pinned: Boolean): List<String> = enqueueWrite {
        ensureReady()
        writePreSync()
        assertPostPath(rel)
        if (!File(repoDir, rel).isFile) throw LocalApiError(404, "笔记不存在（可能已在其他设备删除）")
        val summary = summarize(readPost(rel)?.text ?: "", 0)
        val m = readMain()
        val pins = (m.optJSONArray("pins") ?: JSONArray()).let { ja -> (0 until ja.length()).map { ja.optString(it) } }.toMutableList()
        val has = pins.contains(rel)
        if (pinned && !has) {
            if (pins.size >= 9) throw LocalApiError(400, "最多钉住 9 篇笔记")
            pins.add(rel)
        } else if (!pinned && has) {
            pins.remove(rel)
        }
        m.put("pins", JSONArray(pins))
        writeMainRaw(m)
        commitMain((if (pinned) "settings: pin " else "settings: unpin ") + summary)
        pins
    }

    /* ---------- 写：发布 / 编辑 / 删除（单飞队列） ---------- */

    class ImgPayload(val ext: String, val buf: ByteArray)

    private fun validImages(images: JSONArray?): List<ImgPayload> {
        if (images == null) return emptyList()
        if (images.length() > MAX_IMAGES) throw LocalApiError(400, "最多 $MAX_IMAGES 张图")
        return (0 until images.length()).map { i ->
            val o = images.getJSONObject(i)
            val ext = o.optString("ext").lowercase()
            val b64 = o.optString("base64")
            if (!IMG_MIME.containsKey(ext)) throw LocalApiError(400, "仅支持图片（png/jpg/webp/gif/bmp/avif）")
            if (!Regex("^[A-Za-z0-9+/=\\r\\n]+$").matches(b64) || b64.length > 14 * 1024 * 1024) {
                throw LocalApiError(400, "图片数据非法或超过 10MB")
            }
            ImgPayload(ext, Base64.decode(b64, Base64.DEFAULT))
        }
    }

    class FilePayload(val name: String, val ext: String, val buf: ByteArray)

    /** 附件原始文件名消毒：剥离 |、控制字符与换行（md 条目用 | 分隔 原名|磁盘名），截断 120 字符 */
    fun sanitizeFileName(name: String?): String {
        val s = (name ?: "").replace(Regex("[|\r\n\t\\x00-\\x1f\\x7f]"), " ").replace(Regex("\\s+"), " ").trim().take(120)
        return s.ifEmpty { "file" }
    }

    private fun validFiles(files: JSONArray?): List<FilePayload> {
        if (files == null) return emptyList()
        if (files.length() > MAX_FILES) throw LocalApiError(400, "最多 $MAX_FILES 个附件")
        return (0 until files.length()).map { i ->
            val o = files.getJSONObject(i)
            val name = sanitizeFileName(o.optString("name"))
            val ext = o.optString("ext").lowercase()
            val b64 = o.optString("base64")
            if (!Regex("^[a-z0-9]{1,12}$").matches(ext)) throw LocalApiError(400, "附件扩展名非法")
            if (!Regex("^[A-Za-z0-9+/=\\r\\n]+$").matches(b64) || b64.length > 14 * 1024 * 1024) {
                throw LocalApiError(400, "附件数据非法或超过 10MB")
            }
            FilePayload(name, ext, Base64.decode(b64, Base64.DEFAULT))
        }
    }

    fun <T> enqueueWrite(fn: () -> T): T = synchronized(writeLock) {
        writeBusy = true
        try {
            fn()
        } finally {
            writeBusy = false
        }
    }

    fun writePost(text: String, tags: List<String>, images: JSONArray?, files: JSONArray? = null, ai: Boolean = false): Post = enqueueWrite {
        ensureReady()
        writePreSync()
        val cleanTags = validTags(tags)
        val imgs = validImages(images)
        val fls = validFiles(files)
        val now = Date()
        val dir = "micro/" + stampFormat("yyyy").format(now) + "/" + pad2(stampFormat("MM").format(now).toInt())
        File(repoDir, dir).mkdirs()
        val stem = tsOf(now)
        // 附件磁盘名用 -fN 命名空间，与图片 -N 互不干扰（updatePost 的图片序号正则 -(\\d+). 不会误吞 -fN）
        val names = imgs.mapIndexed { idx, _ -> "$stem-${idx + 1}.${imgs[idx].ext}" }
        val fileNames = fls.mapIndexed { idx, _ -> "$stem-f${idx + 1}.${fls[idx].ext}" }
        val rel = "$dir/$stem.md"
        if (File(repoDir, rel).exists()) throw LocalApiError(409, "同一秒内已有发布，请稍候 1 秒重试")
        File(repoDir, rel).writeText(buildMicroMd(cleanTags, createdStr(now), names, text, fls.mapIndexed { idx, f -> "${f.name}|${fileNames[idx]}" }))
        imgs.forEachIndexed { idx, im -> File(File(repoDir, dir), names[idx]).writeBytes(im.buf) }
        fls.forEachIndexed { idx, f -> File(File(repoDir, dir), fileNames[idx]).writeBytes(f.buf) }
        commitAndPush(listOf(rel) + names.map { "$dir/$it" } + fileNames.map { "$dir/$it" }, "micro: add " + summarize(text, imgs.size) + if (ai) " [ai]" else "")
        Post(rel, "$stem.md", stem, dir, createdStr(now), cleanTags, names, text.trim(), fls.mapIndexed { idx, f -> FileRef(f.name, fileNames[idx]) })
    }

    fun updatePost(
        rel: String, text: String, tags: List<String>,
        keepNames: List<String>?, newImages: JSONArray?,
        keepFileNames: List<String>? = null, newFiles: JSONArray? = null,
        ai: Boolean = false,
    ): Post = enqueueWrite {
        ensureReady()
        writePreSync()
        assertPostPath(rel)
        val f = File(repoDir, rel)
        if (!f.isFile) throw LocalApiError(404, "笔记不存在（可能已在其他设备删除）")
        val cur = readPost(rel)!!
        val cleanTags = validTags(tags)
        val keep = (keepNames ?: cur.images).filter { cur.images.contains(it) }
        val newImgs = validImages(newImages)
        if (keep.size + newImgs.size > MAX_IMAGES) throw LocalApiError(400, "最多 $MAX_IMAGES 张图")
        val keepF = if (keepFileNames != null) cur.files.filter { keepFileNames.contains(it.path) } else cur.files
        val newFls = validFiles(newFiles)
        if (keepF.size + newFls.size > MAX_FILES) throw LocalApiError(400, "最多 $MAX_FILES 个附件")
        val removed = cur.images.filter { !keep.contains(it) }
        val removedF = cur.files.filter { !keepF.contains(it) }.map { it.path }
        var seq = (keep + removed).mapNotNull { Regex("-(\\d+)\\.[A-Za-z0-9]+$").find(it)?.groupValues?.get(1)?.toIntOrNull() }.maxOrNull() ?: 0
        var fseq = (keepF.map { it.path } + removedF).mapNotNull { Regex("-f(\\d+)\\.[A-Za-z0-9]+$").find(it)?.groupValues?.get(1)?.toIntOrNull() }.maxOrNull() ?: 0
        val names = newImgs.map { im -> "${cur.stem}-${++seq}.${im.ext}" }
        val fileNames = newFls.map { fl -> "${cur.stem}-f${++fseq}.${fl.ext}" }
        File(repoDir, rel).writeText(buildMicroMd(cleanTags, cur.created, keep + names, text, keepF.map { "${it.name}|${it.path}" } + newFls.mapIndexed { idx, fl -> "${fl.name}|${fileNames[idx]}" }))
        newImgs.forEachIndexed { idx, im -> File(File(repoDir, cur.dir), names[idx]).writeBytes(im.buf) }
        newFls.forEachIndexed { idx, fl -> File(File(repoDir, cur.dir), fileNames[idx]).writeBytes(fl.buf) }
        (removed + removedF).forEach { nm ->
            val rf = File(File(repoDir, cur.dir), nm)
            if (rf.isFile) rf.delete()
        }
        git().use { g ->
            g.add().addFilepattern(cur.dir).call() // add -A 语义：含删除
            val commit = g.commit().setMessage("micro: update " + summarize(text, keep.size + newImgs.size) + if (ai) " [ai]" else "").call()
            if (commit != null) pyCache.clear() // 写后拼音索引失效
            if (commit != null && hasRemote()) {
                syncState.phase = "推送"
                pushWithRetry(g)
                syncState.lastAt = nowIso()
            }
        }
        Post(rel, cur.name, cur.stem, cur.dir, cur.created, cleanTags, keep + names, text.trim(), keepF + newFls.mapIndexed { idx, fl -> FileRef(fl.name, fileNames[idx]) })
    }

    fun deletePost(rel: String, ai: Boolean = false) = enqueueWrite {
        ensureReady()
        writePreSync()
        assertPostPath(rel)
        if (!File(repoDir, rel).isFile) throw LocalApiError(404, "笔记不存在")
        val cur = readPost(rel)!!
        val summary = summarize(cur.text, cur.images.size)
        git().use { g ->
            runCatching { g.rm().addFilepattern(rel).call() }.onFailure { File(repoDir, rel).delete() }
            cur.images.forEach { nm ->
                val rf = File(File(repoDir, cur.dir), nm)
                if (rf.isFile) {
                    runCatching { g.rm().addFilepattern("${cur.dir}/$nm").call() }.onFailure { rf.delete() }
                }
            }
            cur.files.forEach { fr ->
                val rf = File(File(repoDir, cur.dir), fr.path)
                if (rf.isFile) {
                    runCatching { g.rm().addFilepattern("${cur.dir}/${fr.path}").call() }.onFailure { rf.delete() }
                }
            }
            g.add().addFilepattern(cur.dir).call() // 兜底：rm 走不通的以工作区现状入库
            /* 钉住清单里的残留顺手清掉，与删除同一提交落地（对齐 web/electron deletePost） */
            val pins = (readMain().optJSONArray("pins") ?: JSONArray()).let { ja -> (0 until ja.length()).map { ja.optString(it) } }
            if (pins.contains(rel)) {
                val m = readMain()
                m.put("pins", JSONArray(pins.filter { it != rel }))
                writeMainRaw(m)
                g.add().addFilepattern(MAIN_JSON).call()
            }
            val commit = g.commit().setMessage("micro: delete $summary" + if (ai) " [ai]" else "").call()
            if (commit != null) pyCache.clear() // 写后拼音索引失效
            if (commit != null && hasRemote()) {
                syncState.phase = "推送"
                pushWithRetry(g)
                syncState.lastAt = nowIso()
            }
        }
    }

    // ===== git 历史（AI 工具用）：只读查阅 / 时点读取 / 恢复=新提交，绝不重写历史（语义对齐 web server.js）=====

    fun gitLog(limit: Int, path: String): List<JSONObject> {
        ensureReady()
        git().use { g ->
            var cmd = g.log().setMaxCount(limit)
            if (path.isNotEmpty()) {
                assertPostPath(path)
                cmd = cmd.addPath(path)
            }
            return cmd.call().map { c ->
                JSONObject()
                    .put("hash", c.name)
                    .put("date", stampFormat("yyyy-MM-dd'T'HH:mm:ssZ").format(c.authorIdent.`when`))
                    .put("subject", c.shortMessage)
            }
        }
    }

    fun gitShow(path: String, commit: String): String {
        ensureReady()
        assertPostPath(path)
        if (!Regex("^[0-9a-fA-F]{7,40}$").matches(commit)) throw LocalApiError(400, "commit 无效")
        git().use { g ->
            val repo = g.repository
            val id = repo.resolve(commit) ?: throw LocalApiError(404, "提交不存在")
            val tree = RevWalk(repo).use { walk -> walk.parseCommit(id).tree }
            val tw = TreeWalk.forPath(repo, path, tree) ?: throw LocalApiError(404, "该提交中不存在此文件")
            tw.use { return String(repo.open(tw.getObjectId(0)).bytes, Charsets.UTF_8) }
        }
    }

    fun gitRestore(path: String, commit: String, ai: Boolean): Unit = enqueueWrite {
        ensureReady()
        writePreSync()
        val text = gitShow(path, commit) // 复用参数校验（path 白名单 + commit 格式 + 存在性）
        File(repoDir, path).writeText(text)
        val cur = readPost(path) ?: throw LocalApiError(500, "恢复后的笔记解析失败")
        git().use { g ->
            g.add().addFilepattern(path).call()
            val suffix = if (ai) " [ai]" else " [restore]"
            val c = g.commit().setMessage("micro: update " + summarize(cur.text, cur.images.size) + suffix).call()
            if (c != null) pyCache.clear() // 写后拼音索引失效
            if (c != null && hasRemote()) {
                syncState.phase = "推送"
                pushWithRetry(g)
                syncState.lastAt = nowIso()
            }
        }
    }

    // ===== AI 配置：存仓库统一设置 settings/main.json 的 ai 键（随 git 同步，多端共享；语义对齐 web server.js）=====

    fun readAiSettings(): JSONObject {
        val ai = readMain().optJSONObject("ai")
        return ai ?: validAiConfigJson(null)
    }

    fun setAiSettings(cfg: JSONObject): Unit = enqueueWrite {
        ensureReady()
        writePreSync()
        val m = readMain()
        m.put("ai", cfg)
        writeMainRaw(m)
        commitMain("settings: set ai")
    }

    // ===== AI 文件操作与全量 git（AI 工具用；语义对齐 web server.js 同名函数）=====
    // 作用域红线：路径规范化后必须落在 repoDir 内；.git 段与 .. 一律拒绝。
    // fs 系列只落盘不提交（统一走 git_add + git_commit 提交）；覆盖前副本存 homeDir 的 .fs-backup（仓外，防污染仓库）。

    fun assertRepoPath(p: String?, allowRoot: Boolean = false): Pair<String, File> {
        if (p == null) throw LocalApiError(400, "路径不能为空")
        val norm = p.replace('\\', '/').trim()
        val segs = norm.split('/').filter { it.isNotEmpty() && it != "." }
        if (norm.startsWith("/")) throw LocalApiError(400, "路径须为仓库相对路径")
        if (segs.any { it == ".." || it.equals(".git", true) || Regex("^[A-Za-z]:$").matches(it) }) {
            throw LocalApiError(400, "路径非法（禁止 ..、.git 与盘符）")
        }
        if (segs.isEmpty() && !allowRoot) throw LocalApiError(400, "路径不能为仓库根目录")
        val abs = if (segs.isEmpty()) repoDir else File(repoDir, segs.joinToString("/"))
        if (abs != repoDir && !abs.canonicalPath.startsWith(repoDir.canonicalPath + File.separator)) {
            throw LocalApiError(400, "路径越界")
        }
        return Pair(segs.joinToString("/"), abs)
    }

    fun fsList(q: String?): JSONObject {
        ensureReady()
        val (rel, abs) = assertRepoPath(q ?: "", allowRoot = true)
        if (rel.isNotEmpty() && !abs.exists()) throw LocalApiError(404, "路径不存在：$rel")
        if (abs.exists() && !abs.isDirectory) throw LocalApiError(400, "不是目录：$rel")
        val entries = (abs.listFiles() ?: emptyArray())
            .filter { it.name != ".git" }
            .map {
                JSONObject()
                    .put("name", it.name)
                    .put("type", if (it.isDirectory) "dir" else if (it.isFile) "file" else "other")
                    .put("size", it.length())
                    .put("mtime", nowIso())
            }
            .sortedWith(compareBy({ it.optString("type") != "dir" }, { it.optString("name") }))
        return JSONObject().put("path", rel.ifEmpty { "" }).put("entries", JSONArray(entries)).put("count", entries.size)
    }

    fun fsRead(q: String?): JSONObject {
        ensureReady()
        val (rel, abs) = assertRepoPath(q)
        if (!abs.isFile) throw LocalApiError(404, "文件不存在：$rel")
        if (abs.length() > 10L * 1024 * 1024) throw LocalApiError(400, "文件超过 10MB，AI 无法读取：$rel")
        val bytes = abs.readBytes()
        val binary = bytes.take(8192).contains(0)
        return if (binary) {
            JSONObject().put("path", rel).put("encoding", "base64").put("size", abs.length())
                .put("truncated", false).put("content", Base64.encodeToString(bytes, Base64.NO_WRAP))
        } else {
            JSONObject().put("path", rel).put("encoding", "text").put("size", abs.length())
                .put("truncated", false).put("content", String(bytes, Charsets.UTF_8))
        }
    }

    private fun backupIfExists(abs: File, name: String): Boolean {
        if (!abs.exists()) return false
        val bdir = File(homeDir, ".fs-backup")
        bdir.mkdirs()
        val stamp = nowIso().replace(":", "-").replace(".", "-")
        abs.copyTo(File(bdir, "$stamp-$name"), overwrite = true)
        return true
    }

    fun fsWrite(body: JSONObject?): JSONObject = enqueueWrite {
        ensureReady()
        val (rel, abs) = assertRepoPath(body?.optString("path"))
        val isB64 = "base64" == body?.optString("encoding")
        val raw = body?.optString("content") ?: ""
        if (isB64 && !Regex("^[A-Za-z0-9+/=\\r\\n]*$").matches(raw)) throw LocalApiError(400, "base64 数据非法")
        val bytes: ByteArray = if (isB64) Base64.decode(raw.replace(Regex("\\s"), ""), Base64.DEFAULT) else raw.toByteArray(Charsets.UTF_8)
        if (bytes.size > 20 * 1024 * 1024) throw LocalApiError(413, "内容超过 20MB 上限")
        val existed = abs.exists()
        if (existed && abs.isDirectory) throw LocalApiError(400, "同名目录已存在：$rel")
        abs.parentFile?.mkdirs()
        val backed = backupIfExists(abs, rel.substringAfterLast('/'))
        abs.writeBytes(bytes)
        pyCache.clear()
        JSONObject().put("path", rel).put("size", bytes.size).put("overwrote", existed).put("backup", backed)
    }

    fun fsDelete(body: JSONObject?): JSONObject = enqueueWrite {
        ensureReady()
        val pathsJa = body?.optJSONArray("paths")
        val paths: List<String> = when {
            pathsJa != null -> (0 until pathsJa.length()).map { pathsJa.optString(it) }
            !body?.optString("path").isNullOrEmpty() -> listOf(body!!.optString("path"))
            else -> emptyList()
        }
        if (paths.isEmpty() || paths.size > 50) throw LocalApiError(400, "paths 须为 1~50 个路径")
        val results = paths.map { p ->
            val (rel, abs) = assertRepoPath(p)
            when {
                !abs.exists() -> JSONObject().put("path", rel).put("error", "不存在")
                abs.isDirectory -> {
                    if (abs.listFiles()?.isNotEmpty() == true) {
                        JSONObject().put("path", rel).put("error", "目录非空，先删空其中文件")
                    } else {
                        abs.delete()
                        JSONObject().put("path", rel).put("deleted", true)
                    }
                }
                else -> {
                    backupIfExists(abs, rel.substringAfterLast('/'))
                    abs.delete()
                    JSONObject().put("path", rel).put("deleted", true)
                }
            }
        }
        pyCache.clear()
        JSONObject().put("results", JSONArray(results))
    }

    fun fsMove(body: JSONObject?): JSONObject = enqueueWrite {
        ensureReady()
        val (from, fromAbs) = assertRepoPath(body?.optString("from"))
        val (to, toAbs) = assertRepoPath(body?.optString("to"))
        if (!fromAbs.exists()) throw LocalApiError(404, "源不存在：$from")
        if (toAbs.exists()) throw LocalApiError(409, "目标已存在：$to")
        toAbs.parentFile?.mkdirs()
        if (!fromAbs.renameTo(toAbs)) throw LocalApiError(500, "移动失败")
        pyCache.clear()
        JSONObject().put("from", from).put("to", to)
    }

    fun fsMkdir(body: JSONObject?): JSONObject = enqueueWrite {
        ensureReady()
        val (rel, abs) = assertRepoPath(body?.optString("path"))
        if (abs.exists()) throw LocalApiError(409, "已存在：$rel")
        abs.mkdirs()
        JSONObject().put("path", rel)
    }

    // ---- 全量 git（面向 AI）：add 只收显式路径清单（不做全仓 add），提交与推拉、差异、分支、文件级恢复 ----

    /** porcelain 等价：JGit Status 分桶映射为 x/y 两字符状态 + ahead/behind */
    fun gitStatus(): JSONObject {
        ensureReady()
        return git().use { g ->
            val repo = g.repository
            val st = g.status().call()
            val entries = mutableListOf<JSONObject>()
            st.untracked.forEach { entries.add(JSONObject().put("x", "?").put("y", "?").put("path", it)) }
            st.added.forEach { entries.add(JSONObject().put("x", "A").put("y", " ").put("path", it)) }
            st.changed.forEach { entries.add(JSONObject().put("x", "M").put("y", " ").put("path", it)) }
            st.removed.forEach { entries.add(JSONObject().put("x", "D").put("y", " ").put("path", it)) }
            st.modified.forEach { entries.add(JSONObject().put("x", " ").put("y", "M").put("path", it)) }
            st.missing.forEach { entries.add(JSONObject().put("x", " ").put("y", "D").put("path", it)) }
            st.conflicting.forEach { entries.add(JSONObject().put("x", "U").put("y", "U").put("path", it)) }
            val branch = repo.branch
            val cfg = repo.config
            val upRemote = cfg.getString("branch", branch, "remote") ?: ""
            val upMerge = (cfg.getString("branch", branch, "merge") ?: "").removePrefix("refs/heads/")
            var ahead = 0
            var behind = 0
            val localId = repo.resolve(branch)
            val remoteId = repo.resolve("origin/$branch")
            if (localId != null && remoteId != null) {
                val ab = aheadBehind(g)
                ahead = ab.first; behind = ab.second
            }
            JSONObject()
                .put("branch", branch)
                .put("upstream", if (upRemote.isNotEmpty() && upMerge.isNotEmpty()) "$upRemote/$upMerge" else "")
                .put("ahead", ahead).put("behind", behind)
                .put("entries", JSONArray(entries)).put("count", entries.size).put("clean", entries.isEmpty())
        }
    }

    private fun stagedCount(st: org.eclipse.jgit.api.Status): Int =
        st.added.size + st.changed.size + st.removed.size

    fun gitAdd(body: JSONObject?): JSONObject {
        ensureReady()
        val ja = body?.optJSONArray("paths")
        val paths: List<String> = ja?.let { (0 until it.length()).map { i -> it.optString(i) } } ?: emptyList()
        val rels = paths.filter { it.isNotBlank() }.map { assertRepoPath(it).first }
        if (rels.isEmpty() || rels.size > 200) throw LocalApiError(400, "paths 须为 1~200 个路径（显式清单，不做全仓 add）")
        return enqueueWrite {
            git().use { g ->
                rels.forEach { rel ->
                    // addFilepattern 接受带斜杠的相对路径；目录则以目录为单位暂存
                    g.add().addFilepattern(rel).call()
                    // 新文件需要显式 update 语义之外的处理：add 已含 untracked
                }
                val st = g.status().call()
                JSONObject().put("added", JSONArray(rels)).put("stagedCount", stagedCount(st))
            }
        }
    }

    fun gitCommit(body: JSONObject?): JSONObject {
        ensureReady()
        val msg = (body?.optString("message") ?: "").trim()
        if (msg.isEmpty() || msg.length > 500) throw LocalApiError(400, "提交消息不能为空且不超过 500 字符")
        return enqueueWrite {
            git().use { g ->
                ensureAuthor(g)
                if (stagedCount(g.status().call()) == 0) {
                    throw LocalApiError(400, "暂存区为空：先用 git_add 暂存要提交的文件")
                }
                g.commit().setMessage(msg).call()
                val repo = g.repository
                val hash = repo.resolve(Constants.HEAD).abbreviate(7).name()
                var unpushed = 0
                if (hasRemote()) {
                    val remoteId = repo.resolve("origin/" + MAIN_BRANCH)
                    val localId = repo.resolve(Constants.HEAD)
                    unpushed = if (remoteId != null) countNotIn(repo, localId, remoteId) else countCommits(repo, localId)
                }
                pyCache.clear()
                JSONObject().put("committed", true).put("hash", hash).put("message", msg).put("unpushed", unpushed)
            }
        }
    }

    fun gitPush(): JSONObject {
        ensureReady()
        if (!hasRemote()) throw LocalApiError(409, "仅本机模式无远端可推送")
        if (syncState.busy || writeBusy) throw LocalApiError(409, "同步或写入进行中")
        return enqueueWrite {
            pushBranch(force = false, setUpstream = false)
            syncState.ahead = 0
            syncState.lastAt = nowIso()
            JSONObject().put("pushed", true)
        }
    }

    fun gitPull(): JSONObject {
        ensureReady()
        if (!hasRemote()) throw LocalApiError(409, "仅本机模式无远端可拉取")
        if (syncState.busy || writeBusy) throw LocalApiError(409, "同步或写入进行中")
        return enqueueWrite {
            syncState.busy = true
            syncState.lastError = ""
            try {
                git().use { g ->
                    syncState.phase = "获取远端"
                    g.fetch().setRemote("origin").setTransportConfigCallback(sshCallback).call()
                    val br = MAIN_BRANCH
                    if (g.repository.resolve("origin/$br") == null) {
                        return@use JSONObject().put("pulled", false).put("note", "远端尚无分支 $br，无可整合内容")
                    }
                    val (ahead, behind) = aheadBehind(g)
                    if (behind == 0) {
                        return@use JSONObject().put("pulled", false).put("note", "已是最新（远端无新提交）").put("ahead", ahead)
                    }
                    syncState.phase = "整合远端（落后 $behind 个提交）"
                    integrateRemote(g)
                    syncState.behind = 0
                    syncState.lastAt = nowIso()
                    pyCache.clear()
                    JSONObject().put("pulled", true).put("integrated", behind).put("ahead", ahead)
                }
            } catch (e: Exception) {
                syncState.lastError = if (syncState.conflict != null) "存在冲突，等待处理" else rootMessage(e)
                throw e
            } finally {
                syncState.busy = false
                syncState.phase = ""
            }
        }
    }

    private fun validRef(s: String, label: String): String {
        if (s.isNotEmpty() && !Regex("^[0-9a-fA-F]{7,40}$").matches(s) && !Regex("^HEAD(~\\d+)?$").matches(s) && s != "STAGED") {
            throw LocalApiError(400, "$label 无效")
        }
        return s
    }

    fun gitDiff(from: String, to: String, path: String, mode: String): JSONObject {
        ensureReady()
        validRef(from, "from")
        validRef(to, "to")
        val rel = if (path.isNotEmpty()) assertRepoPath(path).first else ""
        val bos = java.io.ByteArrayOutputStream()
        val fmt = org.eclipse.jgit.diff.DiffFormatter(bos)
        return git().use { g ->
            fmt.setRepository(g.repository)
            if (rel.isNotEmpty()) fmt.setPathFilter(org.eclipse.jgit.treewalk.filter.PathFilter.create(rel))
            val reader = g.repository.newObjectReader()
            val headTree = RevWalk(g.repository).use { w ->
                val headId = g.repository.resolve(Constants.HEAD)
                if (headId == null) null else w.parseCommit(headId).tree
            }
            val entries: List<org.eclipse.jgit.diff.DiffEntry> = when {
                from == "STAGED" || (from.isEmpty() && to.isEmpty() && mode == "staged") -> {
                    // 暂存区对 HEAD
                    if (headTree == null) emptyList() else {
                        val oldIter = org.eclipse.jgit.treewalk.CanonicalTreeParser(null, reader, headTree)
                        val newIter = org.eclipse.jgit.dircache.DirCacheIterator(g.repository.readDirCache())
                        fmt.scan(oldIter, newIter)
                    }
                }
                from.isNotEmpty() && to.isNotEmpty() -> {
                    val oldId = g.repository.resolve(from) ?: throw LocalApiError(400, "from 无效")
                    val newId = g.repository.resolve(to) ?: throw LocalApiError(400, "to 无效")
                    val oldTree = RevWalk(g.repository).use { w -> w.parseCommit(oldId).tree }
                    val newTree = RevWalk(g.repository).use { w -> w.parseCommit(newId).tree }
                    fmt.scan(
                        org.eclipse.jgit.treewalk.CanonicalTreeParser(null, reader, oldTree),
                        org.eclipse.jgit.treewalk.CanonicalTreeParser(null, reader, newTree),
                    )
                }
                from.isNotEmpty() -> {
                    // from 时点对工作区
                    val oldId = g.repository.resolve(from) ?: throw LocalApiError(400, "from 无效")
                    val oldTree = RevWalk(g.repository).use { w -> w.parseCommit(oldId).tree }
                    fmt.scan(
                        org.eclipse.jgit.treewalk.CanonicalTreeParser(null, reader, oldTree),
                        org.eclipse.jgit.treewalk.FileTreeIterator(g.repository),
                    )
                }
                else -> {
                    // 工作区对 HEAD
                    if (headTree == null) emptyList() else fmt.scan(
                        org.eclipse.jgit.treewalk.CanonicalTreeParser(null, reader, headTree),
                        org.eclipse.jgit.treewalk.FileTreeIterator(g.repository),
                    )
                }
            }
            val cmdLine = buildString {
                append("git diff --no-color")
                if (mode == "stat") append(" --stat")
                if (from == "STAGED") append(" --cached") else {
                    if (from.isNotEmpty()) append(" ").append(from)
                    if (to.isNotEmpty()) append(" ").append(to)
                }
                if (rel.isNotEmpty()) append(" -- ").append(rel)
            }
            if (mode == "stat") {
                entries.forEach { e ->
                    bos.write((e.changeType.name + " " + e.newPath + "\n").toByteArray(Charsets.UTF_8))
                }
            } else {
                entries.forEach { fmt.format(it) }
            }
            fmt.close()
            var text = bos.toString("UTF-8")
            val truncated = text.length > 20000
            if (truncated) text = text.take(20000) + "\n…（差异过长已截断，可加 path 参数缩小范围）"
            JSONObject().put("text", text).put("truncated", truncated).put("command", cmdLine)
        }
    }

    /* 分支定死 main（2026-10-27）：AI 的 git_branch 只保留 list；create/switch 已删——本地切走会让按 main 同步的流程错乱 */
    fun gitBranchOp(body: JSONObject?): JSONObject {
        ensureReady()
        return git().use { g ->
            val cur = g.repository.branch
            val branches = g.branchList().call().map { ref ->
                JSONObject()
                    .put("name", ref.name.removePrefix("refs/heads/"))
                    .put("hash", ref.objectId.abbreviate(7).name())
                    .put("current", ref.name.removePrefix("refs/heads/") == cur)
            }
            JSONObject().put("branches", JSONArray(branches)).put("remote", remoteUrl())
        }
    }

    fun gitRestoreFiles(body: JSONObject?): JSONObject {
        ensureReady()
        if (syncState.busy || writeBusy) throw LocalApiError(409, "已有写操作进行中，请稍候")
        val commit = body?.optString("commit") ?: ""
        if (!Regex("^[0-9a-fA-F]{7,40}$").matches(commit)) throw LocalApiError(400, "commit 无效")
        val ja = body?.optJSONArray("paths")
        val rels: List<String> = ja?.let { (0 until it.length()).map { i -> assertRepoPath(it.optString(i)).first } } ?: emptyList()
        if (rels.isEmpty() || rels.size > 200) throw LocalApiError(400, "paths 须为 1~200 个路径")
        return enqueueWrite {
            git().use { g ->
                if (g.repository.resolve(commit) == null) throw LocalApiError(400, "commit 无效")
                val cmd = g.checkout().setStartPoint(commit)
                rels.forEach { cmd.addPath(it) }
                try {
                    cmd.call()
                } catch (e: Exception) {
                    throw LocalApiError(400, "恢复失败（该提交中可能不存在这些文件）：" + rootMessage(e))
                }
                pyCache.clear()
                JSONObject()
                    .put("restored", JSONArray(rels)).put("commit", commit)
                    .put("note", "已恢复到工作区并暂存，尚未提交；确认无误后用 git_commit 提交")
            }
        }
    }

    fun assertPostPath(p: String) {
        if (!Regex("^micro/\\d{4}/\\d{2}/[A-Za-z0-9._-]+\\.md$").matches(p)) {
            throw LocalApiError(400, "非法的笔记路径")
        }
        if (!File(repoDir, p).canonicalPath.startsWith(File(repoDir, "micro").canonicalPath + File.separator)) {
            throw LocalApiError(400, "非法的笔记路径")
        }
    }

    fun isAuthError(msg: String): Boolean =
        Regex("(?i)auth fail|auth cancel|publickey|permission denied").containsMatchIn(msg)

    private fun rootMessage(e: Exception): String {
        var c: Throwable? = e
        while (c?.cause != null && c.cause !== c) c = c.cause
        return c?.message ?: (e.toString())
    }
}

/** 带 HTTP 状态码的业务异常（LocalServer 转换为响应码；conflict/needPubKey 附随 JSON） */
class LocalApiError(val status: Int, message: String) : Exception(message) {
    var conflict: List<String>? = null
    var needPubKey: Boolean = false

    constructor(status: Int, message: String, conflict: List<String>?) : this(status, message) {
        this.conflict = conflict
    }
}
