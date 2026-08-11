#!/usr/bin/env python3
"""
HOTFIX: v1.3.406 white-screen crash on launch. See
ASSISTME_V2_ARCHITECTURAL_BACKLOG.md -> "Home Menu Audit" -> Header Search.

Root cause: the Header Search debounce useEffect (added in the v1.3.406
patch) was placed AFTER an existing early conditional return
(`if (loading && !homeData) { return (...); }`). On the first render
(while loading), the component exits before ever calling that useEffect.
Once data loads and the component re-renders past that point, the
useEffect IS called -- for the first time, on a later render. This
violates React's Rules of Hooks (every hook must be called in the same
order on every render) and throws immediately, which is what produced the
white screen right as the loading state transitioned to real content.

Fix: move the useEffect to before the early return, alongside the other
unconditional hooks (right after the searchActive/searchQuery/
searchResults/searching state declarations). No behavior change intended
-- this is purely a hook-ordering fix, not a logic change.
"""

import sys

PATH = "frontend/app/home.tsx"

with open(PATH, "r") as f:
    content = f.read()

anchor_remove = """  const insightStrip = homeData?.insight_strip;
  const insightCards = homeData?.insight_cards || [];

  // Header Search, Tier 1 — debounced customer search (350ms, same pattern
  // as the Tutorials & Help screen). Empty query clears results without a
  // network call.
  useEffect(() => {
    if (!searchActive) return;
    const q = searchQuery.trim();
    if (!q) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const token = await authService.getAccessToken();
        if (!token) return;
        const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
        const res = await fetch(`${backendUrl}/api/customers/search?q=${encodeURIComponent(q)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const json = await res.json();
          setSearchResults(json.customers || []);
        }
      } catch (err) {
        console.error('Customer search error:', err);
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [searchQuery, searchActive]);

  const closeSearch = () => {
    setSearchActive(false);
    setSearchQuery('');
    setSearchResults([]);
  };

  return ("""

new_remove = """  const insightStrip = homeData?.insight_strip;
  const insightCards = homeData?.insight_cards || [];

  return ("""

count1 = content.count(anchor_remove)
if count1 != 1:
    print(f"ABORT: removal anchor found {count1} times (expected exactly 1). No changes written.")
    sys.exit(1)

content = content.replace(anchor_remove, new_remove, 1)

anchor_insert = """  const [searching, setSearching] = useState(false);"""

new_insert = """  const [searching, setSearching] = useState(false);

  // Header Search, Tier 1 — debounced customer search (350ms, same pattern
  // as the Tutorials & Help screen). Empty query clears results without a
  // network call. MOVED HERE (hotfix): must be unconditional, before the
  // `if (loading && !homeData) return (...)` early return below -- every
  // hook must run in the same order on every render (Rules of Hooks).
  // Placing it after that early return caused a white-screen crash on
  // launch, since the hook wasn't called during the initial loading render
  // but WAS called on the next render once data arrived.
  useEffect(() => {
    if (!searchActive) return;
    const q = searchQuery.trim();
    if (!q) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const token = await authService.getAccessToken();
        if (!token) return;
        const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
        const res = await fetch(`${backendUrl}/api/customers/search?q=${encodeURIComponent(q)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const json = await res.json();
          setSearchResults(json.customers || []);
        }
      } catch (err) {
        console.error('Customer search error:', err);
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [searchQuery, searchActive]);

  const closeSearch = () => {
    setSearchActive(false);
    setSearchQuery('');
    setSearchResults([]);
  };"""

count2 = content.count(anchor_insert)
if count2 != 1:
    print(f"ABORT: insertion anchor found {count2} times (expected exactly 1). No changes written.")
    sys.exit(1)

content = content.replace(anchor_insert, new_insert, 1)

with open(PATH, "w") as f:
    f.write(content)

print("Hotfix applied: useEffect moved before the early conditional return.")
