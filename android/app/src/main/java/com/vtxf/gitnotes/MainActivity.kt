package com.vtxf.gitnotes

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Message
import android.provider.MediaStore
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast

/**
 * WebView 壳：加载内嵌本地服务（LocalServer）提供的 web/index.html。
 * 关键点：
 * - domStorageEnabled：前端可能用 localStorage（按 origin 隔离，端口固定 8644）
 * - onShowFileChooser：「📷 图片」按钮走 input type=file，不实现则发图功能失效
 */
class MainActivity : Activity() {

    companion object {
        private const val REQ_FILE_CHOOSER = 1001
    }

    private lateinit var web: WebView
    private lateinit var errorRoot: LinearLayout
    private lateinit var errorTitle: TextView
    private lateinit var errorHint: TextView
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
    private var mainFrameError = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val bg = getColor(R.color.app_bg)
        val root = FrameLayout(this)

        web = WebView(this)
        web.layoutParams = FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT
        )
        web.setBackgroundColor(bg)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            useWideViewPort = true
            loadWithOverviewMode = true
            // help.html 经 window.open 打开：必须开多窗口支持 onCreateWindow 才会回调
            setSupportMultipleWindows(true)
        }
        web.webViewClient = object : WebViewClient() {
            // 引导页平台直达链接（Gitee/GitHub/Codeup 等）：非本机服务的外链一律交系统浏览器
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (url.host != "127.0.0.1") {
                    try {
                        startActivity(Intent(Intent.ACTION_VIEW, url))
                    } catch (e: Exception) {
                        Toast.makeText(this@MainActivity, "未找到可打开链接的应用", Toast.LENGTH_SHORT).show()
                    }
                    return true
                }
                return false
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) {
                    mainFrameError = true
                    showError(
                        "页面加载失败",
                        "${error.description}\n请点击「重试」"
                    )
                }
            }

            override fun onPageFinished(view: WebView, url: String) {
                if (!mainFrameError) hideError()
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            // 帮助文档 help.html 经 window.open 请求新窗：安卓单窗口形态，改为在当前
            // WebView 直接导航（临时 WebView 接住 url 再转交主 WebView），返回键可回到主界面
            override fun onCreateWindow(
                view: WebView,
                isDialog: Boolean,
                isUserGesture: Boolean,
                resultMsg: Message,
            ): Boolean {
                val temp = WebView(view.context)
                temp.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
                        web.loadUrl(request.url.toString())
                        return true
                    }
                }
                (resultMsg.obj as WebView.WebViewTransport).webView = temp
                resultMsg.sendToTarget()
                return true
            }

            override fun onShowFileChooser(
                webView: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams,
            ): Boolean {
                fileChooserCallback?.onReceiveValue(null)
                fileChooserCallback = callback
                return try {
                    startActivityForResult(buildPickerIntent(params), REQ_FILE_CHOOSER)
                    true
                } catch (e: android.content.ActivityNotFoundException) {
                    fileChooserCallback = null
                    Toast.makeText(this@MainActivity, "未找到可用的图片选择器", Toast.LENGTH_SHORT).show()
                    false
                }
            }
        }
        root.addView(web)

        buildErrorView(bg)
        root.addView(errorRoot)
        setContentView(root)

        // Android 15 (targetSdk 35) 强制 edge-to-edge：把 systemBars/displayCutout inset 转成根布局
        // padding，避免 WebView 顶栏被状态栏遮住；旧系统上 insets 为 0，无影响。
        // ime inset 必须一并转为底 padding：targetSdk 35 下 manifest 的 adjustResize 已失效，
        // 不消费 ime 的话键盘弹出时 WebView 不收缩，dock 输入框（发布器/AI 输入）会被键盘盖住。
        // WindowInsets.Type 是 API 30 才有的 API，29 及以下走弃用字段分支。
        root.setOnApplyWindowInsetsListener { v, insets ->
            val l: Int
            val t: Int
            val r: Int
            val b: Int
            val ret: WindowInsets
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                val bars = insets.getInsets(
                    WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout()
                )
                val ime = insets.getInsets(WindowInsets.Type.ime())
                l = bars.left; t = bars.top; r = bars.right
                b = maxOf(bars.bottom, ime.bottom)
                ret = WindowInsets.CONSUMED
            } else {
                @Suppress("DEPRECATION")
                l = insets.systemWindowInsetLeft
                @Suppress("DEPRECATION")
                t = insets.systemWindowInsetTop
                @Suppress("DEPRECATION")
                r = insets.systemWindowInsetRight
                @Suppress("DEPRECATION")
                b = insets.systemWindowInsetBottom   // 旧 API 的 systemWindowInset 本就含键盘高度
                ret = insets.consumeSystemWindowInsets()
            }
            v.setPadding(l, t, r, b)
            ret
        }

        loadServer()
    }

    private fun loadServer() {
        val app = application as GnApp
        if (!app.server.started) {
            showError(
                "本地服务启动失败",
                "端口 ${LocalServer.PORT} 可能被其他应用占用。\n请重启手机后再打开，或在设置中关闭占用该端口的应用。"
            )
            return
        }
        mainFrameError = false
        hideError()
        web.loadUrl("http://127.0.0.1:${LocalServer.PORT}/")
    }

    /** 原生错误兜底屏（编程式构建，无 layout XML） */
    private fun buildErrorView(bg: Int) {
        errorRoot = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(bg)
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT
            )
            visibility = View.GONE
            isClickable = true // 挡住下层 WebView 的点击
        }
        errorTitle = TextView(this).apply {
            textSize = 17f
            setTextColor(getColor(R.color.app_text))
            gravity = Gravity.CENTER
        }
        errorHint = TextView(this).apply {
            textSize = 14f
            setTextColor(getColor(R.color.app_text))
            gravity = Gravity.CENTER
            setPadding(0, 24, 0, 0)
        }
        val retry = Button(this).apply {
            text = "重试"
            setOnClickListener { loadServer() }
        }
        errorRoot.addView(errorTitle, linearParams())
        errorRoot.addView(errorHint, linearParams())
        errorRoot.addView(retry, linearParams().apply { topMargin = 48 })
    }

    private fun linearParams() = LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT
    ).apply { gravity = Gravity.CENTER_HORIZONTAL }

    private fun showError(title: String, hint: String) {
        errorTitle.text = title
        errorHint.text = hint
        errorRoot.visibility = View.VISIBLE
    }

    private fun hideError() {
        errorRoot.visibility = View.GONE
    }

    // ---------- 文件选择器（发图主路径） ----------

    // 前端「📷 图片」按钮走 input accept=image/*，「📎 附件」按钮 input 不限类型（acceptTypes 为空）。
    // 图片不用 FileChooserParams.createIntent()（ACTION_GET_CONTENT）：HyperOS 的
    // 「安全访问」选择器响应 GET_CONTENT，确认后不回传 Uri，WebView 只收到
    // cancel——用户视角是「选完图点确认毫无反馈」。改用系统照片选择器
    // （API 33+ 的 ACTION_PICK_IMAGES，老系统 ACTION_PICK），确认后稳定回传。
    // 附件走 ACTION_OPEN_DOCUMENT（SAF 文档契约，回传 Uri 稳定；GET_CONTENT 在 HyperOS 上同样不可靠）。
    private fun buildPickerIntent(params: WebChromeClient.FileChooserParams): Intent {
        val multiple = params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE
        val imageOnly = params.acceptTypes.isEmpty() || params.acceptTypes.all { it.contains("image/") || it.isEmpty() }
        val hasImage = params.acceptTypes.any { it.contains("image/") }
        if (imageOnly && hasImage) {
            if (android.os.Build.VERSION.SDK_INT >= 33) {
                val intent = Intent(MediaStore.ACTION_PICK_IMAGES).setType("image/*")
                if (multiple) intent.putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, MediaStore.getPickImagesMaxLimit())
                return intent
            }
            val pick = Intent(Intent.ACTION_PICK, MediaStore.Images.Media.EXTERNAL_CONTENT_URI)
            if (multiple) pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            return pick
        }
        val doc = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            type = "*/*"
            addCategory(Intent.CATEGORY_OPENABLE)
            if (multiple) putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        }
        return doc
    }

    // FileChooserParams.parseResult 只认单选 getData()：多选时数据在 clipData，
    // parseResult 会返回 [null]，WebView 同样静默取消，故自实现解析。
    private fun parseChooserResult(resultCode: Int, data: Intent?): Array<Uri>? {
        if (resultCode != Activity.RESULT_OK || data == null) return null
        val clip = data.clipData
        if (clip != null && clip.itemCount > 0) {
            return Array(clip.itemCount) { clip.getItemAt(it).uri }
        }
        return data.data?.let { arrayOf(it) }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == REQ_FILE_CHOOSER) {
            fileChooserCallback?.onReceiveValue(parseChooserResult(resultCode, data))
            fileChooserCallback = null
        } else {
            super.onActivityResult(requestCode, resultCode, data)
        }
    }

    // ---------- 返回键：AI 页时优先返回信息流（aiBack 由 80-ai.js 暴露，返回是否消费），其次 WebView 后退 ----------

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        // evaluateJavascript 回调也在主线程，不能阻塞等待——在回调里做未处理兜底
        web.evaluateJavascript(
            "(function(){ if (typeof aiBack==='function' && aiBack() === true) { return '1'; } return '0'; })()"
        ) { v ->
            if (v != "\"1\"") fallbackBack()
        }
    }

    private fun fallbackBack() {
        if (web.canGoBack()) web.goBack() else super.onBackPressed()
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }
}
