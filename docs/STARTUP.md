# Warboard — Getting started for new factions

Welcome. Warboard runs two independent services for the Torn community:

- **FactionOps** — real-time war coordination (target calls, chain bar, hospital alerts, scout reports, post-war analytics, mobile apps with push)
- **OC Spawn Assistance** — automated organized-crime slot filling, ready-to-spawn signals, banker-claim flow

Each is granted independently by the warboard owner. Confirm with RussianRob [137558] which services your faction has access to, then jump to the matching section below.

---

## Pick your path

| You have | Read |
|---|---|
| **FactionOps only** | [Section A: FactionOps setup](#section-a-factionops-setup) |
| **OC Spawn only** | [Section B: OC Spawn setup](#section-b-oc-spawn-setup) |
| **Both** | Section A, then Section B |

Common reference at the end: subscription tiers, common issues, and how to ask for help.

---

## Section A: FactionOps setup

### A1. Install the userscript

1. Install **Tampermonkey** in Chrome / Edge / Firefox (Chrome Web Store: search "Tampermonkey")
2. Open <https://tornwar.com/scripts/factionops.user.js>
3. Tampermonkey shows an install prompt — click **Install**
4. Reload `torn.com` and navigate to your faction page
5. The FactionOps overlay appears with a gear icon (⚙) in the top-right

### A2. Authenticate

When the overlay first loads, it asks for your **Torn API key**. Use a **Limited Access** key — never a Full key.

Generate one at <https://www.torn.com/preferences.php#tab=api>:
- Click **Create a new key**
- Pick **Limited Access**
- Recommended selections: `attacks`, `bars`, `cooldowns`, `profile`, `travel`, `chain`, `members`, `armorynews`
- Paste into FactionOps' settings

Click ⚙ to open settings. The connection dot should turn green. The **Subscription** line shows your status:
- **★ Permanent** — owner faction or partner with FactionOps grant
- **N days remaining** — xanax-paying faction
- **expired / unknown** — contact the warboard owner

### A3. Configure admin roles (one-time, faction admin)

By default only `Leader` and `Co-leader` see admin-only panels (Members bars, post-war report, broadcasts). To delegate, configure the **Admin Roles** list.

In FactionOps:
1. ⚙ Settings → **Custom Admin Roles**
2. Type comma-separated role names: `leader, co-leader, banker, warmaster`
3. Save

This list gates: Member bars / cooldowns view, post-war report, shout / broadcast.

### A4. Install the mobile apps (optional, recommended)

| Platform | How |
|---|---|
| **iOS** | TestFlight invite from RussianRob [137558] |
| **Android** | Download <https://tornwar.com/warboard.apk> and install (allow unknown sources) |

The apps add:
- Live Activity / Dynamic Island chain timer (iOS)
- Push notifications: chain panic, target hospitalized, target called, war started/ended
- Coordination from your phone without an open browser tab

### A5. Opt into the faction key pool (recommended)

Warboard polls Torn for chain status, hospital events, attack feeds, and war scores. To avoid burning a single key's 100 calls/min quota, members can opt their key into a **shared pool** that warboard rotates through.

**Recommendation**: encourage 5+ members to opt in. Spreads polling load and means you survive any one member being offline / their key being revoked. Use **Limited keys** only.

The setting is in FactionOps ⚙ Settings → **Share my API key with faction pool**.

### A6. FactionOps-specific issues

| Symptom | Likely cause | Fix |
|---|---|---|
| "Disconnected" persists | API key invalid / faction not subscribed | Check the key in settings; contact RussianRob |
| "No active war" right after a war ends | Server's 12h cutoff filtered the war | Should auto-fall-back within 30s; refresh War tab |
| Member bars empty for some members | Those members haven't opened FactionOps / app | Bars are self-reported by each client; nothing to fix server-side |
| "Outdated script" 426 error | Tampermonkey hasn't pulled the latest version | Tampermonkey dashboard → Check for userscript updates |
| Chain panic alert post-war | Was a known bug, fixed in v5.0.10 | Update FactionOps |

---

## Section B: OC Spawn setup

### B1. Install the userscript

1. Install **Tampermonkey** in Chrome / Edge / Firefox (skip if you already installed it for FactionOps)
2. Open <https://tornwar.com/scripts/oc-spawn-assistance.user.js>
3. Tampermonkey shows an install prompt — click **Install**
4. Reload `torn.com/factions.php?step=your`
5. The OC Spawn panel appears under your OC list

### B2. Authenticate

The script asks for your **Torn API key** on first load. Same rules as FactionOps:
- Generate at <https://www.torn.com/preferences.php#tab=api>
- Pick **Limited Access**
- Required selections: `crimes`, `members`, `basic`
- Paste into the OC Spawn panel's key field

### B3. Configure admin roles (one-time, faction admin)

OC Spawn has its own admin roles list (independent from FactionOps). It controls who sees the Admin / Manager / Engines / Members tabs.

In OC Spawn:
1. Open the **Admin** tab (only leadership sees it initially)
2. Edit the **Admin roles** field
3. Save

Default: `leader, co-leader`. Add `banker` if your bankers handle vault claims.

### B4. PWA notifications (optional, recommended for bankers)

A separate PWA at <https://tornwar.com/notifications> rings the device when:
- A faction member submits a vault request
- An OC is fully filled and ready to spawn
- An OC completes (success or failure) with payout

Setup (per device):
1. Open the URL on the phone you want to receive alerts
2. Add to Home Screen (iOS Share menu → Add to Home Screen; Android ⋮ → Install app)
3. Open from the home-screen icon
4. Paste your Torn API key, tap **Enable on this device**
5. Tick the notification preferences you want
6. Send a test push to confirm

iOS 16.4+ required for Web Push. Notifications ring even when the page isn't open.

### B5. OC-specific issues

| Symptom | Likely cause | Fix |
|---|---|---|
| OC Spawn tabs missing | Your role isn't in the OC admin roles list | OC Spawn → Admin → add your role |
| "Access restricted" | Faction not on partner allowlist or trial expired | Contact RussianRob |
| Spawn signal not firing | OC isn't actually full / member not opted in | Check the slot list; member needs to be opted into spawn assistance |
| Notifications stopped after iOS update | Web Push subscriptions expire | Re-enable on the device via the PWA |
| "Outdated script" 426 error | Tampermonkey hasn't pulled the latest version | Tampermonkey dashboard → Check for userscript updates |

---

## Common reference

### Subscription tiers

| Tier | How | Duration |
|---|---|---|
| **Owner faction** (Dead Fragment, 42055) | Permanent | — |
| **Partner faction** | Granted by RussianRob via /admin | Permanent or N weeks |
| **Xanax subscriber** | Send Xanax to RussianRob via faction armoury | 7 days (2 xanax) or 30 days (20 xanax) |
| **Trial** | First xanax sent grants instant trial access | 7 days |

The Subscription line in FactionOps settings shows your current status. Renewals via xanax are detected within 5 minutes.

### Getting help

Send a message to **RussianRob [137558]** in Torn with:
- Your faction ID
- Which service you're trying to use (FactionOps / OC Spawn)
- What you were doing
- The exact error message (screenshot helps)

**Don't paste your API key.** Ever.

### Quick reference

- **FactionOps userscript**: <https://tornwar.com/scripts/factionops.user.js>
- **OC Spawn Assistance**: <https://tornwar.com/scripts/oc-spawn-assistance.user.js>
- **OC Spawn notifications PWA**: <https://tornwar.com/notifications>
- **Android APK**: <https://tornwar.com/warboard.apk>
- **Owner contact**: RussianRob [137558]
- **Privacy / Terms**: <https://tornwar.com/privacy> · <https://tornwar.com/terms>
