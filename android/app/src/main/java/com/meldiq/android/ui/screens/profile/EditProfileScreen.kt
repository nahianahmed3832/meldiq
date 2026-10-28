package com.meldiq.android.ui.screens.profile

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AlternateEmail
import androidx.compose.material.icons.outlined.Cake
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Phone
import androidx.compose.material.icons.outlined.PhotoCamera
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.navigation.NavHostController
import com.meldiq.android.data.api.ApiException
import com.meldiq.android.data.api.UpdateMeReq
import com.meldiq.android.data.api.UserDto
import com.meldiq.android.data.model.PrivacyField
import com.meldiq.android.data.model.ProfileRules
import com.meldiq.android.ui.LocalContainer
import com.meldiq.android.ui.Routes
import com.meldiq.android.ui.components.BannerKind
import com.meldiq.android.ui.components.ButtonTone
import com.meldiq.android.ui.components.ChipRow
import com.meldiq.android.ui.components.GlassCard
import com.meldiq.android.ui.components.GriipSwitch
import com.meldiq.android.ui.components.GriipTextField
import com.meldiq.android.ui.components.GriipTopBar
import com.meldiq.android.ui.components.MenuRow
import com.meldiq.android.ui.components.PillButton
import com.meldiq.android.ui.components.PillChip
import com.meldiq.android.ui.components.SectionHeader
import com.meldiq.android.ui.components.ShimmerList
import com.meldiq.android.ui.components.StatusBanner
import com.meldiq.android.ui.components.UserAvatar
import com.meldiq.android.ui.friendly
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Space
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

/**
 * Edit profile (2026-10-17, docs/PROFILE_AND_PRIVACY.md): photo, names, username, bio, birthday and phone. Each field
 * shows who can see it (set under Privacy). Nothing is saved until Save; the server checks every field again.
 */
@Composable
fun EditProfileScreen(nav: NavHostController) {
    val container = LocalContainer.current
    val scope = rememberCoroutineScope()
    var me by remember { mutableStateOf<UserDto?>(null) }
    var loadError by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { runCatching { container.profiles.me() }.onSuccess { me = it }.onFailure { loadError = it.friendly() } }
    val u = me
    Column(Modifier.fillMaxSize().imePadding()) {
        GriipTopBar("Edit profile", onBack = { nav.popBackStack() })
        when {
            u != null -> EditProfileForm(u, onSaved = { me = it }, onPrivacy = { nav.navigate(Routes.PRIVACY) })
            loadError != null -> StatusBanner(
                loadError!!, BannerKind.Error, Modifier.padding(Space.gutter), action = "Retry",
                onAction = { loadError = null; scope.launch { runCatching { container.profiles.me() }.onSuccess { me = it }.onFailure { loadError = it.friendly() } } },
            )
            else -> ShimmerList(5, Modifier.padding(top = 8.dp))
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun EditProfileForm(u: UserDto, onSaved: (UserDto) -> Unit, onPrivacy: () -> Unit) {
    val container = LocalContainer.current
    val c = Griip.colors
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val privacy = ProfileRules.privacy(u.privacy)
    var display by rememberSaveable { mutableStateOf(u.displayName) }
    var first by rememberSaveable { mutableStateOf(u.firstName ?: "") }
    var last by rememberSaveable { mutableStateOf(u.lastName ?: "") }
    var pronouns by rememberSaveable { mutableStateOf(u.pronouns ?: "") }
    var pronounsSupported by remember { mutableStateOf(false) }
    androidx.compose.runtime.LaunchedEffect(Unit) { pronounsSupported = container.features.has(com.meldiq.android.data.repo.ServerFeatures.PRONOUNS) == true }
    var username by rememberSaveable { mutableStateOf(u.username) }
    var bio by rememberSaveable { mutableStateOf(u.statusText ?: "") }
    var phone by rememberSaveable { mutableStateOf(u.phone ?: "") }
    var birthday by rememberSaveable { mutableStateOf(u.birthday ?: "") }
    var color by rememberSaveable { mutableIntStateOf(u.avatarColor) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var saved by remember { mutableStateOf(false) }
    var photoRev by remember { mutableStateOf(u.photoRev) }
    var photoBusy by remember { mutableStateOf(false) }
    var pickDate by remember { mutableStateOf(false) }
    // What the server can store (2026-10-17): an older server has no photos or extended profile fields, and used to
    // answer a photo upload with a bare "Not found". null while unknown (then everything is offered).
    var features by remember { mutableStateOf<Set<String>?>(null) }
    LaunchedEffect(Unit) { features = container.features.get() }
    val photosSupported = features?.contains(com.meldiq.android.data.repo.ServerFeatures.PROFILE_PHOTOS) != false
    val profilesSupported = features?.contains(com.meldiq.android.data.repo.ServerFeatures.PROFILES) != false
    // Username: checked against the server as it's typed (only when it changed).
    var usernameNote by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(username) {
        usernameNote = null
        val v = username.trim().lowercase()
        if (v == u.username.lowercase()) return@LaunchedEffect
        ProfileRules.usernameProblem(v)?.let { usernameNote = it; return@LaunchedEffect }
        delay(400)
        usernameNote = runCatching { container.session.usernameAvailable(container.session.serverUrl, v) }
            .map { if (it.available) null else (it.reason ?: "That username is taken") }.getOrNull()
    }
    val phoneOk = ProfileRules.normalizePhone(phone) != null
    val canSave = display.isNotBlank() && usernameNote == null && phoneOk && !saving

    val pickPhoto = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) scope.launch {
            photoBusy = true
            runCatching { container.profiles.setPhoto(com.meldiq.android.media.MediaPrep.profilePhoto(ctx, uri)) }
                .onSuccess { photoRev = it }.onFailure { error = it.friendly() }
            photoBusy = false
        }
    }

    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 32.dp)) {
        item {
            Column(Modifier.fillMaxWidth().padding(vertical = 12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                UserAvatar(u.id, display.ifBlank { "?" }, color, photoRev, size = 96.dp)
                Spacer(Modifier.height(10.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    PillButton(
                        if (photoRev == null) "Add photo" else "Change photo",
                        { pickPhoto.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
                        tone = ButtonTone.Glass, height = 40.dp, leadingIcon = Icons.Outlined.PhotoCamera, loading = photoBusy, enabled = photosSupported,
                    )
                    if (photoRev != null) PillButton(
                        "Remove", {
                            scope.launch {
                                photoBusy = true
                                runCatching { container.profiles.removePhoto() }.onSuccess { photoRev = null }.onFailure { error = it.friendly() }
                                photoBusy = false
                            }
                        },
                        tone = ButtonTone.Glass, height = 40.dp, leadingIcon = Icons.Outlined.Delete,
                    )
                }
                Text(
                    "Photo: ${ProfileRules.audienceSummary(privacy.getValue(PrivacyField.PHOTO))}",
                    style = Griip.type.caption, color = c.textTertiary, modifier = Modifier.padding(top = 6.dp),
                )
                if (photoRev == null) ChipRow(Modifier.padding(top = 6.dp)) { (0..7).forEach { i -> PillChip("${i + 1}", color == i, { color = i }) } }
            }
        }
        if (!profilesSupported || !photosSupported) item {
            StatusBanner(
                "Your server is older than this version of Meldiq, so profile photos, first and last names, birthday and phone " +
                    "can't be saved there yet. Your display name, username and bio still work. Whoever runs the server needs to update it.",
                BannerKind.Warning, Modifier.padding(horizontal = Space.gutter, vertical = 4.dp),
            )
        }
        error?.let { item { StatusBanner(it, BannerKind.Error, Modifier.padding(horizontal = Space.gutter, vertical = 4.dp)) } }
        if (saved) item { StatusBanner("Profile saved", BannerKind.Success, Modifier.padding(horizontal = Space.gutter, vertical = 4.dp)) }
        item { SectionHeader("Name", Modifier.padding(top = 8.dp, bottom = 6.dp)) }
        item {
            Column(Modifier.padding(horizontal = Space.gutter), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                GriipTextField(first, { first = it.take(40) }, "First name", keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words))
                GriipTextField(last, { last = it.take(40) }, "Last name (optional)", keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words))
                // Batch B12: free text, shown with your bio (same privacy setting).
                if (pronounsSupported) GriipTextField(pronouns, { pronouns = it.take(40) }, androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.b12_pronouns), placeholder = androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.b12_pronouns_hint))
                GriipTextField(
                    display, { display = it.take(60) }, "Display name",
                    helper = "Shown in chats and calls to everyone you talk to.",
                    error = if (display.isBlank()) "A display name is needed" else null,
                    trailing = if (display.isBlank() && (first.isNotBlank() || last.isNotBlank())) ({
                        TextButton(onClick = { display = ProfileRules.suggestedDisplayName(first, last) }) { Text("Use name") }
                    }) else null,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words),
                )
                Text("First and last name: ${ProfileRules.audienceSummary(privacy.getValue(PrivacyField.NAME))}", style = Griip.type.caption, color = c.textTertiary)
            }
        }
        item { SectionHeader("Username", Modifier.padding(top = 14.dp, bottom = 6.dp)) }
        item {
            Column(Modifier.padding(horizontal = Space.gutter)) {
                GriipTextField(
                    username, { username = it.take(24).lowercase().replace(" ", "") }, "Username", leadingIcon = Icons.Outlined.AlternateEmail,
                    helper = "People find and mention you with it. Once changed, it can't change again for an hour; your old one becomes free.",
                    error = usernameNote,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, keyboardType = KeyboardType.Ascii),
                )
            }
        }
        item { SectionHeader("About", Modifier.padding(top = 14.dp, bottom = 6.dp)) }
        item {
            Column(Modifier.padding(horizontal = Space.gutter), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                GriipTextField(
                    bio, { bio = it.take(140) }, "Bio", placeholder = "A few words about you", singleLine = false, minLines = 2,
                    helper = "${bio.length}/140 · ${ProfileRules.audienceSummary(privacy.getValue(PrivacyField.BIO))}",
                )
                GlassCard(Modifier.fillMaxWidth(), contentPadding = PaddingValues(4.dp)) {
                    val b = ProfileRules.Birthday.parse(birthday)
                    MenuRow(
                        Icons.Outlined.Cake, b?.display() ?: "Add birthday",
                        subtitle = "Birthday · " + ProfileRules.audienceSummary(privacy.getValue(PrivacyField.BIRTHDAY)),
                        onClick = { pickDate = true },
                        trailing = if (b != null) ({ TextButton(onClick = { birthday = "" }) { Text("Clear") } }) else null,
                    )
                }
                GriipTextField(
                    phone, { phone = it.take(24) }, "Phone number (optional)", leadingIcon = Icons.Outlined.Phone, placeholder = "+8801712345678",
                    helper = "With the country code. Not verified. " + ProfileRules.audienceSummary(privacy.getValue(PrivacyField.PHONE)) +
                        " can see it; finding you by it: " + ProfileRules.audienceSummary(privacy.getValue(PrivacyField.FIND_BY_PHONE)).lowercase() + ".",
                    error = if (!phoneOk) "Start with + and the country code" else null,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                )
            }
        }
        item {
            GlassCard(Modifier.fillMaxWidth().padding(horizontal = Space.gutter, vertical = 12.dp), contentPadding = PaddingValues(4.dp)) {
                MenuRow(Icons.Outlined.Visibility, "Who can see what", subtitle = "Choose for each part of your profile", onClick = onPrivacy)
            }
        }
        item {
            PillButton(
                "Save", {
                    saving = true
                    error = null
                    saved = false
                    scope.launch {
                        val req = UpdateMeReq(
                            displayName = display.trim(), statusText = bio.trim(), avatarColor = color,
                            firstName = first.trim(), lastName = last.trim(), birthday = birthday,
                            phone = ProfileRules.normalizePhone(phone) ?: "",
                            username = username.trim().lowercase().takeIf { it != u.username.lowercase() },
                            pronouns = if (pronounsSupported) pronouns.trim() else null,
                        )
                        runCatching { container.profiles.update(req) }
                            .onSuccess { onSaved(it); saved = true }
                            .onFailure { e ->
                                error = if (e is ApiException && e.status == 409) "That username is taken" else e.friendly()
                            }
                        saving = false
                    }
                },
                Modifier.fillMaxWidth().padding(horizontal = Space.gutter), enabled = canSave, loading = saving, height = 50.dp,
                leadingIcon = Icons.Outlined.Edit,
            )
        }
    }

    if (pickDate) {
        val current = ProfileRules.Birthday.parse(birthday)
        val initial = current?.let { LocalDate.of(it.year ?: 2000, it.month, it.day).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli() }
        val state = rememberDatePickerState(initialSelectedDateMillis = initial, yearRange = 1900..LocalDate.now().year)
        var hideYear by remember { mutableStateOf(current != null && current.year == null) }
        DatePickerDialog(
            onDismissRequest = { pickDate = false },
            confirmButton = {
                TextButton(onClick = {
                    state.selectedDateMillis?.let { ms ->
                        val d = Instant.ofEpochMilli(ms).atZone(ZoneOffset.UTC).toLocalDate()
                        birthday = ProfileRules.Birthday(if (hideYear) null else d.year, d.monthValue, d.dayOfMonth).wire
                    }
                    pickDate = false
                }) { Text("Done") }
            },
            dismissButton = { TextButton(onClick = { pickDate = false }) { Text("Cancel") } },
        ) {
            DatePicker(state, showModeToggle = true)
            Row(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Don't show the year", style = Griip.type.body, color = c.textPrimary, modifier = Modifier.weight(1f))
                GriipSwitch(hideYear, { hideYear = it })
            }
        }
    }
}
