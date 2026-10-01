package com.smarterp.pos

import android.content.Context
import android.os.Handler
import android.os.Looper
import com.sunmi.peripheral.printer.InnerPrinterCallback
import com.sunmi.peripheral.printer.InnerPrinterManager
import com.sunmi.peripheral.printer.SunmiPrinterService

/**
 * Binds the built-in printer through printerlibrary 1.0.18.
 * That library does not ship woyou.aidlservice.jiuiv5.IWoyouService.
 * The live service is com.sunmi.peripheral.printer.SunmiPrinterService.
 */
object SunmiPrinterManager {

    @Volatile private var printer: SunmiPrinterService? = null
    private var context: Context? = null
    private val handler = Handler(Looper.getMainLooper())

    private val callback = object : InnerPrinterCallback() {
        override fun onConnected(service: SunmiPrinterService) {
            printer = service
            android.util.Log.e("SUNMI_TEST", "Printer service connected")
        }

        override fun onDisconnected() {
            printer = null
            scheduleRebind(2_000)
        }
    }

    fun init(ctx: Context) {
        context = ctx.applicationContext
        scheduleRebind(0)
    }

    fun destroy(ctx: Context) {
        handler.removeCallbacksAndMessages(null)
        printer = null
        try {
            InnerPrinterManager.getInstance().unBindService(ctx.applicationContext, callback)
        } catch (e: Exception) {
            android.util.Log.w("SunmiPrinterManager", "unbindService failed: ${e.message}")
        }
    }

    fun get(): SunmiPrinterService? = printer

    private fun scheduleRebind(delayMs: Long) {
        handler.postDelayed({ bind() }, delayMs)
    }

    private fun bind() {
        val ctx = context ?: return
        try {
            val bound = InnerPrinterManager.getInstance().bindService(ctx, callback)
            if (!bound) {
                android.util.Log.e("SunmiPrinterManager", "bindService returned false")
                scheduleRebind(5_000)
            }
        } catch (e: Exception) {
            android.util.Log.e("SunmiPrinterManager", "bindService failed: ${e.message}", e)
            scheduleRebind(5_000)
        }
    }
}
