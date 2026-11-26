package com.codeplant.portal.accessibility

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject

data class PrunedUiNode(
    val index: Int,
    val text: String,
    val desc: String,
    val resourceId: String,
    val clickable: Boolean,
    val editable: Boolean,
    val scrollable: Boolean,
    val bounds: Rect,
) {
    fun centerX(): Int = bounds.centerX()
    fun centerY(): Int = bounds.centerY()

    fun toJson(): JSONObject = JSONObject().apply {
        put("index", index)
        put("text", text)
        put("desc", desc)
        put("resourceId", resourceId)
        put("clickable", clickable)
        put("editable", editable)
        put("scrollable", scrollable)
        put("bounds", JSONArray(listOf(bounds.left, bounds.top, bounds.right, bounds.bottom)))
        put("center", JSONArray(listOf(centerX(), centerY())))
    }

    fun formatLine(): String {
        val flags = buildList {
            if (clickable) add("click")
            if (editable) add("edit")
            if (scrollable) add("scroll")
        }.joinToString(",")
        val label = listOfNotNull(
            text.takeIf { it.isNotBlank() },
            desc.takeIf { it.isNotBlank() && it != text }?.let { "($it)" },
        ).joinToString(" ").ifBlank { resourceId.substringAfterLast('/') }
        return "[$index] $label {$flags} @(${centerX()},${centerY()})"
    }
}

class PortalAccessibilityService : AccessibilityService() {

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        event?.packageName?.toString()?.takeIf { it.isNotBlank() }?.let {
            lastForegroundPackage = it
        }
    }

    override fun onInterrupt() {}

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }

    fun currentPackageName(): String {
        val rootPkg = runCatching { rootInActiveWindow?.packageName?.toString() }.getOrNull()
        return rootPkg?.takeIf { it.isNotBlank() } ?: lastForegroundPackage
    }

    fun capturePrunedTree(screenWidth: Int, screenHeight: Int): Pair<List<PrunedUiNode>, String> {
        val root = rootInActiveWindow ?: return emptyList<PrunedUiNode>() to "(无法读取当前窗口节点)"
        val out = mutableListOf<PrunedUiNode>()
        collectNodes(root, screenWidth, screenHeight, out, 0)
        val formatted = if (out.isEmpty()) {
            "(当前界面无可见可交互节点，建议附带 screenshot)"
        } else {
            out.joinToString("\n") { it.formatLine() }
        }
        return out to formatted
    }

    private fun collectNodes(
        node: AccessibilityNodeInfo?,
        w: Int,
        h: Int,
        out: MutableList<PrunedUiNode>,
        depth: Int,
    ) {
        if (node == null || depth > 35 || out.size >= 140) return
        if (node.isVisibleToUser) {
            val rect = Rect()
            node.getBoundsInScreen(rect)
            val inBounds = rect.width() > 2 && rect.height() > 2 &&
                rect.right > 0 && rect.bottom > 0 && rect.left < w && rect.top < h
            val text = node.text?.toString()?.trim().orEmpty().take(80)
            val desc = node.contentDescription?.toString()?.trim().orEmpty().take(80)
            val resId = node.viewIdResourceName.orEmpty()
            val meaningful = node.isClickable || node.isEditable || node.isScrollable ||
                text.isNotEmpty() || desc.isNotEmpty()
            if (inBounds && meaningful) {
                out.add(
                    PrunedUiNode(
                        index = out.size + 1,
                        text = text,
                        desc = desc,
                        resourceId = resId,
                        clickable = node.isClickable,
                        editable = node.isEditable,
                        scrollable = node.isScrollable,
                        bounds = rect,
                    ),
                )
            }
        }
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            collectNodes(child, w, h, out, depth + 1)
            @Suppress("DEPRECATION")
            runCatching { child.recycle() }
        }
    }

    suspend fun tap(x: Float, y: Float, durationMs: Long = 60L): Boolean {
        val path = Path().apply { moveTo(x, y) }
        val stroke = GestureDescription.StrokeDescription(path, 0L, durationMs.coerceIn(20L, 2_000L))
        return dispatch(GestureDescription.Builder().addStroke(stroke).build())
    }

    suspend fun swipe(x1: Float, y1: Float, x2: Float, y2: Float, durationMs: Long = 320L): Boolean {
        val path = Path().apply {
            moveTo(x1, y1)
            lineTo(x2, y2)
        }
        val stroke = GestureDescription.StrokeDescription(path, 0L, durationMs.coerceIn(50L, 3_000L))
        return dispatch(GestureDescription.Builder().addStroke(stroke).build())
    }

    private suspend fun dispatch(gesture: GestureDescription): Boolean {
        val deferred = CompletableDeferred<Boolean>()
        val ok = dispatchGesture(
            gesture,
            object : GestureResultCallback() {
                override fun onCompleted(gestureDescription: GestureDescription?) {
                    deferred.complete(true)
                }

                override fun onCancelled(gestureDescription: GestureDescription?) {
                    deferred.complete(false)
                }
            },
            null,
        )
        if (!ok) return false
        return withTimeoutOrNull(4_000L) { deferred.await() } ?: false
    }

    fun inputText(text: String): Boolean {
        val root = rootInActiveWindow ?: return false
        val focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: findFirstEditable(root)
        if (focused != null) {
            val args = Bundle().apply {
                putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
            }
            if (focused.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) {
                return true
            }
            // Fallback: clipboard + ACTION_PASTE for custom WebView/WeChat inputs
            val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            cm.setPrimaryClip(ClipData.newPlainText("codeplant", text))
            if (focused.performAction(AccessibilityNodeInfo.ACTION_PASTE)) {
                return true
            }
        }
        return false
    }

    private fun findFirstEditable(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        if (node.isEditable && node.isVisibleToUser) return node
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            val hit = findFirstEditable(child)
            if (hit != null) return hit
        }
        return null
    }

    fun pressSystemKey(key: String): Boolean {
        val action = when (key.lowercase()) {
            "back" -> GLOBAL_ACTION_BACK
            "home" -> GLOBAL_ACTION_HOME
            "recents" -> GLOBAL_ACTION_RECENTS
            "notifications" -> GLOBAL_ACTION_NOTIFICATIONS
            else -> return false
        }
        return performGlobalAction(action)
    }

    suspend fun takeScreenshotBitmap(): Bitmap? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
        val deferred = CompletableDeferred<Bitmap?>()
        takeScreenshot(
            Display.DEFAULT_DISPLAY,
            mainExecutor,
            object : TakeScreenshotCallback {
                override fun onSuccess(screenshot: ScreenshotResult) {
                    val bmp = runCatching {
                        val hw = Bitmap.wrapHardwareBuffer(screenshot.hardwareBuffer, screenshot.colorSpace)
                        val soft = hw?.copy(Bitmap.Config.ARGB_8888, false)
                        hw?.recycle()
                        soft
                    }.getOrNull()
                    runCatching { screenshot.hardwareBuffer.close() }
                    deferred.complete(bmp)
                }

                override fun onFailure(errorCode: Int) {
                    deferred.complete(null)
                }
            },
        )
        return withTimeoutOrNull(4_000L) { deferred.await() }
    }

    companion object {
        @Volatile
        var instance: PortalAccessibilityService? = null
            private set

        @Volatile
        var lastForegroundPackage: String = ""
            private set

        fun isConnected(): Boolean = instance != null
    }
}
