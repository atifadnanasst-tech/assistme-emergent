# AssistMe Deployment, Channel & Maintenance Protocol

Living document. Append new durable practices here as they're established —
this file exists specifically so lessons learned don't drift away or get
relearned the hard way twice.

---

## 1. Channel Strategy — Staged Rollout ("Green/Blue")

### STATUS: DOCUMENTED, NOT YET ACTIVE

Confirmed with Atif (Sept 2026): this section describes the *target*
workflow, not the current one. As of this writing, every OTA update is
still pushed to both `production` and `preview` channels simultaneously —
`preview` is effectively a mirror of `production`, not an independent
testing lane. Do not start the split described below until BOTH of these
are true:

1. The app is genuinely live to real customers — via the Play Store
   listing, the self-hosted download link (`api.ummate.com/download/`),
   or both.
2. Atif's own daily-use device has been switched to explicitly track the
   `preview` channel, separate from whatever real customers are on.

**Until both conditions are met, keep pushing to both channels together
exactly as before.** Do not introduce this split unprompted.

**The trigger for Claude specifically:** the next time Atif returns to
active feature work (not distribution, not bug fixes to what's already
live) after those two conditions are met, ask directly whether to begin
the split described below, rather than assuming either that it should
start or that it shouldn't.

### The model, once active

Two channels, fixed identity, content flows one direction only:

- **`production`** — what real customers have installed. Frozen during
  active feature work. Only updated once a feature has been explicitly
  confirmed ready by Atif.
- **`preview`** — where all new feature work ships first, exclusively.
  Atif's own testing device tracks this channel.

Once `preview` is confirmed stable, the *same, already-validated* code is
published to `production` — the channels never swap identity or get
repointed to each other. Content flows forward from staging into
production; the labels never change what they mean.

**In practice, per patch, once active:**
- Push to `preview` only. Do not push to `production` in the same step.
- Wait for Atif's explicit confirmation the feature is good.
- Only then run the `production` push, publishing the same code preview
  already validated.

### The one real risk this creates — read before making backend changes during active staging

EAS channels only control which JavaScript bundle a device downloads.
They have **no effect on the backend or database** — there is one Hetzner
server and one Supabase database, serving every device on every channel.

This means: **a backend change made to support a new `preview` feature
goes live for every `production` user immediately too**, even though they
haven't received the frontend change yet. If that backend change isn't
backward-compatible with what the old, still-live `production` frontend
expects, it can silently break real, paying customers who have no
visibility into the staging work at all.

**Rule, once the channel split is active:** any backend change made in
support of a `preview`-only feature must be additive (new routes, new
optional fields, new columns with safe defaults) rather than replacing or
altering the behavior of anything the current `production` frontend
depends on — until that frontend has actually been promoted and the old
behavior is confirmed no longer in use.

---

## 2. Native Builds vs. OTA Updates — What Needs What

Two genuinely different operations, easy to conflate:

- **`eas update`** (OTA) — pushes JavaScript/asset changes only, to
  whichever channel is targeted. Reaches everyone already running a
  native build with a *matching* `runtimeVersion`, automatically, the
  next time their app checks in. This is what nearly all of today's
  patches were.
- **`eas build`** (native) — produces an actual new installable binary
  (APK/AAB). Only needed for genuine native changes: new native modules,
  Expo SDK upgrades, new permissions, anything that isn't pure JS/assets.

**`app.json`'s `version` field and `runtimeVersion` policy (`appVersion`)
must NOT be bumped on every OTA patch.** Confirmed by checking this
project's actual config: `version` correctly stayed at `1.0.2` through
15+ OTA increments in a single session — this is exactly why every
update reached devices correctly. Bumping the app version on every patch
would change `runtimeVersion` every time too, silently breaking OTA
delivery to already-installed devices. The two version numbers displayed
in the app (Home → 3-dot menu → bottom) are deliberately separate for
this exact reason: "App Version" (real, store-facing, from `app.json`)
and "Build v1.3.XXX" (internal per-patch OTA counter, bumped freely).

**The self-hosted download link (`api.ummate.com/download/assistme.apk`)
is a frozen file snapshot.** OTA updates reach anyone who already
installed via that link automatically (their app checks in at runtime,
independent of the static file). The file itself only needs manually
refreshing (rebuild → download once → overwrite on server) when a
genuinely new *native* build happens — not for routine OTA pushes.

---

## 3. Git Discipline — Deploy and Commit Are One Step, Not Two

**Lesson learned twice in one session (Sept 2026), both times caught only
by `git status` after the fact, not prevented in advance:** a live
deploy+reload on Hetzner was applied directly to disk without a
corresponding git commit, twice, because attention moved to the next
piece of work before the commit happened.

**Rule:** immediately after every `pm2 reload` (or any live deploy),
run `git status` before doing anything else. If it shows modified files,
commit them right then — not after the next feature, not "in a bit."
A deploy and its commit are one atomic unit of work, not two separate
steps that can be separated by other work in between.

---

## 4. Verify Against Live State, Not Memory

**Rule, reinforced repeatedly this session:** before editing any file
already touched earlier in a session, re-fetch it fresh from the actual
source (GitHub `main`/`dev`, or the live server directly) rather than
trusting a local sandbox copy from several messages ago. A `diff` against
the fresh fetch confirms whether drift happened — this check is cheap;
discovering drift after a patch has already been written against stale
content is not.

This applies especially after any point where a live deploy happened
outside the normal git-commit flow (see §3) — the local sandbox and the
live server can silently diverge exactly when it matters least to have
that happen unnoticed.

---

## 5. Regression Testing — Test the Code Around the Change, Not Just the Change

**Confirmed valuable twice this session, both times catching a real bug
before it shipped:** when a shared constant or shared function's
structure changes (e.g., `PLAN_IDS` going from a flat map to a
tier-and-cycle nested structure), write a regression test for the
*existing*, supposedly-untouched code that also reads that constant —
not just tests for the new code path. Both real bugs caught this session
(`changeSubscriptionTier`'s broken lookup, and its own fallback silently
downgrading a yearly subscriber to monthly) were in code that was never
intentionally modified — they broke because something they depended on
changed shape elsewhere.

---

*Last updated: September 2026. Add to this document as new durable
practices are established — that is its entire purpose.*
