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

## 2. Create your API keys

You'll create two keys at <https://www.torn.com/preferences.php#tab=api>. Both must be **Limited Access** tier.

On Torn's API page, click **Create a new key**, pick the **Limited Access** radio option, give it a name (so you can identify it later), and click **Create**. That's it — Limited tier already covers every endpoint warboard reads (chain, faction members, attacks, bars, cooldowns, armoury news, etc.). Don't use Full Access — warboard never needs write permissions.

### 2a. FactionOps key (every member, personal)

- Name it something like **"FactionOps"** so you can recognize it later in your key list
- Pick **Limited Access** and create
- When the FactionOps overlay loads on Torn, paste this key into the prompt — it's stored locally per member

This is the key each member uses individually. It powers their personal status (energy, cooldowns) and lets them act inside FactionOps (calls, claims, broadcasts).

### 2b. Faction key (one per faction, admin sets once)

- Name it something like **"FactionKey"** so it's clearly the shared one
- Pick **Limited Access** and create
- One faction admin pastes this in **⚙ Settings → Faction API Key** field

The faction key is **stored server-side and used by warboard's pollers on behalf of the whole faction** — chain monitor, war-status sweeps, attacks-feed, ranked-war report. It's what keeps everyone's data fresh even if no member has FactionOps open at that moment. Set it once; warboard handles the rest.

### Key safety

Every API key warboard stores — personal FactionOps keys, the faction key, and pool-shared keys — is **encrypted at rest with AES-256-GCM** before being written to disk. The decryption key lives only in the server's environment variables, separate from the data files. If a stored key file were ever leaked on its own, the contents would be unreadable without the env-side secret.

Keys are also never sent to the browser after the first paste, never logged, and never exposed via any API endpoint. You can revoke any key at any time from <https://www.torn.com/preferences.php#tab=api> — the next warboard call using it will fail and the key auto-evicts from caches.

### Verify the connection

Click ⚙ to open settings. The connection dot should turn green. The **Subscription** line shows your status:
- **★ Permanent** — owner faction or partner with FactionOps grant
- **N days remaining** — xanax-paying faction
- **expired / unknown** — contact the warboard owner

Below that, the **Faction API Key** section shows "Key saved ✓" once an admin has stored the faction key.

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

## 5. FFScouter API key (optional, admin-only)

FFScouter (<https://ffscouter.com>) is a community stat-estimation service. If your faction has someone registered there, paste their key into FactionOps so warboard can use it server-side for:

- **Flight tracker** — live landing countdown on enemy travel pills in the war overlay
- **Abroad destinations** — country labels ("UK", "Mexico") on abroad pills
- **OC delay attribution** — when OC Spawn Assistance is also installed, backdates blocker delays to the real takeoff time

Set it once in **⚙ Settings → FFScouter API Key**. The same key is shared with OC Spawn Assistance — setting it in either place updates both. Leave blank if no one in your faction is on FFScouter; the rest of FactionOps still works fine.

---

## 6. Install the mobile apps (optional, recommended)

| Platform | How |
|---|---|
| **iOS** | TestFlight invite from RussianRob [137558] |
| **Android** | Download <https://tornwar.com/warboard.apk> and install (allow unknown sources) |

Once installed and signed in with your API key, the apps automatically register for push notifications (no extra setup). They add:
- Live Activity / Dynamic Island chain timer (iOS)
- Coordination from your phone without an open browser tab

---

## 7. Notifications

FactionOps fires push notifications for: **chain panic**, **chain about to break**, **target hospitalized** (when one of your called targets pops out), **target called by another member**, **war started / ended**, and **bonus-imminent** (next chain milestone within 2 hits).

How to receive them depends on where you're using warboard:

| Platform | Setup |
|---|---|
| **iOS app** | Auto-enabled on first launch; allow notifications when prompted |
| **Android app** | Auto-enabled on first launch; allow notifications when prompted |
| **Torn PDA** (mobile WebView) | Open FactionOps ⚙ Settings → toggle **PDA Notifications** on, tap **Test PDA Notification** to verify |
| **Desktop browser** | In-overlay toast notifications only — no OS-level push (use the mobile apps if you need away-from-keyboard alerts) |

Per-notification preferences (which types to ring) are configured per-app: open the app's settings tab.

---

## 8. FactionOps-specific issues

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
