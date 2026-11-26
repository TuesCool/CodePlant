package com.codeplant.portal.shell

import android.os.Process
import java.io.ByteArrayOutputStream
import java.util.concurrent.TimeUnit
import kotlin.system.exitProcess

/**
 * Shizuku UserService running with UID 2000 (ADB Shell) or UID 0 (Root).
 * On MI14 without "USB debugging (Security settings)", this still enables silent `screencap`
 * and `uiautomator dump`, while touch injection stays on AccessibilityService.
 */
class PortalShellService : IPortalShellService.Stub() {

    override fun destroy() {
        exitProcess(0)
    }

    override fun exit() {
        destroy()
    }

    override fun getUid(): Int = Process.myUid()

    override fun exec(command: String?, timeoutMs: Int): String {
        if (command.isNullOrBlank()) return ""
        val bounded = timeoutMs.coerceIn(1_000, 30_000).toLong()
        return try {
            val proc = ProcessBuilder("sh", "-c", command)
                .redirectErrorStream(true)
                .start()
            val out = ByteArrayOutputStream()
            val reader = Thread {
                runCatching {
                    val buf = ByteArray(4096)
                    while (true) {
                        val n = proc.inputStream.read(buf)
                        if (n < 0) break
                        if (out.size() < MAX_OUTPUT_BYTES) {
                            out.write(buf, 0, n.coerceAtMost(MAX_OUTPUT_BYTES - out.size()))
                        }
                    }
                }
            }.apply { start() }

            val finished = proc.waitFor(bounded, TimeUnit.MILLISECONDS)
            if (!finished) {
                proc.destroyForcibly()
                reader.join(500)
                return "ERR_TIMEOUT: ${out.toString(Charsets.UTF_8.name())}"
            }
            reader.join(1000)
            val code = proc.exitValue()
            val text = out.toString(Charsets.UTF_8.name())
            if (code == 0) text else "ERR_EXIT_$code: $text"
        } catch (t: Throwable) {
            "ERR_EXCEPTION: ${t.message}"
        }
    }

    override fun screencapPng(): ByteArray {
        return try {
            val proc = ProcessBuilder("screencap", "-p").start()
            val bytes = proc.inputStream.readBytes()
            proc.waitFor(5_000, TimeUnit.MILLISECONDS)
            if (bytes.size <= MAX_BINDER_BYTES) bytes else ByteArray(0)
        } catch (_: Throwable) {
            ByteArray(0)
        }
    }

    companion object {
        private const val MAX_OUTPUT_BYTES = 256 * 1024
        private const val MAX_BINDER_BYTES = 750 * 1024
    }
}
