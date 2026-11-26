package com.codeplant.portal.notification

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import com.codeplant.portal.MainActivity

object NativeNotifier {
    const val CHANNEL_SERVICE = "portal_service"
    const val CHANNEL_REMINDER = "portal_reminder"
    const val CHANNEL_CONFIRM = "portal_confirm"

    fun ensureChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_SERVICE, "Portal 常驻服务", NotificationManager.IMPORTANCE_LOW),
        )
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_REMINDER, "每日计划督促", NotificationManager.IMPORTANCE_HIGH),
        )
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_CONFIRM, "高敏操作确认", NotificationManager.IMPORTANCE_HIGH),
        )
    }

    fun showReminder(context: Context, id: Int, title: String, body: String) {
        ensureChannels(context)
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val openIntent = PendingIntent.getActivity(
            context,
            id,
            Intent(context, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notif = NotificationCompat.Builder(context, CHANNEL_REMINDER)
            .setSmallIcon(android.R.drawable.ic_popup_reminder)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(openIntent)
            .build()
        nm.notify(id, notif)
    }

    fun showConfirmPrompt(context: Context, notifId: Int, confirmId: String, title: String, body: String) {
        ensureChannels(context)
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        val allowIntent = Intent(context, ConfirmActionReceiver::class.java).apply {
            action = ConfirmActionReceiver.ACTION_CONFIRM
            putExtra("confirmId", confirmId)
            putExtra("allow", true)
            putExtra("notifId", notifId)
        }
        val denyIntent = Intent(context, ConfirmActionReceiver::class.java).apply {
            action = ConfirmActionReceiver.ACTION_CONFIRM
            putExtra("confirmId", confirmId)
            putExtra("allow", false)
            putExtra("notifId", notifId)
        }

        val allowPi = PendingIntent.getBroadcast(
            context,
            notifId * 2,
            allowIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val denyPi = PendingIntent.getBroadcast(
            context,
            notifId * 2 + 1,
            denyIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val notif = NotificationCompat.Builder(context, CHANNEL_CONFIRM)
            .setSmallIcon(android.R.drawable.ic_dialog_alert)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .addAction(0, "允许执行", allowPi)
            .addAction(0, "拒绝", denyPi)
            .build()
        nm.notify(notifId, notif)
    }
}
