package com.meldiq.android.ui.screens.profile

import android.content.ClipData
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.Send
import androidx.compose.material.icons.outlined.Block
import androidx.compose.material.icons.outlined.BugReport
import androidx.compose.material.icons.outlined.Cake
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Flag
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.Phone
import androidx.compose.material.icons.outlined.Verified
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.GppMaybe
import androidx.compose.material.icons.rounded.MoreHoriz
import androidx.compose.material.icons.outlined.ConfirmationNumber
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.toClipEntry
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.meldiq.android.R
import com.meldiq.android.data.api.RoleRef
import com.meldiq.android.data.api.UserDto
import com.meldiq.android.data.repo.GlobalAddress
import com.meldiq.android.data.repo.ServerFeatures
import com.meldiq.android.ui.LinkOpener
import com.meldiq.android.ui.LocalContainer
import com.meldiq.android.ui.Routes
import com.meldiq.android.ui.TimeFmt
import com.meldiq.android.ui.components.BannerKind
import com.meldiq.android.ui.components.CircleIconButton
import com.meldiq.android.ui.components.GlassCard
import com.meldiq.android.ui.components.IconTile
import com.meldiq.android.ui.components.MenuRow
import com.meldiq.android.ui.components.OrgMark
import com.meldiq.android.ui.components.PillButton
import com.meldiq.android.ui.components.StatusBanner
import com.meldiq.android.ui.components.pressable
import com.meldiq.android.ui.friendly
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Shapes
import com.meldiq.android.ui.theme.Space
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date

/** What the profile card shows, from the profile alone (unit-tested in `ProfileCardRulesTest`). */
object ProfileCardRules {
    /** The community it was opened from, when they share it: its name and when they joined it. */
    fun joinedHere(u: UserDto, orgId: String?): com.meldiq.android.data.api.MutualCommunityDto? =
        orgId?.let { id -> u.mutualCommunities.orEmpty().firstOrNull { it.id == id } }

    /** Their status as one line: emoji and text, or null. */
    fun statusLine(u: UserDto): String? = listOfNotNull(u.statusEmoji, u.statusText).joinToString(" ").trim().ifEmpty { null }

    /** The Mojo badge's name ("Mojo Go", "Mojo Plus"); null for anything else. */
    fun mojoName(badge: String?): String? = when (badge) {
        "go" -> "Mojo Go"
        "plus" -> "Mojo Plus"
        else -> null
    }

    /** https links only (the server accepts nothing else, but the card never opens another scheme). */
    fun links(u: UserDto): List<com.meldiq.android.data.api.ProfileLinkDto> = u.links.orEmpty().filter { it.url.startsWith("https://") }
}

/**
 * Someone's profile (the floating redesign, 2026-10-28, as Meldiq Web's ProfileDialog after the owner's reference): the
 * banner with … and Close, the large avatar overlapping it with their presence, Connect at the top right, the styled name,
 * @username, their community tag, Mojo badge and Bug Hunter badge, their status; then rounded sections on the frame:
 * About me, Links (in place of the reference's games, which Meldiq doesn't track), Now, Member since, Roles (opened from a
 * community) and mutual communities; and a "Message @username" box that starts or opens the DM. [orgId]: the community it
 * was opened from, for their roles and when they joined it.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun UserProfileScreen(nav: NavHostController, userId: String, orgId: String? = null) {
    val container = LocalContainer.current
    val c = Griip.colors
    val scope = rememberCoroutineScope()
    var user by remember { mutableStateOf<UserDto?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    val local by container.db.users().observe(userId).collectAsStateWithLifecycle(null)
    val me = container.session.session?.userId
    val self = userId == me
    LaunchedEffect(userId) { runCatching { container.users.fetch(userId) }.onSuccess { user = it }.onFailure { error = it.friendly() } }
    var blocked by remember { mutableStateOf<Boolean?>(null) }
    var reporting by remember { mutableStateOf(false) }
    var reportsAvailable by remember { mutableStateOf(false) }
    var inviteLinks by remember { mutableStateOf(false) }
    var inviting by remember { mutableStateOf(false) }
    var connectionsAvailable by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    var roles by remember { mutableStateOf<List<RoleRef>>(emptyList()) }
    LaunchedEffect(Unit) {
        reportsAvailable = container.features.has(ServerFeatures.REPORTS) == true
        inviteLinks = container.features.has(ServerFeatures.INVITE_LINKS) == true
        connectionsAvailable = container.features.has(ServerFeatures.CONNECTIONS) == true
    }
    LaunchedEffect(userId) { blocked = runCatching { userId in container.federation.blocked() }.getOrNull() }
    // Their roles in the community it was opened from (its member directory; empty where this account can't see it).
    LaunchedEffect(orgId, user?.username) {
        val u = user ?: return@LaunchedEffect
        val id = orgId ?: return@LaunchedEffect
        roles = runCatching { container.orgs.members(id, u.username).firstOrNull { it.id == userId }?.customRoles.orEmpty() }.getOrDefault(emptyList())
    }
    val clipboard = LocalClipboard.current
    val u = user

    LazyColumn(Modifier.fillMaxSize().background(c.background).statusBarsPadding(), contentPadding = PaddingValues(start = 10.dp, end = 10.dp, top = 8.dp, bottom = 40.dp)) {
        if (u == null) {
            item {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    CircleIconButton(Icons.Rounded.Close, stringResource(R.string.pf_close), { nav.popBackStack() }, background = c.surface)
                }
                error?.let { StatusBanner(it, BannerKind.Error, Modifier.padding(top = 8.dp)) }
            }
            return@LazyColumn
        }
        item(key = "card") {
            val look = com.meldiq.android.data.model.PersonLook(u.avatarMedia, u.profileStyle, u.tag)
            val remote = GlobalAddress.isRemote(u.username, u.homeServer)
            Column(Modifier.fillMaxWidth().clip(Shapes.hero).background(c.surface).border(1.dp, c.border, Shapes.hero)) {
                // The banner, with … and Close on it.
                Box(Modifier.fillMaxWidth().height(BANNER)) {
                    com.meldiq.android.ui.components.ProfileBannerView(u.id, u.profileBanner, u.profileStyle, Modifier.fillMaxSize())
                    Row(Modifier.align(Alignment.TopEnd).padding(8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        if (!self) Box {
                            CircleIconButton(Icons.Rounded.MoreHoriz, stringResource(R.string.pf_more, u.displayName), { menu = true }, tint = Color.White, background = Color.Black.copy(alpha = 0.45f), size = 36.dp)
                            DropdownMenu(menu, { menu = false }, containerColor = c.surfaceVariant, shape = Shapes.card) {
                                if (inviteLinks && !remote && blocked != true) DropdownMenuItem(
                                    { Text(stringResource(R.string.pi_invite), color = c.textPrimary) }, { menu = false; inviting = true },
                                    leadingIcon = { Icon(Icons.Outlined.ConfirmationNumber, null, tint = c.textSecondary) },
                                )
                                if (reportsAvailable) DropdownMenuItem(
                                    { Text(stringResource(R.string.rp_title_person, u.displayName), color = c.danger) }, { menu = false; reporting = true },
                                    leadingIcon = { Icon(Icons.Outlined.Flag, null, tint = c.danger) },
                                )
                                blocked?.let { isBlocked ->
                                    DropdownMenuItem(
                                        { Text(if (isBlocked) "Unblock ${u.displayName}" else "Block ${u.displayName}", color = c.danger) },
                                        {
                                            menu = false
                                            scope.launch {
                                                runCatching { if (isBlocked) container.federation.unblock(userId) else container.federation.block(userId) }
                                                    .onSuccess { blocked = !isBlocked }.onFailure { error = it.friendly() }
                                            }
                                        },
                                        leadingIcon = { Icon(Icons.Outlined.Block, null, tint = c.danger) },
                                    )
                                }
                                DropdownMenuItem(
                                    { Text(stringResource(R.string.pf_copy_username), color = c.textPrimary) },
                                    { menu = false; scope.launch { clipboard.setClipEntry(ClipData.newPlainText("username", "@" + u.username).toClipEntry()) } },
                                    leadingIcon = { Icon(Icons.Outlined.ContentCopy, null, tint = c.textSecondary) },
                                )
                            }
                        }
                        CircleIconButton(Icons.Rounded.Close, stringResource(R.string.pf_close), { nav.popBackStack() }, tint = Color.White, background = Color.Black.copy(alpha = 0.45f), size = 36.dp)
                    }
                }
                // The avatar overlaps the banner; Connect sits at the top right.
                Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp).height(AVATAR_OVERHANG), verticalAlignment = Alignment.Top) {
                    Box(Modifier.offset(y = -(AVATAR / 2)).clip(CircleShape).background(c.surface).padding(5.dp)) {
                        com.meldiq.android.ui.components.LookAvatar(u.id, u.displayName, u.avatarColor, u.photoRev, look, size = AVATAR, online = u.online, presence = u.presence)
                    }
                    Spacer(Modifier.weight(1f))
                    if (connectionsAvailable && !self && !remote && blocked != true) {
                        com.meldiq.android.ui.screens.contacts.ConnectionButton(u.id, Modifier.padding(top = 10.dp)) { error = it }
                    }
                }
                Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 16.dp)) {
                    com.meldiq.android.ui.components.StyledName(u.displayName, look, Griip.type.headline, c.textPrimary)
                    Text("@${u.username}" + (u.pronouns?.let { " · $it" } ?: ""), style = Griip.type.bodySmall, color = c.textSecondary)
                    FlowRow(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        u.tag?.let { t -> Chip(t.text, dot = com.meldiq.android.data.model.LookRules.argb(t.color)?.let { Color(it) }) }
                        ProfileCardRules.mojoName(u.mojo?.badge)?.let { name -> Chip(name, icon = if (u.mojo?.check == true) Icons.Outlined.Verified else null, accent = true) }
                        if ("bug-hunter" in u.badges.orEmpty()) Chip(stringResource(R.string.wp_badge_bug_hunter), icon = Icons.Outlined.BugReport)
                    }
                    ProfileCardRules.statusLine(u)?.let { Text(it, style = Griip.type.body, color = c.textPrimary, modifier = Modifier.padding(top = 10.dp)) }
                    error?.let { StatusBanner(it, BannerKind.Error, Modifier.padding(top = 10.dp)) }

                    if (!u.aboutMe.isNullOrBlank()) Section(stringResource(R.string.wp_about_me)) { Text(u.aboutMe, style = Griip.type.body, color = c.textPrimary) }
                    val links = ProfileCardRules.links(u)
                    if (links.isNotEmpty()) Section(stringResource(R.string.pf_links)) {
                        val ctx = LocalContext.current
                        links.forEach { link ->
                            Row(
                                Modifier.fillMaxWidth().clip(Shapes.small).pressable({ LinkOpener.open(ctx, link.url, inApp = true) }).padding(vertical = 6.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Icon(Icons.Outlined.Link, null, tint = c.textSecondary, modifier = Modifier.size(18.dp))
                                Spacer(Modifier.width(8.dp))
                                Text(link.label.ifBlank { link.url }, style = Griip.type.bodyMedium, color = c.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                        }
                    }
                    Section(stringResource(R.string.pf_now)) {
                        val server = if (remote) GlobalAddress.serverOf(u.username) else null
                        val shown = when {
                            server != null -> "On another server: $server"
                            u.online == true && u.presence == com.meldiq.android.data.model.PresenceRules.IDLE -> stringResource(R.string.b6b_idle)
                            u.online == true && u.presence == com.meldiq.android.data.model.PresenceRules.DND -> stringResource(R.string.b6b_dnd)
                            u.online == true -> stringResource(R.string.pf_online)
                            u.lastSeenAt != null -> stringResource(R.string.pf_last_seen, TimeFmt.relative(u.lastSeenAt))
                            else -> stringResource(R.string.pf_not_shown)
                        }
                        Text(shown, style = Griip.type.bodyMedium, color = if (u.online == true) c.success else c.textSecondary)
                    }
                    val here = ProfileCardRules.joinedHere(u, orgId)
                    if (u.memberSince != null || here != null) Section(stringResource(R.string.pf_member_since)) {
                        Row(horizontalArrangement = Arrangement.spacedBy(18.dp), verticalAlignment = Alignment.CenterVertically) {
                            u.memberSince?.let { t ->
                                val label = stringResource(R.string.pf_meldiq_since)
                                Row(Modifier.semantics(mergeDescendants = true) { contentDescription = "$label ${day(t)}" }, verticalAlignment = Alignment.CenterVertically) {
                                    Image(painterResource(R.drawable.meldling_glyph), null, Modifier.size(20.dp), colorFilter = androidx.compose.ui.graphics.ColorFilter.tint(c.primary))
                                    Spacer(Modifier.width(6.dp))
                                    Text(day(t), style = Griip.type.bodyMedium, color = c.textPrimary)
                                }
                            }
                            here?.let { o ->
                                val label = stringResource(R.string.pf_joined_here, o.name)
                                Row(Modifier.semantics(mergeDescendants = true) { contentDescription = "$label ${day(o.joinedAt)}" }, verticalAlignment = Alignment.CenterVertically) {
                                    OrgMark(o.id, o.name, o.id.hashCode(), o.photoRev, size = 20.dp)
                                    Spacer(Modifier.width(6.dp))
                                    Text(day(o.joinedAt), style = Griip.type.bodyMedium, color = c.textPrimary)
                                }
                            }
                        }
                    }
                    if (roles.isNotEmpty()) Section(stringResource(R.string.pf_roles)) {
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            roles.forEach { r -> Chip(r.name, dot = com.meldiq.android.data.model.LookRules.argb(r.color)?.let { Color(it) } ?: c.textTertiary) }
                        }
                    }
                    val mutual = u.mutualCommunities.orEmpty()
                    if (mutual.isNotEmpty()) {
                        Row(
                            Modifier.fillMaxWidth().padding(top = 10.dp).clip(Shapes.card).background(c.background).padding(horizontal = 14.dp, vertical = 12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Box(Modifier.width((22 + 16 * (minOf(mutual.size, 3) - 1)).dp).height(26.dp)) {
                                mutual.take(3).forEachIndexed { i, o ->
                                    Box(Modifier.offset(x = (16 * i).dp).clip(Shapes.iconTile).border(2.dp, c.background, Shapes.iconTile)) {
                                        OrgMark(o.id, o.name, o.id.hashCode(), o.photoRev, size = 26.dp)
                                    }
                                }
                            }
                            Spacer(Modifier.width(12.dp))
                            Text(
                                if (mutual.size == 1) stringResource(R.string.pf_mutual_one) else stringResource(R.string.pf_mutual, mutual.size),
                                style = Griip.type.bodyMedium, color = c.textPrimary,
                            )
                        }
                    }
                    if (!self && blocked != true) MessageBox(u) { text ->
                        scope.launch {
                            runCatching {
                                val dm = container.conversations.openDm(u.id)
                                if (text.isNotBlank()) container.messages.sendText(dm.id, text.trim())
                                dm.id
                            }.onSuccess { nav.navigate(Routes.conversation(it)) }.onFailure { error = it.friendly() }
                        }
                    }
                }
            }
        }
        // What they chose to show this account (the server leaves out everything else).
        val birthday = com.meldiq.android.data.model.ProfileRules.Birthday.parse(u.birthday)
        if (birthday != null || u.phone != null) item(key = "private") {
            val ctx = LocalContext.current
            GlassCard(Modifier.fillMaxWidth().padding(vertical = 8.dp), contentPadding = PaddingValues(4.dp)) {
                birthday?.let { MenuRow(Icons.Outlined.Cake, it.display(), subtitle = "Birthday", trailing = null) }
                u.phone?.let { ph ->
                    MenuRow(
                        Icons.Outlined.Phone, ph, subtitle = "Phone · not verified by Meldiq · tap to dial",
                        onClick = { runCatching { ctx.startActivity(android.content.Intent(android.content.Intent.ACTION_DIAL, android.net.Uri.parse("tel:$ph"))) } },
                    )
                }
            }
        }
        // A changed security key still pauses messages with this person until it's reviewed here.
        if (local?.identityChanged == true) item(key = "key") {
            GlassCard(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconTile(Icons.Rounded.GppMaybe, c.warning, c.warningSoft, size = 42.dp)
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text(stringResource(R.string.wp_key_changed_title), style = Griip.type.titleSmall, color = c.textPrimary)
                        Text(stringResource(R.string.wp_key_changed_body, u.displayName), style = Griip.type.caption, color = c.textSecondary)
                    }
                }
                Spacer(Modifier.height(12.dp))
                PillButton(stringResource(R.string.wp_key_confirm), {
                    // Pin exactly the key this profile shows, not whatever the server returns next.
                    val shown = u.identityKey ?: return@PillButton
                    scope.launch { container.messages.acceptIdentity(userId, shown) }
                }, Modifier.fillMaxWidth(), height = 46.dp)
            }
        }
    }
    if (reporting) user?.let { who ->
        com.meldiq.android.ui.screens.moderation.ReportSheet(
            com.meldiq.android.ui.screens.moderation.ReportTarget(userId = userId, name = who.displayName), onDismiss = { reporting = false },
        )
    }
    if (inviting) user?.let { who ->
        InviteToCommunitySheet(userId, who.displayName, onDismiss = { inviting = false }, onSent = { cid -> inviting = false; nav.navigate(Routes.conversation(cid)) })
    }
}

private val BANNER = 128.dp
private val AVATAR = 88.dp
private val AVATAR_OVERHANG = 54.dp

private fun day(t: Long): String = DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(t))

/** A rounded section on the frame's near-black, with a small capitalised heading. */
@Composable
private fun Section(title: String, content: @Composable ColumnScope.() -> Unit) {
    val c = Griip.colors
    Column(Modifier.fillMaxWidth().padding(top = 10.dp).clip(Shapes.card).background(c.background).padding(horizontal = 14.dp, vertical = 12.dp)) {
        Text(
            title.uppercase(), style = Griip.type.caption.copy(fontWeight = FontWeight.Bold, letterSpacing = 0.6.sp), color = c.textTertiary,
            modifier = Modifier.padding(bottom = 6.dp).semantics { heading() },
        )
        content()
    }
}

/** A small chip: a coloured dot (a role's or tag's colour) or an icon, then its text; [accent] for the Mojo badge. */
@Composable
private fun Chip(text: String, dot: Color? = null, icon: androidx.compose.ui.graphics.vector.ImageVector? = null, accent: Boolean = false) {
    val c = Griip.colors
    Row(
        Modifier.clip(Shapes.pill).background(if (accent) c.primarySoft else c.surfaceVariant).padding(horizontal = 10.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        dot?.let { Box(Modifier.size(9.dp).clip(CircleShape).background(it)); Spacer(Modifier.width(6.dp)) }
        icon?.let { Icon(it, null, tint = if (accent) c.primary else c.textSecondary, modifier = Modifier.size(14.dp)); Spacer(Modifier.width(5.dp)) }
        Text(text, style = Griip.type.caption.copy(fontWeight = FontWeight.SemiBold), color = if (accent) c.primary else c.textPrimary, maxLines = 1)
    }
}

/** "Message @username": sends the text in your DM with them (or just opens it when empty). */
@Composable
private fun MessageBox(u: UserDto, onSend: (String) -> Unit) {
    val c = Griip.colors
    var draft by remember { mutableStateOf("") }
    val send = { onSend(draft); draft = "" }
    Row(
        Modifier.fillMaxWidth().padding(top = 14.dp).heightIn(min = 52.dp).clip(Shapes.pill).background(c.background).border(1.dp, c.border, Shapes.pill)
            .padding(start = 18.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val hint = stringResource(R.string.pf_message_hint, u.username)
        Box(Modifier.weight(1f)) {
            if (draft.isEmpty()) Text(hint, style = Griip.type.body, color = c.textTertiary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            BasicTextField(
                draft, { draft = it.take(MESSAGE_MAX) }, Modifier.fillMaxWidth().semantics { contentDescription = hint },
                textStyle = Griip.type.body.copy(color = c.textPrimary), cursorBrush = SolidColor(c.primary), maxLines = 4,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send), keyboardActions = KeyboardActions(onSend = { send() }),
            )
        }
        CircleIconButton(Icons.AutoMirrored.Rounded.Send, stringResource(R.string.pf_send, u.displayName), send, tint = c.onAction, background = c.actionStart, size = 42.dp)
    }
}

/** The longest text the box takes; the server still applies the plan's limit. */
private const val MESSAGE_MAX = 4000
