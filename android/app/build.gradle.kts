import java.io.File
import java.security.MessageDigest
import java.util.Properties
import java.time.LocalDate
import com.android.build.api.variant.impl.VariantOutputImpl

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// 版本号跟随 web/package.json，避免双端漂移（Android 端不修改前端，构建时同步 assets）
val webVersion = Regex("\"version\"\\s*:\\s*\"([^\"]+)\"")
    .find(rootProject.file("../web/package.json").readText())?.groupValues?.get(1) ?: "0.0.0"

android {
    namespace = "com.vtxf.gitnotes"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.vtxf.gitnotes"
        minSdk = 26
        targetSdk = 35
        // 日期型 versionCode：同日多次构建同值可覆盖安装，跨日自然递增
        versionCode = LocalDate.now().let { it.year * 10000 + it.monthValue * 100 + it.dayOfMonth }
        versionName = webVersion
    }

    // 签名凭证在 local.properties（不入 git，仓库公开不含密码）；缺失直接报错中止
    val localProps = Properties()
    run {
        val f = rootProject.file("local.properties")
        if (f.exists()) f.inputStream().use { localProps.load(it) }
    }
    fun gnProp(name: String): String =
        localProps.getProperty(name)
            ?: (if (hasProperty(name)) property(name) as String else throw GradleException("缺少 $name（android/local.properties）"))

    signingConfigs {
        create("release") {
            storeFile = rootProject.file("keystore.jks")
            storePassword = gnProp("GN_KEYSTORE_PASSWORD")
            keyAlias = gnProp("GN_KEY_ALIAS")
            keyPassword = gnProp("GN_KEYSTORE_PASSWORD")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    // 单一源：构建时把 ../web/index.html 同步进 assets（Android 端零前端分叉）
    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/indexAssets"))

    // JGit/bcprov/jsch 的多版本 jar 都带 OSGI 清单，通配去重
    packaging {
        resources {
            excludes += setOf(
                "META-INF/versions/*/OSGI-INF/MANIFEST.MF",
                "META-INF/DEPENDENCIES",
                "META-INF/LICENSE.md",
                "META-INF/LICENSE-notice.md",
            )
        }
    }
}

// 前端源码已拆分：index.html + assets/（css）+ js/ 整体同步进 assets（保持相对路径，前端零分叉）
val syncIndexHtml = tasks.register<Copy>("syncIndexHtml") {
    from(rootProject.file("../web/index.html"))
    from(rootProject.file("../web/help.html"))
    from(rootProject.file("../web/assets")) { into("assets") }
    from(rootProject.file("../web/js")) { into("js") }
    into(layout.buildDirectory.dir("generated/indexAssets"))
    // 前端源文件未变时 Copy 会 UP-TO-DATE 跳过 doLast，version.json 就停留在旧 commit——本任务必须每次真跑
    outputs.upToDateWhen { false }
    // 构建溯源（AGENTS.md 规则：先提交再打包）：注入最新 commit+时间到 assets/version.json，
    // 设置页「本地仓库」区块读取展示；放 doLast 避免被源目录拷贝覆盖。git 不可得则写空并在构建日志告警。
    doLast {
        fun gitLog(fmt: String): String = try {
            val p = ProcessBuilder("git", "log", "-1", "--format=$fmt")
                .directory(rootProject.file(".."))
                .redirectErrorStream(true)
                .start()
            val ok = p.waitFor() == 0
            (if (ok) p.inputStream.readBytes().decodeToString().trim() else "")
        } catch (_: Exception) { "" }
        val commit = gitLog("%h")
        val v = mapOf(
            "commit" to commit,
            "time" to gitLog("%cI"),
            "subject" to gitLog("%s"),
        )
        if (commit.isEmpty()) logger.warn("[syncIndexHtml] version 注入失败：请先 git 提交再打包（AGENTS.md 打包规则）")
        fun jsonStr(s: String) = "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n") + "\""
        val out = layout.buildDirectory.file("generated/indexAssets/assets/version.json").get().asFile
        out.parentFile.mkdirs()
        out.writeText(v.entries.joinToString(",", "{", "}") { (k, value) -> jsonStr(k) + ":" + jsonStr(value) })
    }
}
tasks.named("preBuild") { dependsOn(syncIndexHtml) }

// 交付自动化：assembleRelease 完成后自动拷贝 APK 到 ../dist/（交付出口），并打印包内
// version.json 的 commit 供核验——杜绝"只构建未交付"（曾两次发生：构建产物留在
// build/outputs，人工忘记拷 dist，装到旧包）。任务名 deliverApk，随 assembleRelease 自动执行。
val deliverApk = tasks.register("deliverApk") {
    dependsOn("assembleRelease")
    doLast {
        val src = layout.buildDirectory.file("outputs/apk/release").get().asFile
            .walkTopDown().firstOrNull { it.name.matches(Regex("""git-notes-v[\d.]+\.apk""")) }
            ?: throw GradleException("deliverApk: 未找到 release APK")
        val dstDir = rootProject.file("../dist").apply { mkdirs() }
        val dst = File(dstDir, src.name)
        src.copyTo(dst, overwrite = true)
        val digest = MessageDigest.getInstance("MD5")
            .digest(dst.readBytes()).joinToString("") { "%02x".format(it) }
        logger.lifecycle("[deliverApk] ${src.name} -> ${dst.absolutePath}")
        logger.lifecycle("[deliverApk] md5=$digest  size=${dst.length()}")
        logger.lifecycle("[deliverApk] 交付完成：请以 dist/ 下该文件为准安装")
    }
}
tasks.matching { it.name == "assembleRelease" }.configureEach {
    finalizedBy(deliverApk)
}
tasks.named("preBuild") { dependsOn(syncIndexHtml) }

// 产物名统一 git-notes-v<版本>.apk（交付拷 dist/ 时不再人工改名）
androidComponents {
    onVariants { variant ->
        variant.outputs.forEach { output ->
            (output as? VariantOutputImpl)?.outputFileName?.set("git-notes-v${output.versionName.get()}.apk")
        }
    }
}

dependencies {
    // 本地 git 仓库架构：JGit 6.10（Java 11 基线，对 Android D8 兼容最稳）+ JSch 传输
    // （ssh.jsch 构件为 JGit 官方 JSch 集成；com.jcraft:jsch 换成维护中的 mwiede fork，
    //   包名同为 com.jcraft.jsch，ed25519 密钥生成/验签走 BC——pom 无任何依赖节，
    //   bcprov 必须显式引入，否则运行时 NoClassDefFoundError: Ed25519PrivateKeyParameters）
    implementation("org.eclipse.jgit:org.eclipse.jgit:6.10.1.202505221210-r")
    implementation("org.eclipse.jgit:org.eclipse.jgit.ssh.jsch:6.10.1.202505221210-r") {
        exclude(group = "com.jcraft", module = "jsch")
    }
    implementation("com.github.mwiede:jsch:2.28.8")
    implementation("org.bouncycastle:bcprov-jdk18on:1.78.1")
    implementation("org.slf4j:slf4j-nop:1.7.36")
}
