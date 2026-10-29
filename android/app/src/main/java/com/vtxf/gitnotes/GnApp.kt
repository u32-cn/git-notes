package com.vtxf.gitnotes

import android.app.Application

class GnApp : Application() {

    lateinit var server: LocalServer
        private set

    override fun onCreate() {
        super.onCreate()
        server = LocalServer(this)
        server.start()
    }
}
