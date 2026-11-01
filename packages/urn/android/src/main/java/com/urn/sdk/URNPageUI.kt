package com.urn.sdk

import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

/** 覆盖层每页独占；宿主可替换品牌 UI，重试仅替换该页的 channel。 */
data class URNPageUI(
    val loading: (URNPageHandle) -> View = { page ->
        TextView(page.fragment.requireContext()).apply {
            text = "正在加载…"; gravity = Gravity.CENTER; tag = "urn.loading"
            setBackgroundColor(android.graphics.Color.WHITE)
        }
    },
    val failure: (URNPageHandle, Throwable, Boolean, () -> Unit) -> View = { page, _, canRetry, retry ->
        LinearLayout(page.fragment.requireContext()).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER; tag = "urn.error"
            setBackgroundColor(android.graphics.Color.WHITE)
            addView(TextView(context).apply { text = "页面加载失败" })
            addView(Button(context).apply {
                text = if (canRetry) "重试" else "正在清理，请稍候"
                isEnabled = canRetry; tag = "urn.retry"; setOnClickListener { retry() }
            })
        }
    },
    val navigationFailure: (URNPageHandle, Throwable, () -> Unit) -> View = { page, _, retry ->
        LinearLayout(page.fragment.requireContext()).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            tag = "urn.navigationError"
            setBackgroundColor(android.graphics.Color.WHITE)
            addView(TextView(context).apply { text = "页面关闭失败" })
            addView(Button(context).apply {
                text = "重试关闭"
                tag = "urn.retryNavigationClose"
                setOnClickListener { retry() }
            })
        }
    },
)

data class URNPageLifecycle(val visible: Boolean = false, val foreground: Boolean = false, val closed: Boolean = false)

data class URNDiagnostic(
    val timestampMs: Long = System.currentTimeMillis(),
    val stage: String,
    val runtimeGeneration: String? = null,
    val pageId: String? = null,
    val channelId: String? = null,
    val featureId: String? = null,
    val durationMs: Long? = null,
    val code: String? = null,
    val queuedMessages: Int? = null,
    val queuedBytes: Long? = null,
)
