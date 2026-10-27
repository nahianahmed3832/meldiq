package com.meldiq.android.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Motion

private val BarHeight = 64.dp
private val BarShape = RoundedCornerShape(32.dp)
private val ItemShape = RoundedCornerShape(24.dp)

/**
 * The bottom navigation (UI-002, restyled 2026-10-19 after the owner's reference): a full-width bar on the surface
 * colour with a hairline above it and the tabs (Home, DMs, Activity). The selected tab's icon sits in a soft pill in the
 * palette's indicator colour with a bold label; the others are quiet. No action button: each screen offers its own New
 * action. It's drawn over the screens: tab screens keep [com.meldiq.android.ui.LocalTabBarPadding] below their content.
 */
@Composable
fun FloatingNavBar(
    items: List<NavItem>,
    selectedRoute: String?,
    onSelect: (NavItem) -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = Griip.colors
    Column(modifier.fillMaxWidth().background(c.surface)) {
        Box(Modifier.fillMaxWidth().height(1.dp).background(c.border))
        Row(
            Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 8.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.Center,
        ) {
            Row(
                Modifier.weight(1f, fill = false).widthIn(max = 520.dp).heightIn(min = BarHeight).selectableGroup(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                items.forEach { item -> NavTab(item, item.route == selectedRoute, Modifier.weight(1f)) { onSelect(item) } }
            }
        }
    }
}

@Composable
private fun NavTab(item: NavItem, selected: Boolean, modifier: Modifier, onTap: () -> Unit) {
    val c = Griip.colors
    val fg by animateColorAsState(if (selected) c.textPrimary else c.textSecondary, Motion.quick(), label = "navTabFg")
    val iconTint by animateColorAsState(if (selected) c.primary else c.textSecondary, Motion.quick(), label = "navTabIcon")
    val pill by animateColorAsState(if (selected) c.navIndicator else Color.Transparent, Motion.quick(), label = "navTabPill")
    val description = if (item.badge > 0) "${item.label}, ${item.badge}" else item.label
    Column(
        modifier
            .heightIn(min = 52.dp)
            .clip(ItemShape)
            .selectable(selected = selected, onClick = onTap, role = Role.Tab)
            // One node for TalkBack: "DMs, 3, tab, selected". The cleared node needs its own click action.
            .clearAndSetSemantics {
                contentDescription = description
                this.selected = selected
                role = Role.Tab
                onClick { onTap(); true }
            }
            .padding(vertical = 6.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Box(Modifier.clip(ItemShape).background(pill).padding(horizontal = 18.dp, vertical = 4.dp)) {
            val glyph = item.glyph
            if (glyph != null) Icon(androidx.compose.ui.res.painterResource(glyph), null, tint = iconTint, modifier = Modifier.size(22.dp))
            else Icon(if (selected) item.selectedIcon else item.icon, null, tint = iconTint, modifier = Modifier.size(22.dp))
            if (item.badge > 0) {
                Box(
                    Modifier.align(Alignment.TopEnd).offset(x = 12.dp, y = (-6).dp).heightIn(min = 16.dp).widthIn(min = 16.dp)
                        .clip(CircleShape).background(c.badge).padding(horizontal = 4.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(if (item.badge > 99) "99+" else "${item.badge}", style = Griip.type.caption.copy(fontWeight = FontWeight.Bold), color = c.onBadge, maxLines = 1)
                }
            }
        }
        Spacer(Modifier.height(2.dp))
        Text(
            item.label, style = Griip.type.caption.copy(fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium),
            color = fg, maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
    }
}
