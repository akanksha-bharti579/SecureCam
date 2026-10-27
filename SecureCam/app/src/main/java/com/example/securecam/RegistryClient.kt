package com.example.securecam

import android.content.Context
import androidx.annotation.WorkerThread
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * Uploads signed capture records to the SecureCam registry so photos can still be verified
 * after a platform re-encodes them. Records are queued on disk first, so capturing works
 * offline and uploads resume on the next flush.
 */
class RegistryClient(context: Context) {
    private val prefs = context.getSharedPreferences("securecam", Context.MODE_PRIVATE)
    private val pendingDir = File(context.filesDir, "registry_pending").apply { mkdirs() }
    private val rejectedDir = File(context.filesDir, "registry_rejected").apply { mkdirs() }

    var serverUrl: String
        get() = prefs.getString("registry_url", "") ?: ""
        set(v) = prefs.edit().putString("registry_url", v.trim().trimEnd('/')).apply()

    data class FlushResult(val sent: Int, val rejected: Int, val pending: Int, val message: String?)

    fun enqueue(payloadJson: String) {
        File(pendingDir, "${System.currentTimeMillis()}_${System.nanoTime() % 100000}.json").writeText(payloadJson)
    }

    fun pendingCount() = pendingDir.listFiles()?.size ?: 0

    @WorkerThread
    @Synchronized
    fun flush(): FlushResult {
        val base = serverUrl
        if (base.isEmpty()) return FlushResult(0, 0, pendingCount(), "no registry server set (tap SERVER)")
        var sent = 0
        var rejected = 0
        var message: String? = null
        for (f in pendingDir.listFiles()?.sortedBy { it.name } ?: emptyList()) {
            try {
                val (code, body) = post("$base/api/records", f.readText())
                when {
                    code in 200..299 -> { f.delete(); sent++ }
                    code in 400..499 && code != 429 -> {
                        f.renameTo(File(rejectedDir, f.name)); rejected++
                        message = "rejected: " + describeError(body)
                    }
                    else -> { message = "server error HTTP $code"; break }
                }
            } catch (e: IOException) {
                message = "offline (${e.javaClass.simpleName}); will retry"
                break
            }
        }
        return FlushResult(sent, rejected, pendingCount(), message)
    }

    private fun describeError(body: String): String = try {
        val o = JSONObject(body)
        val reasons = o.optJSONArray("reasons")
        if (reasons != null && reasons.length() > 0) (0 until reasons.length()).joinToString("; ") { reasons.getString(it) }
        else o.optString("error", body)
    } catch (e: Exception) {
        body.take(200)
    }

    private fun post(url: String, json: String): Pair<Int, String> {
        val c = URL(url).openConnection() as HttpURLConnection
        try {
            c.connectTimeout = 4000
            c.readTimeout = 10000
            c.requestMethod = "POST"
            c.doOutput = true
            c.setRequestProperty("Content-Type", "application/json")
            c.outputStream.use { it.write(json.toByteArray(Charsets.UTF_8)) }
            val code = c.responseCode
            val stream = if (code >= 400) c.errorStream else c.inputStream
            return code to (stream?.bufferedReader()?.use { it.readText() } ?: "")
        } finally {
            c.disconnect()
        }
    }
}
