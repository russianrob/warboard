# OC Spawn Assistance — Setup guide

← [Back to start](/start)

Automated organized-crime slot filling, ready-to-spawn signals, and a banker-claim flow for Torn factions running organized crimes.

---

## 1. Install the userscript

1. Install **Tampermonkey** in Chrome / Edge / Firefox (skip if you already installed it for FactionOps)
2. Open <https://tornwar.com/scripts/oc-spawn-assistance.user.js>
3. Tampermonkey shows an install prompt — click **Install**
4. Reload `torn.com/factions.php?step=your`
5. The OC Spawn panel appears under your OC list

---

## 2. Authenticate

The script asks for your **Torn API key** on first load. Use a **Limited Access** key — never a Full key.

- Generate at <https://www.torn.com/preferences.php#tab=api>
- Click **Create a new key**, pick **Limited Access**
- Tick the **permission checkboxes** (Torn calls them "selections") for: **crimes**, **members**, **basic**
- Save, copy the key string, paste into the OC Spawn panel's key field

**Key safety**: every API key warboard stores is **encrypted at rest with AES-256-GCM**. The decryption key lives only in the server's environment variables. Keys are never sent back to the browser after the first paste, never logged, and never exposed via any API endpoint. Revoke any key at any time at <https://www.torn.com/preferences.php#tab=api> and the next warboard call using it will fail.

---

## 3. Configure admin roles (one-time, faction admin)

OC Spawn has its own admin roles list (independent from FactionOps). It controls who sees the Admin / Manager / Engines / Members tabs.

In OC Spawn:
1. Open the **Admin** tab (only leadership sees it initially)
2. Edit the **Admin roles** field
3. Save

Default: `leader, co-leader`. Add `banker` if your bankers handle vault claims.

---

## 4. PWA notifications (optional, recommended for bankers)

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

---

## 5. OC-specific issues

| Symptom | Likely cause | Fix |
|---|---|---|
| OC Spawn tabs missing | Your role isn't in the OC admin roles list | OC Spawn → Admin → add your role |
| "Access restricted" | Faction not on partner allowlist or trial expired | Contact RussianRob |
| Spawn signal not firing | OC isn't actually full / member not opted in | Check the slot list; member needs to be opted into spawn assistance |
| Notifications stopped after iOS update | Web Push subscriptions expire | Re-enable on the device via the PWA |
| "Outdated script" 426 error | Tampermonkey hasn't pulled the latest version | Tampermonkey dashboard → Check for userscript updates |

---

## Subscription tiers

| Tier | How | Duration |
|---|---|---|
| **Partner faction** | Granted by RussianRob via /admin | Permanent or N weeks |
| **Xanax subscriber** | Send Xanax to RussianRob via faction armoury | 7 days (2 xanax) or 30 days (20 xanax) |
| **Trial** | First xanax sent grants instant trial access | 7 days |

Renewals via xanax are detected within 5 minutes.

---

## Getting help

Send a message to **RussianRob [137558]** in Torn with:
- Your faction ID
- What you were doing
- The exact error message (screenshot helps)

**Don't paste your API key.** Ever.

---

## Quick reference

- **OC Spawn Assistance**: <https://tornwar.com/scripts/oc-spawn-assistance.user.js>
- **OC Spawn notifications PWA**: <https://tornwar.com/notifications>
- **Owner contact**: RussianRob [137558]
- **FactionOps setup**: [/start/factionops](/start/factionops)
- **Privacy / Terms**: <https://tornwar.com/privacy> · <https://tornwar.com/terms>
