package com.meldiq.android

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.doubleClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.meldiq.android.data.model.AttachmentRef
import com.meldiq.android.ui.media.MediaAction
import com.meldiq.android.ui.media.MediaItem
import com.meldiq.android.ui.media.MediaViewer
import com.meldiq.android.ui.theme.GriipTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith

/** Uses only a synthetic local original: no account, API call, gallery mutation or share-sheet launch. */
@RunWith(AndroidJUnit4::class)
class MediaViewerTest {
    @get:Rule val compose = createComposeRule()
    @get:Rule val temp = TemporaryFolder()

    @Test fun animatedOriginalOpensZoomsAndOffersExplicitSaveAndShare() {
        val file = temp.newFile("animated.gif")
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.context.assets.open("media/animated.gif").use { input -> file.outputStream().use { input.copyTo(it) } }
        val ref = AttachmentRef("photo_00001", "animated.gif", "image/gif", file.length(), "key", "nonce", "hash")
        var chosen: MediaAction? = null
        compose.setContent {
            GriipTheme {
                MediaViewer(listOf(MediaItem("message_0001", ref, "user_0001", false, 1_792_000_000_000)), ref.id,
                    senderName = { "Media Test" }, load = { file }, progress = { null }, canPlayVideo = { null }, onPlay = {},
                    onAction = { action, item -> assertEquals(ref.id, item.ref.id); chosen = action }, onDismiss = {})
            }
        }
        compose.waitUntil(20_000) { compose.onAllNodes(androidx.compose.ui.test.hasContentDescription("Photo: animated.gif. Double tap to zoom.")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithContentDescription("Photo: animated.gif. Double tap to zoom.").performTouchInput { doubleClick() }
        instrumentation.uiAutomation.takeScreenshot()?.let { screenshot ->
            val output = java.io.File(instrumentation.targetContext.getExternalFilesDir(null), "media-viewer-qa.png")
            output.outputStream().use { screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
            screenshot.recycle()
        }
        compose.onNodeWithContentDescription("More options").performClick()
        compose.onNodeWithText("Save to Gallery").assertIsDisplayed()
        compose.onNodeWithText("Save to Files").assertIsDisplayed()
        compose.onNodeWithText("Share…").assertIsDisplayed().performClick()
        compose.runOnIdle { assertEquals(MediaAction.Share, chosen) }
    }
}
