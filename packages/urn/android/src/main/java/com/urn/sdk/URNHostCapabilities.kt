package com.urn.sdk

import com.google.gson.JsonObject

/** 只保存非敏感隔离标识；window使用值字段避免可变对象跨页面共享。 */
data class URNHostEnvironment(
    val revision: Long = 1,
    val theme: String = "system",
    val locale: String = "und",
    val fontScale: Double = 1.0,
    val width: Double = 0.0,
    val height: Double = 0.0,
    val userDomain: String = "anonymous",
) {
    init {
        require(revision in 1..9007199254740991L && theme in setOf("system", "light", "dark"))
        require(Regex("^[A-Za-z0-9_-]{1,80}$").matches(locale))
        require(fontScale.isFinite() && fontScale > 0 && fontScale <= 10)
        require(listOf(width, height).all { it.isFinite() && it >= 0 && it <= 100000 })
        require(Regex("^[A-Za-z0-9._-]{1,128}$").matches(userDomain))
    }

    internal fun values(): Map<String, Any> =
        mapOf(
            "revision" to revision.toDouble(),
            "theme" to theme,
            "locale" to locale,
            "fontScale" to fontScale,
            "window" to mapOf("width" to width, "height" to height),
            "userDomain" to userDomain,
        )

    internal fun json() =
        JsonObject().apply {
            addProperty("revision", revision)
            addProperty("theme", theme)
            addProperty("locale", locale)
            addProperty("fontScale", fontScale)
            addProperty("userDomain", userDomain)
            add(
                "window",
                JsonObject().apply {
                    addProperty("width", width)
                    addProperty("height", height)
                },
            )
        }
}

data class URNModuleManifest(
    val featureId: String,
    val version: String,
    val requiredCapabilities: Set<String> = emptySet(),
    val paramsContract: String? = null,
    val baselineId: String? = null,
) {
    companion object {
        internal fun validate(modules: List<URNModuleManifest>) {
            require(modules.map { it.featureId }.toSet().size == modules.size) {
                "DUPLICATE_MODULE"
            }
            modules.forEach {
                require(Regex("^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$").matches(it.featureId)) {
                    "INVALID_MODULE"
                }
                require(Regex("^\\d+\\.\\d+\\.\\d+(?:[-+][A-Za-z0-9.-]+)?$").matches(it.version)) {
                    "INVALID_MODULE"
                }
                require(
                    it.requiredCapabilities.all { value ->
                        Regex("^[a-z][a-z0-9._-]{0,79}$").matches(value)
                    }
                ) {
                    "INVALID_MODULE"
                }
                require(
                    listOf(it.paramsContract, it.baselineId).all { value ->
                        value == null || value.length in 1..128
                    }
                ) {
                    "INVALID_MODULE"
                }
            }
        }

        internal fun preflight(
            featureId: String,
            modules: List<URNModuleManifest>,
            capabilities: Set<String>,
            baselineId: String,
        ) {
            val module = modules.firstOrNull { it.featureId == featureId } ?: return
            if (!capabilities.containsAll(module.requiredCapabilities))
                throw URNContainerException("CAPABILITY_MISSING", "宿主缺少模块要求的能力")
            if (module.baselineId != null && module.baselineId != baselineId)
                throw URNContainerException("BASELINE_MISMATCH", "模块要求不同基线")
        }
    }
}
