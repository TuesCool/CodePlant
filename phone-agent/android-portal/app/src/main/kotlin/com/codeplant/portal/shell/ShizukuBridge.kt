package com.codeplant.portal.shell

import android.content.ComponentName
import android.content.Context
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.IBinder
import com.codeplant.portal.BuildConfig
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import rikka.shizuku.Shizuku

data class ShizukuState(
    val binderAlive: Boolean = false,
    val permissionGranted: Boolean = false,
    val serviceBound: Boolean = false,
    val uid: Int = -1,
) {
    val isReady: Boolean get() = binderAlive && permissionGranted && serviceBound
}

object ShizukuBridge {
    private val _state = MutableStateFlow(ShizukuState())
    val state: StateFlow<ShizukuState> = _state.asStateFlow()

    @Volatile
    private var appContext: Context? = null

    @Volatile
    private var shellService: IPortalShellService? = null

    @Volatile
    private var pendingBind: CompletableDeferred<IPortalShellService?>? = null

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
            val stub = service?.let { IPortalShellService.Stub.asInterface(it) }
            shellService = stub
            val uid = runCatching { stub?.uid ?: -1 }.getOrDefault(-1)
            refresh(bound = stub != null, uid = uid)
            pendingBind?.complete(stub)
            pendingBind = null
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            shellService = null
            refresh(bound = false, uid = -1)
        }
    }

    private val binderListener = Shizuku.OnBinderReceivedListener {
        refresh()
        if (hasPermission()) bindAsync()
    }

    private val deadListener = Shizuku.OnBinderDeadListener {
        shellService = null
        refresh(bound = false, uid = -1)
    }

    private val permListener = Shizuku.OnRequestPermissionResultListener { _, grantResult ->
        refresh()
        if (grantResult == PackageManager.PERMISSION_GRANTED) {
            bindAsync()
        }
    }

    fun init(context: Context) {
        if (appContext != null) return
        appContext = context.applicationContext
        Shizuku.addBinderReceivedListenerSticky(binderListener)
        Shizuku.addBinderDeadListener(deadListener)
        Shizuku.addRequestPermissionResultListener(permListener)
        refresh()
    }

    fun hasPermission(): Boolean = runCatching {
        Shizuku.pingBinder() && Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED
    }.getOrDefault(false)

    fun requestPermission(requestCode: Int = 1001) {
        runCatching {
            if (Shizuku.pingBinder() && !hasPermission()) {
                Shizuku.requestPermission(requestCode)
            }
        }
    }

    fun refresh(bound: Boolean? = null, uid: Int? = null) {
        val alive = runCatching { Shizuku.pingBinder() }.getOrDefault(false)
        val perm = if (alive) hasPermission() else false
        val currentBound = bound ?: (shellService != null && alive)
        val currentUid = uid ?: if (currentBound) runCatching { shellService?.uid ?: -1 }.getOrDefault(-1) else -1
        _state.value = ShizukuState(
            binderAlive = alive,
            permissionGranted = perm,
            serviceBound = currentBound,
            uid = currentUid,
        )
    }

    fun bindAsync() {
        val ctx = appContext ?: return
        if (!hasPermission()) return
        if (shellService != null) return
        val args = Shizuku.UserServiceArgs(
            ComponentName(ctx.packageName, PortalShellService::class.java.name),
        )
            .daemon(false)
            .processNameSuffix("portal_shell")
            .debuggable(BuildConfig.DEBUG)
            .version(BuildConfig.VERSION_CODE)
        runCatching {
            Shizuku.bindUserService(args, connection)
        }
    }

    private suspend fun ensureService(): IPortalShellService? {
        shellService?.let { return it }
        if (!hasPermission()) return null
        val waiter = pendingBind ?: CompletableDeferred<IPortalShellService?>().also {
            pendingBind = it
            bindAsync()
        }
        return withTimeoutOrNull(3_000L) { waiter.await() }
    }

    suspend fun screencapBitmap(): Bitmap? = withContext(Dispatchers.IO) {
        val svc = ensureService() ?: return@withContext null
        val bytes = runCatching { svc.screencapPng() }.getOrNull() ?: return@withContext null
        if (bytes.isEmpty()) return@withContext null
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
    }

    suspend fun exec(cmd: String, timeoutMs: Int = 6_000): String? = withContext(Dispatchers.IO) {
        val svc = ensureService() ?: return@withContext null
        runCatching { svc.exec(cmd, timeoutMs) }.getOrNull()
    }
}
