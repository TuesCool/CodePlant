package com.codeplant.portal.notification

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

data class CapturedNotification(
    val packageName: String,
    val title: String,
    val text: String,
    val postTimeMs: Long,
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("packageName", packageName)
        put("title", title)
        put("text", text)
        put("postTimeMs", postTimeMs)
    }
}

class PortalNotificationListener : NotificationListenerService() {

    private val client = OkHttpClient.Builder()
        .connectTimeout(2, TimeUnit.SECONDS)
        .readTimeout(3, TimeUnit.SECONDS)
        .build()
    private val executor = Executors.newSingleThreadExecutor()

    override fun onListenerConnected() {
        super.onListenerConnected()
        instance = this
        isConnected = true
    }

    override fun onListenerDisconnected() {
        if (instance === this) instance = null
        isConnected = false
        super.onListenerDisconnected()
    }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        if (sbn == null || sbn.packageName == packageName) return
        val extras = sbn.notification?.extras ?: return
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.trim().orEmpty()
        val text = (
            extras.getCharSequence(Notification.EXTRA_BIG_TEXT)
                ?: extras.getCharSequence(Notification.EXTRA_TEXT)
            )?.toString()?.trim().orEmpty()
        if (title.isEmpty() && text.isEmpty()) return

        val item = CapturedNotification(
            packageName = sbn.packageName.orEmpty(),
            title = title.take(100),
            text = text.take(300),
            postTimeMs = sbn.postTime,
        )
        recentBuffer.add(0, item)
        while (recentBuffer.size > 50) {
            recentBuffer.removeAt(recentBuffer.size - 1)
        }

        // Push to local Termux pi-server webhook
        executor.execute {
            runCatching {
                val req = Request.Builder()
                    .url(piWebhookUrl)
                    .post(item.toJson().toString().toRequestBody("application/json".toMediaType()))
                    .build()
                client.newCall(req).execute().close()
            }
        }
    }

    companion object {
        @Volatile
        var instance: PortalNotificationListener? = null
            private set

        @Volatile
        var isConnected: Boolean = false
            private set

        @Volatile
        var piWebhookUrl: String = "http://127.0.0.1:8787/webhook/notification"

        private val recentBuffer = CopyOnWriteArrayList<CapturedNotification>()

        fun snapshot(packageFilter: String = ""): List<CapturedNotification> {
            return recentBuffer.filter {
                packageFilter.isBlank() || it.packageName == packageFilter
            }
        }
    }
}
