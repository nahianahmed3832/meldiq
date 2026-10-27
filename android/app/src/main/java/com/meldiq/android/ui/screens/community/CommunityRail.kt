package com.meldiq.android.ui.screens.community

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Explore
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material.icons.rounded.KeyboardArrowUp
import androidx.compose.material.icons.rounded.VerticalAlignTop
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.meldiq.android.R
import com.meldiq.android.data.api.OrgDto
import com.meldiq.android.ui.components.OrgMark
import com.meldiq.android.ui.components.pressable
import com.meldiq.android.ui.screens.workspace.WorkspaceList
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Shapes

/** The rail's width: room for a 48 dp tile with the selection bar beside it. */
val RailWidth = 72.dp
private val TileSize = 48.dp
/** Communities are rounded squares, people are circles (the reference's shape rule, in Meldiq's own radii). */
private val TileShape = RoundedCornerShape(14.dp)

/**
 * Home's community rail (docs/product/MELDIQ_COMMUNITY_CHAT_SPEC.md §2): your communities top to bottom, the selected
 * one marked by a tall bar at the start edge and a ring; something unread by a short bar; unread mentions by a count.
 * Below a divider: Join or create, and Discover (when the server has public communities).
 */
@Composable
fun CommunityRail(
    orgs: List<OrgDto>,
    selectedId: String?,
    badges: Map<String, RailBadge>,
    onSelect: (String) -> Unit,
    onAdd: () -> Unit,
    onDiscover: (() -> Unit)?,
    modifier: Modifier = Modifier,
    /** Long-press on a community: arrange the rail (batch B2); null when the server can't keep the order. */
    onArrange: (() -> Unit)? = null,
    contentPadding: PaddingValues = PaddingValues(0.dp),
) {
    val c = Griip.colors
    LazyColumn(
        modifier.width(RailWidth).fillMaxHeight().background(c.background),
        contentPadding = PaddingValues(top = 8.dp + contentPadding.calculateTopPadding(), bottom = 12.dp + contentPadding.calculateBottomPadding()),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        items(orgs, key = { it.id }) { o ->
            RailTile(o, o.id == selectedId, badges[o.id], onClick = { onSelect(o.id) }, onLongClick = onArrange)
        }
        item(key = "divider") {
            Box(Modifier.padding(vertical = 6.dp).width(32.dp).height(2.dp).clip(Shapes.pill).background(c.border))
        }
        item(key = "add") { RailAction(Icons.Rounded.Add, stringResource(R.string.nv_rail_add), onAdd) }
        if (onDiscover != null) item(key = "discover") { RailAction(Icons.Outlined.Explore, stringResource(R.string.cm_discover), onDiscover) }
    }
}

@Composable
private fun RailTile(o: OrgDto, selected: Boolean, badge: RailBadge?, onClick: () -> Unit, onLongClick: (() -> Unit)?) {
    val c = Griip.colors
    // API 0.44.0: the selected ring in the community's own accent (as Meldiq Web), scoped to its own icon.
    val accent = com.meldiq.android.data.model.AccentRules.colors(o.accent)?.let { androidx.compose.ui.graphics.Color(it.fill) }
    val ring by animateColorAsState(if (selected) accent ?: c.primary else androidx.compose.ui.graphics.Color.Transparent, label = "railRing")
    // Selected: a tall bar; unread: a short one; nothing new: none (the reference's pill, in Meldiq's accent).
    val bar by animateDpAsState(
        when {
            selected -> 36.dp
            badge?.unread == true || (badge?.mentions ?: 0) > 0 -> 8.dp
            else -> 0.dp
        },
        label = "railBar",
    )
    val mentions = badge?.mentions ?: 0
    val described = when {
        mentions > 0 -> stringResource(R.string.nv_rail_mentions, o.name, mentions)
        badge?.unread == true -> stringResource(R.string.nv_rail_unread, o.name)
        else -> o.name
    }
    Box(Modifier.width(RailWidth).padding(vertical = 4.dp), contentAlignment = Alignment.Center) {
        Box(
            Modifier.align(Alignment.CenterStart).width(4.dp).height(bar)
                .clip(RoundedCornerShape(topEnd = 4.dp, bottomEnd = 4.dp)).background(c.textPrimary),
        )
        Box(
            Modifier.size(TileSize + 6.dp).border(2.dp, ring, RoundedCornerShape(16.dp)).padding(3.dp)
                .clip(TileShape)
                .combinedClickable(
                    onClick = onClick,
                    onClickLabel = stringResource(R.string.m2_rail_switch, o.name),
                    onLongClick = onLongClick,
                    onLongClickLabel = if (onLongClick != null) stringResource(R.string.rail_arrange) else null,
                )
                .semantics { this.selected = selected; contentDescription = described },
        ) {
            OrgMark(o.id, o.name, WorkspaceList.colorSeed(o), o.photoRev, size = TileSize)
        }
        if (mentions > 0) {
            Box(
                Modifier.align(Alignment.BottomEnd).padding(end = 6.dp, bottom = 2.dp)
                    .clip(Shapes.pill).background(c.background).padding(2.dp)
                    .clip(Shapes.pill).background(c.badge).widthIn(min = 18.dp).padding(horizontal = 5.dp, vertical = 1.dp),
                contentAlignment = Alignment.Center,
            ) {
                // As Meldiq Web: a mention reads apart from plain unread by its "@" as well as its colour.
                Text("@" + com.meldiq.android.data.model.UnreadRules.cap(mentions), style = Griip.type.caption.copy(fontWeight = FontWeight.Bold), color = c.onBadge)
            }
        }
    }
}

@Composable
private fun RailAction(icon: ImageVector, label: String, onClick: () -> Unit) {
    val c = Griip.colors
    Box(Modifier.width(RailWidth).padding(vertical = 4.dp), contentAlignment = Alignment.Center) {
        Box(
            Modifier.size(TileSize).clip(TileShape).background(c.surfaceVariant).pressable(onClick, onClickLabel = label).semantics { contentDescription = label },
            contentAlignment = Alignment.Center,
        ) { Icon(icon, null, tint = c.success) }
    }
    Spacer(Modifier.height(0.dp))
}

/**
 * Arrange communities (batch B2, NAV-11): the rail's order with Move up, Move down and Move to the top on each row.
 * Every move saves the whole order, kept for all the person's devices in the personal preferences document.
 */
@Composable
fun ArrangeCommunitiesSheet(orgs: List<OrgDto>, onOrder: (List<String>) -> Unit, onDismiss: () -> Unit) {
    val c = Griip.colors
    val ids = orgs.map { it.id }
    com.meldiq.android.ui.components.GlassSheet(onDismiss, title = stringResource(R.string.rail_arrange)) {
        Text(stringResource(R.string.rail_arrange_body), style = Griip.type.bodySmall, color = c.textSecondary, modifier = Modifier.padding(bottom = 8.dp))
        LazyColumn(Modifier.heightIn(max = 480.dp)) {
            items(orgs, key = { it.id }) { o ->
                val i = ids.indexOf(o.id)
                androidx.compose.foundation.layout.Row(Modifier.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    OrgMark(o.id, o.name, WorkspaceList.colorSeed(o), o.photoRev, size = 36.dp)
                    Spacer(Modifier.width(12.dp))
                    Text(o.name, style = Griip.type.bodyMedium, color = c.textPrimary, maxLines = 1, modifier = Modifier.weight(1f))
                    com.meldiq.android.ui.components.CircleIconButton(
                        Icons.Rounded.VerticalAlignTop, stringResource(R.string.rail_move_top, o.name),
                        { onOrder(com.meldiq.android.data.model.NavPrefsRules.moved(ids, o.id, 0, toTop = true)) }, enabled = i > 0,
                    )
                    com.meldiq.android.ui.components.CircleIconButton(
                        Icons.Rounded.KeyboardArrowUp, stringResource(R.string.rail_move_up, o.name),
                        { onOrder(com.meldiq.android.data.model.NavPrefsRules.moved(ids, o.id, -1)) }, enabled = i > 0,
                    )
                    com.meldiq.android.ui.components.CircleIconButton(
                        Icons.Rounded.KeyboardArrowDown, stringResource(R.string.rail_move_down, o.name),
                        { onOrder(com.meldiq.android.data.model.NavPrefsRules.moved(ids, o.id, 1)) }, enabled = i < ids.size - 1,
                    )
                }
            }
        }
        Spacer(Modifier.height(8.dp))
    }
}
