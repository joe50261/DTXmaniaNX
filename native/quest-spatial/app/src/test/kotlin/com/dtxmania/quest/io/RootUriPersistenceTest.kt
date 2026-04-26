package com.dtxmania.quest.io

import android.content.Context
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Robolectric-backed test for [RootUriPersistence]. Uses JUnit 4 syntax
 * because Robolectric's runner is JUnit-4-only; the JUnit 5 platform
 * picks these tests up via the `junit-vintage-engine` dependency added
 * in `app/build.gradle.kts`.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RootUriPersistenceTest {

    private lateinit var context: Context
    private lateinit var store: RootUriPersistence

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        // Each test starts with a clean prefs file so order doesn't
        // matter and `load()` returning null is meaningful.
        context.getSharedPreferences(RootUriPersistence.PREFS_NAME, Context.MODE_PRIVATE)
            .edit().clear().apply()
        store = RootUriPersistence(context)
    }

    @Test
    fun `load returns null before any save`() {
        assertNull(store.load())
    }

    @Test
    fun `save then load round-trips the same URI`() {
        val uri = Uri.parse(
            "content://com.android.externalstorage.documents/tree/primary%3ASongs"
        )
        store.save(uri)
        assertEquals(uri, store.load())
    }

    @Test
    fun `save overwrites previous value (last writer wins)`() {
        val first = Uri.parse("content://example/tree/A")
        val second = Uri.parse("content://example/tree/B")
        store.save(first)
        store.save(second)
        assertEquals(second, store.load())
    }

    @Test
    fun `clear removes the saved URI`() {
        val uri = Uri.parse("content://example/tree/Songs")
        store.save(uri)
        store.clear()
        assertNull(store.load())
    }

    @Test
    fun `survives a new instance against the same context`() {
        val uri = Uri.parse("content://example/tree/Songs")
        store.save(uri)
        // A second instance reads the same SharedPreferences file.
        val reopened = RootUriPersistence(context)
        assertEquals(uri, reopened.load())
    }
}
