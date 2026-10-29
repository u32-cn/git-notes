package com.vtxf.gitnotes

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import java.io.File

/**
 * 零依赖版 FileProvider：只读暴露 cacheDir/update/ 下的 APK，供系统安装器读取。
 * 不用 androidx.core 的 FileProvider（项目纯 framework API，无 androidx 依赖）。
 * 仅支持 path 段 "update/<文件名>"，文件必须已存在于 cacheDir/update/，防目录穿越。
 */
class ApkProvider : ContentProvider() {

    override fun onCreate(): Boolean = true

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor? {
        if (mode != "r") throw SecurityException("只读")
        val name = uri.lastPathSegment ?: throw IllegalArgumentException("缺文件名")
        if (!name.matches(Regex("[A-Za-z0-9._-]+"))) throw IllegalArgumentException("非法文件名")
        val f = File(File(context!!.cacheDir, "update"), name)
        if (!f.isFile) throw IllegalArgumentException("文件不存在")
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY)
    }

    override fun getType(uri: Uri): String = "application/vnd.android.package-archive"

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0
}
