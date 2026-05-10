# Warboard — Getting started for new factions

Welcome. Warboard is a real-time war coordination platform: live chain timer, target calling, hospital alerts, post-war analytics, OC spawn assistance, and vault management. This doc walks a new faction admin through setup in about 10 minutes.

---

## 1. Quick start checklist

For each new member who'll use warboard:

- [ ] Install the **FactionOps** userscript (browser) or the warboard **mobile app**
- [ ] Authenticate with their Torn API key (Limited recommended)
- [ ] Decide whether to opt into the faction key pool

For the faction admin (one-time):

- [ ] Confirm with the warboard owner that your faction has been granted access
- [ ] Set the **Admin Roles** list (who counts as leadership)
- [ ] Install **OC Spawn Assistance** if your faction runs organized crimes

---

## 2. What you get

| Service | What it does | Where it runs |
|---|---|---|
| **FactionOps** | Live war coordination — target calls, chain bar, hospital pop alerts, scout reports, post-war analytics, member status | Userscript on `torn.com/factions.php` and friends; iOS / Android / Mac apps mirror the same data |
| **OC Spawn Assistance** | Auto-fills empty OC slots, signals when an OC is ready to spawn, banker-claim flow | Separate userscript on `torn.com/factions.php?step=your` |

These are independent grants — your faction can have one, the other, or both, configured by the warboard owner.

---

## 3. Install FactionOps (browser)

1. Install **Tampermonkey** in Chrome / Edge / Firefox
   - Chrome Web Store: search "Tampermonkey"
2. Open <https://tornwar.com/scripts/factionops.user.js>
3. Tampermonkey opens an install prompt — click **Install**
4. Reload `torn.com` and navigate to your faction page
5. The FactionOps overlay appears with a gear icon (⚙) in the top-right

### Verify install

Click ⚙ to open settings. The connection dot should turn green and you should see a **Subscription** line:

- **★ Permanent** — owner faction or partner with FactionOps grant
- **N days remaining** — xanax-paying faction
- **expired / unknown** — contact the warboard owner

If it shows "Disconnected" for more than a minute, your API key wasn't accepted — see Troubleshooting below.

---

## 4. Install OC Spawn Assistance (optional, for OC-running factions)

1. Open <https://tornwar.com/scripts/oc-spawn-assistance.user.js>
2. Tampermonkey installs
3. Reload `torn.com/factions.php?step=your`
4. The OC Spawn panel appears under your OC list

Banker / Manager / Engines tabs are gated to admin roles (configurable — see step 6).

---

## 5. Authenticate

When the userscript first loads, it asks for your **Torn API key**. Use a **Limited Access** key — never a Full key.

Generate one at <https://www.torn.com/preferences.php#tab=api>:
- Click **Create a new key**
- Pick **Limited Access**
- Recommended selections: `attacks`, `bars`, `cooldowns`, `profile`, `travel`, `chain`, `members`, `armorynews`
- Copy the key into FactionOps' settings

Limited keys can't withdraw money or perform actions — they're read-only. Server stores them encrypted.

---

## 6. Configure admin roles (faction admin)

By default, only `Leader` and `Co-leader` see admin-only panels (Members bars, post-war report, broadcasts, OC tabs). To delegate, configure the **Admin Roles** list.

In FactionOps:
1. ⚙ Settings → **Custom Admin Roles**
2. Type comma-separated role names: `leader, co-leader, banker, warmaster`
3. Save

The same list gates:
- Member bars / cooldowns view
- Post-war report
- Shout / broadcast
- OC Spawn admin tabs (separate setting in OC Spawn → Admin)

---

## 7. Install the mobile apps (optional but recommended)

| Platform | How |
|---|---|
| **iOS** | TestFlight invite from the warboard owner (Apple's beta system) |
| **Android** | Download <https://tornwar.com/warboard.apk> and install (allow unknown sources) |
| **Mac** | <https://tornwar.com/mac> — auto-updates via Sparkle |

Apps add:
- Live Activity / Dynamic Island chain timer (iOS)
- Push notifications: chain panic, target hospitalized, target called, war started/ended
- Ability to coordinate from your phone without opening Tampermonkey-equipped browser

---

## 8. The faction key pool — opt-in explained

Warboard polls Torn for your faction's data: chain status, hospital events, attack feeds, war scores. To avoid burning a single key's 100 calls/min quota, members can opt their key into a **shared pool** that warboard rotates through.

### Recommendation

- **Encourage 5+ members** to opt in. Spreads polling load and means you survive any one member being offline / their key being revoked.
- **Use Limited keys** for pool participation. Full keys aren't needed and increase risk if compromised.
- The setting is in FactionOps ⚙ Settings → **Share my API key with faction pool**.

### What the pool is used for

- Chain monitoring (every ~5s during war)
- Attacks-feed polling (every ~10s during war)
- War detection sweeps (every ~5min)
- Per-enemy profile lookups during war

### What it's NOT used for

- Personal data (your bars, cooldowns, attack history) — those use your own key only
- Anything that requires a Full key — pool stays read-only

---

## 9. Subscription model

| Tier | How | Duration |
|---|---|---|
| **Owner faction** (Dead Fragment, 42055) | Permanent | — |
| **Partner faction** | Granted by the warboard owner via /admin | Permanent or N weeks |
| **Xanax subscriber** | Send Xanax to RussianRob via faction armoury | 7 days (2 xanax) or 30 days (20 xanax) |
| **Trial** | First xanax sent grants instant trial access | 7 days |

The Subscription line in FactionOps settings shows your current status. Renewals via xanax are detected within 5 minutes.

---

## 10. Common issues

| Symptom | Likely cause | Fix |
|---|---|---|
| "Disconnected" persists | API key invalid / faction not subscribed | Check the key in settings; contact warboard owner |
| "No active war" right after a war ends | Server's 12h cutoff filtered the war | Should auto-fall-back to the most recent ended war within ~30s; refresh the War tab |
| Chain panic notification on PDA after war ends | Was a known bug, fixed in v5.0.10 | Update FactionOps |
| Member bars empty for some members | Those members haven't opened FactionOps / app | Bars are self-reported by each client; nothing to fix server-side |
| OC Spawn tabs missing | Your role isn't in the OC admin roles list | OC Spawn → Admin → add your role |
| "Outdated script" 426 error | Tampermonkey hasn't pulled the latest version | Tampermonkey dashboard → Check for userscript updates |

---

## 11. Getting help

Send a message to **RussianRob [137558]** in Torn with:
- Your faction ID
- What you were trying to do
- The exact error message (screenshot helps)

Don't paste your API key. Ever.

---

## 12. Quick reference

- **FactionOps userscript**: <https://tornwar.com/scripts/factionops.user.js>
- **OC Spawn Assistance**: <https://tornwar.com/scripts/oc-spawn-assistance.user.js>
- **Android APK**: <https://tornwar.com/warboard.apk>
- **Mac app**: <https://tornwar.com/mac>
- **Owner contact**: RussianRob [137558]
- **Privacy / Terms**: <https://tornwar.com/privacy> · <https://tornwar.com/terms>
