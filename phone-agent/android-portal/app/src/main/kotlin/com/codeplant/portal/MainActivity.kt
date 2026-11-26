package com.codeplant.portal

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.codeplant.portal.accessibility.PortalAccessibilityService
import com.codeplant.portal.notification.PortalNotificationListener
import com.codeplant.portal.service.PortalForegroundService
import com.codeplant.portal.shell.ShizukuBridge

class MainActivity : AppCompatActivity() {

    private lateinit var statusView: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        ShizukuBridge.init(this)
        PortalForegroundService.start(this)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(42, 36, 42, 36)
        }

        val title = TextView(this).apply {
            text = "CodePlant Portal (MI14 执行壳 · M0)"
            textSize = 20f
        }
        statusView = TextView(this).apply {
            textSize = 14f
            setPadding(0, 20, 0, 28)
        }

        root.addView(title)
        root.addView(statusView)
        root.addView(actionButton("1. 请求通知权限 (督促提醒必须)") { requestPostNotifications() })
        root.addView(actionButton("2. 打开应用详情页 (解锁「允许受限设置」)") { openAppDetails() })
        root.addView(actionButton("3. 开启无障碍服务 (MI14 主控制通道)") {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        })
        root.addView(actionButton("4. 开启通知使用权 (监听微信消息)") {
            startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        })
        root.addView(actionButton("5. 授权 Shizuku (静默截屏增强)") {
            ShizukuBridge.requestPermission()
            refreshStatus()
        })
        root.addView(actionButton("6. 申请忽略电池优化 (HyperOS 防杀后台)") { requestIgnoreBattery() })
        root.addView(actionButton("刷新状态") { refreshStatus() })

        val scroll = ScrollView(this).apply { addView(root) }
        setContentView(scroll)
        refreshStatus()
    }

    override fun onResume() {
        super.onResume()
        ShizukuBridge.refresh()
        refreshStatus()
    }

    private fun actionButton(label: String, onClick: () -> Unit): Button {
        return Button(this).apply {
            text = label
            setOnClickListener { onClick() }
        }
    }

    private fun openAppDetails() {
        startActivity(
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                data = Uri.parse("package:$packageName")
            },
        )
    }

    private fun requestPostNotifications() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
            ) {
                ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 2001)
            }
        }
    }

    private fun requestIgnoreBattery() {
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        if (!pm.isIgnoringBatteryOptimizations(packageName)) {
            startActivity(
                Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                    data = Uri.parse("package:$packageName")
                },
            )
        }
    }

    private fun refreshStatus() {
        val shizuku = ShizukuBridge.state.value
        val a11yOk = PortalAccessibilityService.isConnected()
        val notifOk = PortalNotificationListener.isConnected
        val fgsOk = PortalForegroundService.isRunning
        statusView.text = buildString {
            appendLine("• 本地 HTTP 端口: 127.0.0.1:${PortalForegroundService.PORTAL_PORT} (${if (fgsOk) "运行中" else "未启动"})")
            appendLine("• Bearer Token: ${PortalForegroundService.PORTAL_TOKEN}")
            appendLine("• 无障碍控制通道 (主控): ${if (a11yOk) "✅ 已连接" else "❌ 未开启"}")
            appendLine("• 通知栏监听 (微信事件): ${if (notifOk) "✅ 已连接" else "❌ 未开启"}")
            appendLine("• Shizuku (静默截屏增强): ${if (shizuku.isReady) "✅ 就绪 (UID ${shizuku.uid})" else if (shizuku.binderAlive) "⚠️ 未授权/未绑定" else "⏳ 未启动 (纯无障碍仍可用)"}")
            appendLine("• Termux Web 控制台: http://127.0.0.1:8787")
        }
    }
}
