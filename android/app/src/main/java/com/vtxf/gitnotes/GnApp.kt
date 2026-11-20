package com.vtxf.gitnotes

import android.app.Application

class GnApp : Application() {

    lateinit var server: LocalServer
        private set

    override fun onCreate() {
        super.onCreate()
        server = LocalServer(this)
        server.start()
        // 启动 15s 后后台静默检测新版本，有新版自动下载到 ready（不拉安装器，等用户点击）
        server.scheduleAutoUpdate(15 * 1000L)
    }
}
