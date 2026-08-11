#!/usr/bin/env python3
"""
Patch: Home menu honesty pass (Step 1 of Home Menu Audit). See
ASSISTME_V2_ARCHITECTURAL_BACKLOG.md -> "Home Menu Audit".

Makes both home-screen menus honest before deployment: no dead buttons, no
futile round-trips to stub screens. Every muted item is kept as a grep-able
{/* MUTED-v1 ... */} comment so future sessions can find and restore it.

All changes are in frontend/app/home.tsx. Frontend-only, no backend, no new
features. Build items (Search, Billing, Export, Tutorials, Disclaimer,
Dashboard screen) are intentionally NOT frozen here; they keep routing to
their current targets because they're being built soon (avoid churn).
"""

import sys

PATH = "frontend/app/home.tsx"

with open(PATH, "r") as f:
    content = f.read()

replacements = []

# A. Header — hide dead checkmark-done icon (keep Search as-is)
anchor_a = """            <TouchableOpacity style={styles.headerIcon}>
              <Ionicons name="search-outline" size={24} color="#FFFFFF" />
            </TouchableOpacity>
            <TouchableOpacity style={styles.headerIcon}>
              <Ionicons name="checkmark-done-outline" size={24} color="#FFFFFF" />
            </TouchableOpacity>"""

new_a = """            {/* Search: build item (near-term) — left visible/inert per audit decision (a) */}
            <TouchableOpacity style={styles.headerIcon}>
              <Ionicons name="search-outline" size={24} color="#FFFFFF" />
            </TouchableOpacity>
            {/* MUTED-v1: checkmark-done header icon — dead button, no user-expected
                meaning, no implementation. See ASSISTME_V2_ARCHITECTURAL_BACKLOG.md
                -> "Home Menu Audit". Restore only if a real mark-all-read/filter is built.
            <TouchableOpacity style={styles.headerIcon}>
              <Ionicons name="checkmark-done-outline" size={24} color="#FFFFFF" />
            </TouchableOpacity>
            */}"""

replacements.append(("A", anchor_a, new_a))

# B. Pill row — hide dead "+" add-custom-list button
anchor_b = """          {/* Add custom list button */}
          <TouchableOpacity style={styles.addTabButton}>
            <Ionicons name="add" size={20} color="#075E54" />
          </TouchableOpacity>"""

new_b = """          {/* MUTED-v1: pill "+" add-custom-list button — dead button (no onPress);
              the customer-bucketing feature it implies is unbuilt (same feature as
              the Lists menu entry). Hidden until bucketing ships. See
              ASSISTME_V2_ARCHITECTURAL_BACKLOG.md -> "Home Menu Audit".
          <TouchableOpacity style={styles.addTabButton}>
            <Ionicons name="add" size={20} color="#075E54" />
          </TouchableOpacity>
          */}"""

replacements.append(("B", anchor_b, new_b))

# C. 3-dot menu — full rebuild, categorized + frozen coming-soon
anchor_c = """          <View style={styles.menuCard}>
            <Text style={styles.menuSection}>COMMUNICATION</Text>
            <TouchableOpacity 
              style={styles.menuItem}
              onPress={() => {
                setShowThreeDotMenu(false);
                router.push('/group/new');
              }}
            >
              <Ionicons name="people-outline" size={20} color="#667781" />
              <Text style={styles.menuItemText}>New Group</Text>
            </TouchableOpacity>
            <TouchableOpacity 
              style={styles.menuItem}
              onPress={() => {
                setShowThreeDotMenu(false);
                router.push('/broadcast/new');
              }}
            >
              <Ionicons name="megaphone-outline" size={20} color="#667781" />
              <Text style={styles.menuItemText}>Broadcast</Text>
            </TouchableOpacity>
            <TouchableOpacity 
              style={styles.menuItem}
              onPress={() => {
                setShowThreeDotMenu(false);
                router.push('/lists');
              }}
            >
              <Ionicons name="list-outline" size={20} color="#667781" />
              <Text style={styles.menuItemText}>Lists</Text>
            </TouchableOpacity>

            <View style={styles.menuDivider} />
            <Text style={styles.menuSection}>BUSINESS OPERATIONS</Text>
            <TouchableOpacity 
              style={styles.menuItem}
              onPress={() => {
                setShowThreeDotMenu(false);
                router.push('/settings/devices');
              }}
            >
              <Ionicons name="phone-portrait-outline" size={20} color="#667781" />
              <Text style={styles.menuItemText}>Linked Devices</Text>
            </TouchableOpacity>
            <TouchableOpacity 
              style={styles.menuItem}
              onPress={() => {
                setShowThreeDotMenu(false);
                router.push('/settings/team');
              }}
            >
              <Ionicons name="person-add-outline" size={20} color="#667781" />
              <Text style={styles.menuItemText}>Invite Team Members</Text>
            </TouchableOpacity>
            <TouchableOpacity 
              style={styles.menuItem}
              onPress={() => {
                setShowThreeDotMenu(false);
                router.push('/products');
              }}
            >
              <Ionicons name="cube-outline" size={20} color="#667781" />
              <Text style={styles.menuItemText}>See Inventory</Text>
            </TouchableOpacity>

            <View style={styles.menuDivider} />
            <Text style={styles.menuSection}>SYSTEM</Text>
            <TouchableOpacity 
              style={styles.menuItem}
              onPress={() => {
                setShowThreeDotMenu(false);
                setShowToolsSheet(true);
              }}
            >
              <Ionicons name="settings-outline" size={20} color="#667781" />
              <Text style={styles.menuItemText}>Settings</Text>
            </TouchableOpacity>
          </View>"""

new_c = """          {/* 3-dot menu rebuilt as an Operations hub (Home Menu Audit).
              Categorized for structure; all items are roadmap-committed and
              currently frozen "Coming soon" (non-navigating). Dashboard flips
              to a live entry when its screen is built. Removed vs. old menu:
              New Group (hidden), See Inventory (redundant with Products nav),
              Settings (lives on the bottom Tools sheet).
              MUTED-v1 removed items preserved as comments at end of this block. */}
          <View style={styles.menuCard}>
            <Text style={styles.menuSection}>BUSINESS OPERATIONS</Text>
            <View style={[styles.menuItem, styles.comingSoonRow]}>
              <Ionicons name="stats-chart-outline" size={20} color="#B0B0B0" />
              <Text style={styles.comingSoonItemText}>Dashboard</Text>
              <View style={styles.comingSoonBadge}><Text style={styles.comingSoonBadgeText}>Coming soon</Text></View>
            </View>
            <View style={[styles.menuItem, styles.comingSoonRow]}>
              <Ionicons name="megaphone-outline" size={20} color="#B0B0B0" />
              <Text style={styles.comingSoonItemText}>Broadcast</Text>
              <View style={styles.comingSoonBadge}><Text style={styles.comingSoonBadgeText}>Coming soon</Text></View>
            </View>

            <View style={styles.menuDivider} />
            <Text style={styles.menuSection}>ORGANISE</Text>
            <View style={[styles.menuItem, styles.comingSoonRow]}>
              <Ionicons name="list-outline" size={20} color="#B0B0B0" />
              <Text style={styles.comingSoonItemText}>Lists</Text>
              <View style={styles.comingSoonBadge}><Text style={styles.comingSoonBadgeText}>Coming soon</Text></View>
            </View>

            <View style={styles.menuDivider} />
            <Text style={styles.menuSection}>ACCESS & GROWTH</Text>
            <View style={[styles.menuItem, styles.comingSoonRow]}>
              <Ionicons name="phone-portrait-outline" size={20} color="#B0B0B0" />
              <Text style={styles.comingSoonItemText}>Linked Devices</Text>
              <View style={styles.comingSoonBadge}><Text style={styles.comingSoonBadgeText}>Coming soon</Text></View>
            </View>
            <View style={[styles.menuItem, styles.comingSoonRow]}>
              <Ionicons name="gift-outline" size={20} color="#B0B0B0" />
              <Text style={styles.comingSoonItemText}>Refer & Earn</Text>
              <View style={styles.comingSoonBadge}><Text style={styles.comingSoonBadgeText}>Coming soon</Text></View>
            </View>

            {/* MUTED-v1 (Home Menu Audit) — removed from this menu:
                New Group: WhatsApp-style group chat, not needed for AssistMe (hidden).
                See Inventory: redundant — Products is the bottom-nav 2nd tab.
                Settings: lives on the bottom Tools sheet (setShowToolsSheet).
                Note: "Invite Team Members" was a mislabel — it is a REFERRAL feature,
                now correctly named "Refer & Earn" above (distinct from staff/roles). */}
          </View>"""

replacements.append(("C", anchor_c, new_c))

# D1. Tools sheet — freeze "Manage staff & roles"
anchor_d1 = """              <TouchableOpacity style={styles.sheetItem} onPress={() => { setShowToolsSheet(false); router.push('/settings/staff'); }}>
                <Ionicons name="people-outline" size={24} color="#667781" />
                <Text style={styles.sheetItemText}>Manage staff & roles</Text>
                <Ionicons name="chevron-forward" size={20} color="#CCCCCC" />
              </TouchableOpacity>"""

new_d1 = """              {/* Manage staff & roles — coming-soon (frozen). Real feature
                  (multi-user, permissions) worth advertising; unbuilt in v1. */}
              <View style={[styles.sheetItem, styles.comingSoonRow]}>
                <Ionicons name="people-outline" size={24} color="#B0B0B0" />
                <Text style={styles.comingSoonSheetText}>Manage staff & roles</Text>
                <View style={styles.comingSoonBadge}><Text style={styles.comingSoonBadgeText}>Coming soon</Text></View>
              </View>"""

replacements.append(("D1", anchor_d1, new_d1))

# D2. Tools sheet — hide redundant "Smart Catalogs"
anchor_d2 = """              <TouchableOpacity style={styles.sheetItem} onPress={() => { setShowToolsSheet(false); router.push('/settings/catalogs'); }}>
                <Ionicons name="book-outline" size={24} color="#667781" />
                <Text style={styles.sheetItemText}>Smart Catalogs</Text>
                <Ionicons name="chevron-forward" size={20} color="#CCCCCC" />
              </TouchableOpacity>"""

new_d2 = """              {/* MUTED-v1 (Home Menu Audit): "Smart Catalogs" (-> /settings/catalogs)
                  hidden — redundant with the Products screen (bottom-nav 2nd tab,
                  the intentionally-built one with import + 3-dot tools). This route
                  led to a loosely-similar inferior page. Restore only if a distinct
                  catalog-config surface is ever needed.
              <TouchableOpacity style={styles.sheetItem} onPress={() => { setShowToolsSheet(false); router.push('/settings/catalogs'); }}>
                <Ionicons name="book-outline" size={24} color="#667781" />
                <Text style={styles.sheetItemText}>Smart Catalogs</Text>
                <Ionicons name="chevron-forward" size={20} color="#CCCCCC" />
              </TouchableOpacity>
              */}"""

replacements.append(("D2", anchor_d2, new_d2))

# D3. Tools sheet — freeze "Appearance" with descriptive badge
anchor_d3 = """              <TouchableOpacity style={styles.sheetItem} onPress={() => { setShowToolsSheet(false); router.push('/settings/appearance'); }}>
                <Ionicons name="color-palette-outline" size={24} color="#667781" />
                <Text style={styles.sheetItemText}>Appearance</Text>
                <Ionicons name="chevron-forward" size={20} color="#CCCCCC" />
              </TouchableOpacity>"""

new_d3 = """              {/* Appearance — coming-soon (frozen) with descriptive badge.
                  Current theme (Green–Cream) is intentional; more themes are roadmap. */}
              <View style={[styles.sheetItem, styles.comingSoonRow]}>
                <Ionicons name="color-palette-outline" size={24} color="#B0B0B0" />
                <Text style={styles.comingSoonSheetText}>Appearance</Text>
                <View style={styles.comingSoonBadge}><Text style={styles.comingSoonBadgeText}>Green–Cream · more coming soon</Text></View>
              </View>"""

replacements.append(("D3", anchor_d3, new_d3))

# D4. Tools sheet — freeze "Add Social Media"
anchor_d4 = """              <TouchableOpacity style={styles.sheetItem} onPress={() => { setShowToolsSheet(false); router.push('/settings/social'); }}>
                <Ionicons name="share-social-outline" size={24} color="#667781" />
                <Text style={styles.sheetItemText}>Add Social Media</Text>
                <Ionicons name="chevron-forward" size={20} color="#CCCCCC" />
              </TouchableOpacity>"""

new_d4 = """              {/* Add Social Media — coming-soon (frozen). Owner wants it; unbuilt in v1. */}
              <View style={[styles.sheetItem, styles.comingSoonRow]}>
                <Ionicons name="share-social-outline" size={24} color="#B0B0B0" />
                <Text style={styles.comingSoonSheetText}>Add Social Media</Text>
                <View style={styles.comingSoonBadge}><Text style={styles.comingSoonBadgeText}>Coming soon</Text></View>
              </View>"""

replacements.append(("D4", anchor_d4, new_d4))

# E. Styles — add reusable comingSoon row + badge
anchor_e = """  planBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#FFFFFF',
    letterSpacing: 0.5,
  },"""

new_e = """  planBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#FFFFFF',
    letterSpacing: 0.5,
  },
  // Coming-soon (frozen) treatment — Home Menu Audit. Muted row + inline badge,
  // no navigation. Reused across 3-dot menu and Tools sheet.
  comingSoonRow: {
    opacity: 0.55,
  },
  comingSoonItemText: {
    flex: 1,
    fontSize: 15,
    color: '#B0B0B0',
    marginLeft: 12,
  },
  comingSoonSheetText: {
    flex: 1,
    fontSize: 16,
    color: '#B0B0B0',
    marginLeft: 12,
  },
  comingSoonBadge: {
    backgroundColor: '#EEEEEE',
    borderRadius: 4,
    paddingVertical: 2,
    paddingHorizontal: 8,
  },
  comingSoonBadgeText: {
    fontSize: 10,
    fontWeight: '600',
    color: '#999999',
    letterSpacing: 0.3,
  },"""

replacements.append(("E", anchor_e, new_e))

for label, old, new in replacements:
    count = content.count(old)
    if count != 1:
        print(f"ABORT: anchor {label} found {count} times (expected exactly 1). No changes written.")
        sys.exit(1)

for label, old, new in replacements:
    content = content.replace(old, new, 1)

with open(PATH, "w") as f:
    f.write(content)

print("All patches applied successfully (A, B, C, D1, D2, D3, D4, E).")
