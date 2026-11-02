package com.meldiq.android

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.filters.SdkSuppress
import com.meldiq.android.ui.media.MediaExport
import android.graphics.drawable.AnimatedImageDrawable
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith

/** Real platform decoding: uploaded animations must not silently become a still frame in the viewer. */
@RunWith(AndroidJUnit4::class)
@SdkSuppress(minSdkVersion = 28)
class MediaDecodeTest {
    @get:Rule val temp = TemporaryFolder()

    @Test fun gifAndWebpKeepTheirAnimationWithBoundedFrames() = runBlocking {
        for (name in listOf("animated.gif", "animated.webp")) {
            val file = temp.newFile(name)
            InstrumentationRegistry.getInstrumentation().context.assets.open("media/$name").use { input -> file.outputStream().use { input.copyTo(it) } }
            val decoded = MediaExport.decodeDrawable(file, 64)
            assertTrue("$name must remain animated", decoded is AnimatedImageDrawable)
            checkNotNull(decoded)
            assertEquals(64, decoded.intrinsicWidth)
            assertTrue(decoded.intrinsicHeight in 1..64)
            val animation = decoded as AnimatedImageDrawable
            InstrumentationRegistry.getInstrumentation().runOnMainSync {
                animation.start()
                assertTrue(animation.isRunning)
                animation.stop()
                assertTrue(!animation.isRunning)
            }
        }
    }

    @Test fun damagedMediaReturnsAnUnsupportedResult() = runBlocking {
        val file = temp.newFile("damaged.gif").apply { writeText("GIF89a-not-a-real-image") }
        assertNull(MediaExport.decodeDrawable(file, 64))
    }
}
