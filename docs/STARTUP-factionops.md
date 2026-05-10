# FactionOps — Setup guide

← [Back to start](/start)

Real-time war coordination for Torn factions: target calls, chain bar, hospital alerts, scout reports, post-war analytics, and mobile apps with push notifications.

---

## 1. Install the userscript

1. Install **Tampermonkey** in Chrome / Edge / Firefox (Chrome Web Store: search "Tampermonkey")
2. Open <https://tornwar.com/scripts/factionops.user.js>
3. Tampermonkey shows an install prompt — click **Install**
4. Reload `torn.com` and navigate to your faction page
5. The FactionOps overlay appears with a gear icon (⚙) in the top-right

---

## 2. Authenticate

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

---

## 3. Configure admin roles (one-time, faction admin)

By default only `Leader` and `Co-leader` see admin-only panels (Members bars, post-war report, broadcasts). To delegate, configure the **Admin Roles** list.

In FactionOps:
1. ⚙ Settings → **Custom Admin Roles**
2. Type comma-separated role names: `leader, co-leader, banker, warmaster`
3. Save

This list gates: Member bars / cooldowns view, post-war report, shout / broadcast.

---

## 4. Opt into the faction key pool (recommended)

Warboard polls Torn for chain status, hospital events, attack feeds, and war scores. To avoid burning a single key's 100 calls/min quota, members can opt their key into a **shared pool** that warboard rotates through.

**Recommendation**: encourage 5+ members to opt in. Spreads polling load and means you survive any one member being offline / their key being revoked. Use **Limited keys** only.

The setting is in FactionOps ⚙ Settings → **Share my API key with faction pool**.

---

## 5. Install the mobile apps (optional, recommended)

| Platform | How |
|---|---|
| **iOS** | TestFlight invite from RussianRob [137558] |
| **Android** | Download <https://tornwar.com/warboard.apk> and install (allow unknown sources) |

The apps add:
- Live Activity / Dynamic Island chain timer (iOS)
- Push notifications: chain panic, target hospitalized, target called, war started/ended
- Coordination from your phone without an open browser tab

---

## 6. FactionOps-specific issues

| Symptom | Likely cause | Fix |
|---|---|---|
| "Disconnected" persists | API key invalid / faction not subscribed | Check the key in settings; contact RussianRob |
| "No active war" right after a war ends | Server's 12h cutoff filtered the war | Should auto-fall-back within 30s; refresh War tab |
| Member bars empty for some members | Those members haven't opened FactionOps / app | Bars are self-reported by each client; nothing to fix server-side |
| "Outdated script" 426 error | Tampermonkey hasn't pulled the latest version | Tampermonkey dashboard → Check for userscript updates |

---

## Subscription tiers

| Tier | How | Duration |
|---|---|---|
| **Owner faction** (Dead Fragment, 42055) | Permanent | — |
| **Partner faction** | Granted by RussianRob via /admin | Permanent or N weeks |
| **Xanax subscriber** | Send Xanax to RussianRob via faction armoury | 7 days (2 xanax) or 30 days (20 xanax) |
| **Trial** | First xanax sent grants instant trial access | 7 days |

The Subscription line in FactionOps settings shows your current status. Renewals via xanax are detected within 5 minutes.

---

## Getting help

Send a message to **RussianRob [137558]** in Torn with:
- Your faction ID
- What you were doing
- The exact error message (screenshot helps)

**Don't paste your API key.** Ever.

---

## Quick reference

- **FactionOps userscript**: <https://tornwar.com/scripts/factionops.user.js>
- **Android APK**: <https://tornwar.com/warboard.apk>
- **Owner contact**: RussianRob [137558]
- **OC Spawn setup**: [/start/oc-spawn](/start/oc-spawn)
- **Privacy / Terms**: <https://tornwar.com/privacy> · <https://tornwar.com/terms>
