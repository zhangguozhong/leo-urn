package com.urn.sdk

import org.junit.Assert.*
import org.junit.Test

class URNHostCapabilitiesTest {
    @Test
    fun modulePreflightNeverGrantsMissingCapabilities() {
        val modules =
            listOf(URNModuleManifest("account", "1.0.0", setOf("storage"), "account.v1", "base"))
        URNModuleManifest.validate(modules)
        assertThrows(IllegalStateException::class.java) {
            URNModuleManifest.preflight("account", modules, emptySet(), "base")
        }
        assertThrows(IllegalStateException::class.java) {
            URNModuleManifest.preflight("account", modules, setOf("storage"), "other")
        }
        URNModuleManifest.preflight("account", modules, setOf("storage"), "base")
        URNModuleManifest.preflight("legacy", modules, emptySet(), "base")
    }

    @Test
    fun duplicateOrMalformedModuleDeclarationsFail() {
        assertThrows(IllegalArgumentException::class.java) {
            URNModuleManifest.validate(listOf(URNModuleManifest("account", "latest")))
        }
        val module = URNModuleManifest("account", "1.0.0")
        assertThrows(IllegalArgumentException::class.java) {
            URNModuleManifest.validate(listOf(module, module))
        }
    }

    @Test
    fun environmentSnapshotsAreValuesAndRejectInvalidFields() {
        val initial = URNHostEnvironment()
        val dark = initial.copy(revision = 2, theme = "dark", userDomain = "user1")
        assertEquals("system", initial.theme)
        assertEquals("dark", dark.theme)
        assertThrows(IllegalArgumentException::class.java) { initial.copy(fontScale = Double.NaN) }
        assertThrows(IllegalArgumentException::class.java) { initial.copy(width = -1.0) }
        assertThrows(IllegalArgumentException::class.java) {
            initial.copy(userDomain = "token secret")
        }
    }
}
