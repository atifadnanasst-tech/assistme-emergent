#!/usr/bin/env python3
"""
Patch: Filter pill color swap — selected pill now high-contrast (white fill)
against the green filter bar, unselected pills recede (green fill, white
border for tap affordance). Style-only change, no data/logic impact.
"""

import sys

PATH = "frontend/app/home.tsx"

with open(PATH, "r") as f:
    content = f.read()

anchor = """  filterTab: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#075E54',
    borderRadius: 20,
    paddingVertical: 8,
    paddingHorizontal: 16,
    marginRight: 8,
  },
  filterTabActive: {
    backgroundColor: '#075E54',
    borderColor: '#FFFFFF',
  },
  filterTabText: {
    fontSize: 14,
    color: '#075E54',
    fontWeight: '500',
  },
  filterTabTextActive: {
    color: '#FFFFFF',
  },"""

new = """  filterTab: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#075E54',
    borderWidth: 1,
    borderColor: '#FFFFFF',
    borderRadius: 20,
    paddingVertical: 8,
    paddingHorizontal: 16,
    marginRight: 8,
  },
  filterTabActive: {
    backgroundColor: '#FFFFFF',
    borderColor: '#075E54',
  },
  filterTabText: {
    fontSize: 14,
    color: '#FFFFFF',
    fontWeight: '500',
  },
  filterTabTextActive: {
    color: '#075E54',
  },"""

count = content.count(anchor)
if count != 1:
    print(f"ABORT: anchor found {count} times (expected exactly 1). No changes written.")
    sys.exit(1)

content = content.replace(anchor, new, 1)

with open(PATH, "w") as f:
    f.write(content)

print("Pill color swap applied successfully.")
