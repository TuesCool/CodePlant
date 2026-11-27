package com.codeplant.portal.service

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.os.Build
import android.os.IBinder
import android.util.Base64
import androidx.core.app.NotificationCompat
import com.codeplant.portal.MainActivity
import com.codeplant.portal.accessibility.PortalAccessibilityService
import com.codeplant.portal.accessibility.PrunedUiNode
import com.codeplant.portal.notification.NativeNotifier
import com.codeplant.portal.notification.PortalNotificationListener
import com.codeplant.portal.shell.ShizukuBridge
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.nio.charset.StandardCharsets

class PortalForegroundService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var serverSocket: ServerSocket? = null

    override fun onCreate() {
        super.onCreate()
        isRunning = true
        ShizukuBridge.init(this)
        startForegroundNotification()
        startHttpServer()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        return START_STICKY
    }

    override fun onDestroy() {
        isRunning = false
        runCatching { serverSocket?.close() }
        scope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun startForegroundNotification() {
        NativeNotifier.ensureChannels(this)
        val openIntent = android.app.PendingIntent.getActivity(
            this,
            101,
            Intent(this, MainActivity::class.java),
            android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE,
        )
        val notif = NotificationCompat.Builder(this, NativeNotifier.CHANNEL_SERVICE)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("CodePlant Portal 运行中")
            .setContentText("本地端口 127.0.0.1:$PORTAL_PORT 等待 Termux Pi Agent 连接")
            .setContentIntent(openIntent)
            .setOngoing(true)
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(101, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(101, notif)
        }
    }

    private fun startHttpServer() {
        scope.launch {
            val server = ServerSocket(PORTAL_PORT, 32, InetAddress.getByName("127.0.0.1"))
            serverSocket = server
            while (!server.isClosed) {
                val client = runCatching { server.accept() }.getOrNull() ?: break
                launch { handleClient(client) }
            }
        }
    }

    private fun handleClient(socket: Socket) {
        socket.use { sock ->
            val input = BufferedInputStream(sock.getInputStream())
            val reqLine = readAsciiLine(input) ?: return
            val parts = reqLine.split(" ")
            if (parts.size < 2) return
            val method = parts[0].uppercase()
            val fullTarget = parts[1]
            val path = fullTarget.substringBefore("?")
            val query = parseQuery(fullTarget.substringAfter("?", ""))

            val headers = mutableMapOf<String, String>()
            while (true) {
                val line = readAsciiLine(input) ?: break
                if (line.isEmpty()) break
                val colon = line.indexOf(':')
                if (colon > 0) {
                    headers[line.substring(0, colon).trim().lowercase()] = line.substring(colon + 1).trim()
                }
            }

            val expectedAuth = "Bearer $PORTAL_TOKEN"
            if (headers["authorization"] != expectedAuth) {
                writeJson(sock, 401, JSONObject().put("error", "Unauthorized"))
                return
            }

            val contentLength = headers["content-length"]?.toIntOrNull()?.coerceIn(0, 1_048_576) ?: 0
            val bodyBytes = ByteArray(contentLength)
            var read = 0
            while (read < contentLength) {
                val n = input.read(bodyBytes, read, contentLength - read)
                if (n < 0) break
                read += n
            }
            val bodyStr = String(bodyBytes, 0, read, StandardCharsets.UTF_8)

            val (statusCode, json) = runCatching {
                routeRequest(method, path, query, bodyStr)
            }.getOrElse { err ->
                500 to JSONObject().put("error", err.message ?: "Internal error")
            }
            writeJson(sock, statusCode, json)
        }
    }

    private fun routeRequest(
        method: String,
        path: String,
        query: Map<String, String>,
        bodyStr: String,
    ): Pair<Int, JSONObject> {
        val dm = resources.displayMetrics
        val width = dm.widthPixels.coerceAtLeast(1)
        val height = dm.heightPixels.coerceAtLeast(1)
        val a11y = PortalAccessibilityService.instance

        if (method == "GET" && path == "/health") {
            val shizuku = ShizukuBridge.state.value
            return 200 to JSONObject().apply {
                put("accessibilityConnected", a11y != null)
                put("shizukuReady", shizuku.isReady)
                put("shizukuUid", shizuku.uid)
                put("notificationListenerConnected", PortalNotificationListener.isConnected)
                put("foregroundPackage", a11y?.currentPackageName().orEmpty())
                put("screenWidth", width)
                put("screenHeight", height)
            }
        }

        if (method == "GET" && path == "/apps") {
            val launchIntent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
            val resolved = packageManager.queryIntentActivities(launchIntent, 0)
            val arr = JSONArray()
            val seen = HashSet<String>()
            for (info in resolved) {
                val pkg = info.activityInfo?.packageName ?: continue
                if (!seen.add(pkg)) continue
                val label = info.loadLabel(packageManager)?.toString()?.trim().orEmpty()
                arr.put(JSONObject().put("label", label).put("packageName", pkg))
            }
            return 200 to JSONObject().put("apps", arr)
        }

        if (method == "GET" && path == "/screen") {
            val includeImage = query["includeImage"] == "1"
            val annotate = query["annotate"] != "0"
            val (nodes, formatted) = a11y?.capturePrunedTree(width, height)
                ?: (emptyList<PrunedUiNode>() to "(无障碍未连接)")

            var imageB64: String? = null
            if (includeImage) {
                val bmp = runBlocking {
                    a11y?.takeScreenshotBitmap() ?: ShizukuBridge.screencapBitmap()
                }
                if (bmp != null) {
                    val prepared = if (annotate && nodes.isNotEmpty()) drawSomBoxes(bmp, nodes) else bmp
                    imageB64 = bitmapToJpegBase64(prepared)
                    if (prepared !== bmp) prepared.recycle()
                    bmp.recycle()
                }
            }

            return 200 to JSONObject().apply {
                put("foregroundPackage", a11y?.currentPackageName().orEmpty())
                put("width", width)
                put("height", height)
                put("formattedTree", formatted)
                put("elements", JSONArray().apply { nodes.forEach { put(it.toJson()) } })
                if (imageB64 != null) {
                    put("imageBase64", imageB64)
                    put("imageMimeType", "image/jpeg")
                }
            }
        }

        if (method == "POST" && path == "/action") {
            val req = if (bodyStr.isBlank()) JSONObject() else JSONObject(bodyStr)
            val type = req.optString("type")
            if (type == "open_app") {
                var pkg = req.optString("packageName").trim()
                val appName = req.optString("appName").trim()
                if (pkg.isEmpty() && appName.isNotEmpty()) {
                    pkg = resolvePackageByName(appName).orEmpty()
                }
                if (pkg.isEmpty()) {
                    return 400 to JSONObject().put("ok", false).put("message", "未找到应用: ${appName.ifEmpty { pkg }}")
                }
                val intent = packageManager.getLaunchIntentForPackage(pkg)?.apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
                } ?: return 400 to JSONObject().put("ok", false).put("message", "未找到可启动包名: $pkg")
                return runCatching {
                    startActivity(intent)
                    200 to JSONObject().put("ok", true).put("message", "已尝试拉起应用 $pkg（若未跳转请检查 MI14「后台弹出界面」权限）")
                }.getOrElse { err ->
                    500 to JSONObject().put("ok", false).put("message", "拉起应用失败（请开启后台弹出界面权限）: ${err.message}")
                }
            }

            val service = a11y ?: return 503 to JSONObject()
                .put("ok", false)
                .put("message", "无障碍服务未连接，请在 MI14 设置中开启 CodePlant 手机控制服务")

            val (ok, msg) = when (type) {
                "tap" -> {
                    val x = req.optDouble("x").toFloat()
                    val y = req.optDouble("y").toFloat()
                    val done = runBlocking { service.tap(x, y, 60L) }
                    done to if (done) "已点击 ($x, $y)" else "手势点击被系统取消"
                }
                "tap_element" -> {
                    val idx = req.optInt("index", -1)
                    val node = service.findCachedNode(idx)
                    if (node == null) {
                        false to "未找到编号 [$idx] 的控件，请先重新读取屏幕控件树"
                    } else {
                        val cx = node.centerX().toFloat()
                        val cy = node.centerY().toFloat()
                        val done = runBlocking { service.tap(cx, cy, 60L) }
                        done to if (done) "已点击控件 [$idx] (${node.text.ifBlank { node.desc }}) @($cx,$cy)" else "控件 [$idx] 点击被取消"
                    }
                }
                "long_press" -> {
                    val x = req.optDouble("x").toFloat()
                    val y = req.optDouble("y").toFloat()
                    val dur = req.optLong("durationMs", 650L)
                    val done = runBlocking { service.tap(x, y, dur) }
                    done to if (done) "已长按 ($x, $y)" else "长按失败"
                }
                "swipe" -> {
                    val x1 = req.optDouble("x").toFloat()
                    val y1 = req.optDouble("y").toFloat()
                    val x2 = req.optDouble("x2").toFloat()
                    val y2 = req.optDouble("y2").toFloat()
                    val dur = req.optLong("durationMs", 320L)
                    val done = runBlocking { service.swipe(x1, y1, x2, y2, dur) }
                    done to if (done) "已滑动 ($x1,$y1)->($x2,$y2)" else "滑动失败"
                }
                "input" -> {
                    val text = req.optString("text")
                    val idx = req.optInt("index", -1)
                    val node = if (idx > 0) service.findCachedNode(idx) else null
                    val tx = when {
                        node != null -> node.centerX().toFloat()
                        req.has("x") -> req.optDouble("x").toFloat()
                        else -> null
                    }
                    val ty = when {
                        node != null -> node.centerY().toFloat()
                        req.has("y") -> req.optDouble("y").toFloat()
                        else -> null
                    }
                    val done = runBlocking { service.inputText(text, tx, ty) }
                    done to if (done) "已输入文本: ${text.take(24)}" else "未找到可输入焦点控件，请先点击输入框或传入元素编号 index"
                }
                "key" -> {
                    val key = req.optString("key")
                    val done = service.pressSystemKey(key)
                    done to if (done) "已触发系统按键 $key" else "不支持的按键: $key"
                }
                else -> false to "未知动作类型: $type"
            }
            return (if (ok) 200 else 500) to JSONObject().put("ok", ok).put("message", msg)
        }

        if (method == "POST" && path == "/notify") {
            val req = if (bodyStr.isBlank()) JSONObject() else JSONObject(bodyStr)
            val title = req.optString("title", "CodePlant 提醒")
            val body = req.optString("body", "")
            val level = req.optString("level", "reminder")
            val notifId = req.optString("id", "${System.currentTimeMillis()}").hashCode()
            if (level == "confirm") {
                val confirmId = req.optString("confirmId")
                NativeNotifier.showConfirmPrompt(this, notifId, confirmId, title, body)
            } else {
                NativeNotifier.showReminder(this, notifId, title, body)
            }
            return 200 to JSONObject().put("ok", true)
        }

        if (method == "GET" && path == "/notifications") {
            val pkg = query["packageName"].orEmpty()
            val arr = JSONArray().apply {
                PortalNotificationListener.snapshot(pkg).forEach { put(it.toJson()) }
            }
            return 200 to JSONObject().put("items", arr)
        }

        return 404 to JSONObject().put("error", "Not found: $path")
    }

    private fun resolvePackageByName(appName: String): String? {
        val target = appName.trim().lowercase()
        if (target.isEmpty()) return null
        val launchIntent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val resolved = packageManager.queryIntentActivities(launchIntent, 0)
        var partialHit: String? = null
        for (info in resolved) {
            val pkg = info.activityInfo?.packageName ?: continue
            val label = info.loadLabel(packageManager)?.toString()?.trim()?.lowercase().orEmpty()
            if (label == target || pkg.lowercase() == target) return pkg
            if (partialHit == null && (label.contains(target) || target.contains(label))) {
                partialHit = pkg
            }
        }
        return partialHit
    }

    private fun drawSomBoxes(src: Bitmap, nodes: List<PrunedUiNode>): Bitmap {
        val copy = src.copy(Bitmap.Config.ARGB_8888, true)
        val canvas = Canvas(copy)
        val boxPaint = Paint().apply {
            color = Color.argb(200, 255, 87, 34)
            style = Paint.Style.STROKE
            strokeWidth = 3f
        }
        val tagBg = Paint().apply {
            color = Color.argb(220, 255, 87, 34)
            style = Paint.Style.FILL
        }
        val textPaint = Paint().apply {
            color = Color.WHITE
            textSize = 26f
            isAntiAlias = true
        }
        for (n in nodes.take(60)) {
            canvas.drawRect(n.bounds, boxPaint)
            val tag = "#${n.index}"
            val tw = textPaint.measureText(tag) + 10f
            val tx = n.bounds.left.toFloat().coerceAtLeast(0f)
            val ty = n.bounds.top.toFloat().coerceAtLeast(28f)
            canvas.drawRect(tx, ty - 28f, tx + tw, ty, tagBg)
            canvas.drawText(tag, tx + 5f, ty - 6f, textPaint)
        }
        return copy
    }

    private fun bitmapToJpegBase64(bmp: Bitmap): String {
        val maxDim = 1080
        val scale = minOf(1f, maxDim.toFloat() / maxOf(bmp.width, bmp.height))
        val target = if (scale < 1f) {
            Bitmap.createScaledBitmap(bmp, (bmp.width * scale).toInt(), (bmp.height * scale).toInt(), true)
        } else {
            bmp
        }
        val out = ByteArrayOutputStream()
        target.compress(Bitmap.CompressFormat.JPEG, 72, out)
        if (target !== bmp) target.recycle()
        return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }

    private fun readAsciiLine(input: BufferedInputStream): String? {
        val out = ByteArrayOutputStream()
        var prev = -1
        while (true) {
            val b = input.read()
            if (b < 0) return if (out.size() == 0) null else out.toString(StandardCharsets.UTF_8.name())
            if (b == '\n'.code) {
                val raw = out.toByteArray()
                val len = if (prev == '\r'.code && raw.isNotEmpty()) raw.size - 1 else raw.size
                return String(raw, 0, len, StandardCharsets.UTF_8)
            }
            out.write(b)
            prev = b
        }
    }

    private fun parseQuery(q: String): Map<String, String> {
        if (q.isBlank()) return emptyMap()
        return q.split("&").mapNotNull { pair ->
            val eq = pair.indexOf('=')
            if (eq <= 0) null
            else URLDecoder.decode(pair.substring(0, eq), "UTF-8") to
                URLDecoder.decode(pair.substring(eq + 1), "UTF-8")
        }.toMap()
    }

    private fun writeJson(sock: Socket, code: Int, json: JSONObject) {
        val body = json.toString().toByteArray(StandardCharsets.UTF_8)
        val reason = when (code) {
            200 -> "OK"
            400 -> "Bad Request"
            401 -> "Unauthorized"
            404 -> "Not Found"
            503 -> "Service Unavailable"
            else -> "Internal Server Error"
        }
        val header = "HTTP/1.1 $code $reason\r\n" +
            "Content-Type: application/json; charset=utf-8\r\n" +
            "Content-Length: ${body.size}\r\n" +
            "Connection: close\r\n\r\n"
        sock.getOutputStream().apply {
            write(header.toByteArray(StandardCharsets.US_ASCII))
            write(body)
            flush()
        }
    }

    companion object {
        const val PORTAL_PORT = 18788
        const val PORTAL_TOKEN = "codeplant-dev-token"

        @Volatile
        var isRunning: Boolean = false
            private set

        fun start(context: Context) {
            val intent = Intent(context, PortalForegroundService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }
    }
}
