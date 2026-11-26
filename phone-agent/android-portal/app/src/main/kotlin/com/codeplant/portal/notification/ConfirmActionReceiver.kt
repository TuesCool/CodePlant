package com.codeplant.portal.notification

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class ConfirmActionReceiver : BroadcastReceiver() {
    private val client = OkHttpClient.Builder()
        .connectTimeout(2, TimeUnit.SECONDS)
        .readTimeout(3, TimeUnit.SECONDS)
        .build()

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_CONFIRM) return
        val confirmId = intent.getStringExtra("confirmId") ?: return
        val allow = intent.getBooleanExtra("allow", false)
        val notifId = intent.getIntExtra("notifId", -1)

        if (notifId >= 0) {
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.cancel(notifId)
        }

        val pending = goAsync()
        executor.execute {
            try {
                val body = JSONObject().apply {
                    put("confirmId", confirmId)
                    put("allow", allow)
                }.toString()
                val req = Request.Builder()
                    .url(piConfirmWebhookUrl)
                    .post(body.toRequestBody("application/json".toMediaType()))
                    .build()
                runCatching { client.newCall(req).execute().close() }
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        const val ACTION_CONFIRM = "com.codeplant.portal.ACTION_CONFIRM"

        @Volatile
        var piConfirmWebhookUrl: String = "http://127.0.0.1:8787/webhook/confirm"

        private val executor = Executors.newSingleThreadExecutor()
    }
}
