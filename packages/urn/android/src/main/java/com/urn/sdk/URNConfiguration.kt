package com.urn.sdk

import com.aeris.sdk.BridgeEngine
import com.facebook.react.ReactPackage
import com.urn.sdk.routing.URNChannelBudget

data class URNPagePolicy(
    val permissions: Set<String> = emptySet(),
    val eventTopics: Set<String>? = null,
)

/** 页面、业务 Engine 和权限由宿主组装，SDK 不默认授予业务能力。 */
data class URNConfiguration(
    val engine: BridgeEngine,
    val reactPackages: List<ReactPackage>,
    val baselineId: String = "urn-rn087",
    val jsMainModulePath: String = "index.container",
    val bundleAssetPath: String = "index.android.bundle",
    val developerSupport: Boolean = false,
    val channelBudget: URNChannelBudget = URNChannelBudget(),
    val mixedRouting: URNMixedRouting? = null,
    val captureState: (URNPageHandle, (Result<com.google.gson.JsonElement>) -> Unit) -> Unit =
        { _, done ->
            done(Result.success(com.google.gson.JsonNull.INSTANCE))
        },
    val restoreState: (URNPageHandle, com.google.gson.JsonElement, (Result<Unit>) -> Unit) -> Unit =
        { _, state, done ->
            done(
                if (state.isJsonNull) Result.success(Unit)
                else Result.failure(URNContainerException("RESTORE_UNAVAILABLE", "宿主未接入业务恢复钩子"))
            )
        },
    val prewarmTtlMs: Long = 0,
    val initialEnvironment: URNHostEnvironment = URNHostEnvironment(),
    val modules: List<URNModuleManifest> = emptyList(),
    val availableCapabilities: Set<String> = emptySet(),
    val maxPages: Int = 64,
    val startupTimeoutMs: Long = 30000,
    val closeTimeoutMs: Long = 10000,
    val navigationTimeoutMs: Long = 15000,
    val navigator: URNPageNavigating = URNFragmentNavigator(),
    val pageUI: URNPageUI = URNPageUI(),
    // 返回 null 表示拒绝；目标权限绝不继承来源页，默认不授予业务能力。
    val navigationPagePolicy: (URNPageHandle, String) -> URNPagePolicy? = { _, _ ->
        URNPagePolicy()
    },
    val onStructuredDiagnostic: (URNDiagnostic) -> Unit = {},
    val diagnosticIncludesFeatureId: Boolean = false,
    val cleanup: (URNPageHandle, (Result<Unit>) -> Unit) -> Unit = { _, completion ->
        completion(Result.success(Unit))
    },
    val onDiagnostic: (String, String?, String?) -> Unit = { _, _, _ -> },
) {
    init {
        require(prewarmTtlMs in 0..3600000)
        URNModuleManifest.validate(modules)
        require(maxPages in 1..channelBudget.maxChannels)
        require(
            startupTimeoutMs in 1..600000 &&
                closeTimeoutMs in 1..600000 &&
                navigationTimeoutMs in 1..600000
        )
        require(Regex("^[A-Za-z0-9_-]+$").matches(baselineId))
        require(bundleAssetPath.isNotBlank() && jsMainModulePath.isNotBlank())
    }
}
