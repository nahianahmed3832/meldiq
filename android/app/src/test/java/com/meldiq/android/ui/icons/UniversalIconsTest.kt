package com.meldiq.android.ui.icons

import android.app.Application
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(application = Application::class, sdk = [35])
class UniversalIconsTest {
    @Test fun everySemanticVectorRendersFromBundledResources() {
        val context = ApplicationProvider.getApplicationContext<Application>()
        assertEquals(33, MeldiqIcon.entries.size)
        assertEquals(33, MeldiqIcon.entries.map { it.semanticId }.toSet().size)
        for (icon in MeldiqIcon.entries) {
            val drawable = context.getDrawable(icon.drawable)!!.mutate()
            val bitmap = Bitmap.createBitmap(48, 48, Bitmap.Config.ARGB_8888)
            drawable.setBounds(0, 0, 48, 48)
            drawable.setTint(Color.WHITE)
            drawable.draw(Canvas(bitmap))
            val pixels = IntArray(48 * 48)
            bitmap.getPixels(pixels, 0, 48, 0, 0, 48, 48)
            assertTrue("Empty vector: ${icon.semanticId}", pixels.any { Color.alpha(it) > 0 })
            assertTrue("Solid square: ${icon.semanticId}", pixels.any { Color.alpha(it) == 0 })
            bitmap.recycle()
        }
    }
}
