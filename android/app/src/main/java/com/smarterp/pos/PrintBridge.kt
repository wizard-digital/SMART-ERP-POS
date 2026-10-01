package com.smarterp.pos

import android.webkit.JavascriptInterface
import com.google.gson.Gson

/**
 * PrintBridge — JavaScript ↔ Kotlin bridge object injected as
 * `window.SunmiPrinter` in the WebView.
 *
 * The frontend calls:
 *   window.SunmiPrinter.printReceipt(JSON.stringify(receiptData))
 *
 * and this class deserialises the payload and delegates to ReceiptPrinter.
 * No other bridge methods exist; the existing print pipeline (ESC/POS,
 * browser print) is never touched.
 */
class PrintBridge {

    private val gson = Gson()

    /** @return true when the built-in printer accepted the receipt. */
    @JavascriptInterface
    fun printReceipt(json: String): Boolean {
        // SUNMI_TEST — look for this in Logcat to confirm JS reached Android.
        // If you never see this line, window.SunmiPrinter injection failed.
        android.util.Log.e("SUNMI_TEST", "Bridge called — json length=${json.length}")
        return try {
            val data = gson.fromJson(json, ReceiptData::class.java)
            ReceiptPrinter.printReceipt(data)
        } catch (e: Exception) {
            // @JavascriptInterface methods cannot propagate exceptions to JS callers,
            // so we log the full stack trace to logcat instead of letting it crash.
            android.util.Log.e("PrintBridge", "printReceipt failed: ${e.message}", e)
            false
        }
    }

    /**
     * Hard test — call from the DevTools console to bypass receipt formatting:
     *   window.SunmiPrinter.hardTest()
     * Prints "SUNMI HARD TEST" directly to the printer.
     * If this prints → receipt formatting is the issue.
     * If this does NOT print → the service is still not bound.
     */
    @JavascriptInterface
    fun hardTest() {
        android.util.Log.e("SUNMI_TEST", "hardTest called from JS")
        ReceiptPrinter.hardTest()
    }
}
