/**
 * FactionOps Service Worker — handles push notifications and PWA caching.
 * @author RussianRob
 */

// ── Push Notification Handler ────────────────────────────────────────────

self.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: "FactionOps", body: event.data.text() };
  }

  const type = payload.data?.type;

  // ── War-end cleanup ─────────────────────────────────────────────────
  // When the server detects a war ended, it sends type=clear-chain-alerts
  // so we can dismiss any sticky chain-alert / chain-panic notifications
  // still pinned to the OS panel from pre-end fires. Without this, the
  // requireInteraction:true flag below leaves chain-break alerts visible
  // for days until the user manually swipes — surfacing 1-2 day old
  // "CHAIN BREAKING!" notifications at random screen unlocks.
  //
  // Always shows a brief, low-priority summary alongside the close
  // because iOS Web Push will revoke a subscription that doesn't
  // visibly notify on every push.
  if (type === "clear-chain-alerts") {
    event.waitUntil((async () => {
      try {
        const notifs = await self.registration.getNotifications();
        for (const n of notifs) {
          if (n.tag === "chain-alert" || n.tag === "chain-panic") {
            n.close();
          }
        }
      } catch (_) { /* swallow */ }
      await self.registration.showNotification(payload.title || "Chain alerts cleared", {
        body: payload.body || "",
        icon: payload.icon || "/icon-192.png",
        tag: "chain-cleared",
        renotify: false,
        silent: true,
        requireInteraction: false,
        data: payload.data || {},
      });
    })());
    return;
  }

  const isUrgent = type === "chain-alert";

  const options = {
    body: payload.body || "",
    icon: payload.icon || "/icon-192.png",
    badge: "/icon-badge.png",
    tag: payload.tag || "factionops",
    renotify: true,
    vibrate: isUrgent ? [300, 100, 300, 100, 300, 100, 300] : [200, 100, 200],
    data: payload.data || {},
    actions: [],
    requireInteraction: isUrgent,
    silent: false,
  };

  // Add contextual actions based on notification type
  if (type === "call" || type === "hospital-pop") {
    options.actions = [{ action: "attack", title: "Attack" }];
  } else if (type === "chain-alert" || type === "bonus") {
    options.actions = [{ action: "attack", title: "Attack Now" }];
  } else if (type === "assist_request" || type === "retal_request") {
    options.actions = [{ action: "attack", title: "Attack" }];
    options.requireInteraction = true;
  }

  // For chain alerts, play alarm sound via any open client window
  const showNotif = self.registration.showNotification(payload.title || "FactionOps", options);

  if (isUrgent) {
    const playAlarm = clients.matchAll({ type: "window", includeUncontrolled: true }).then((cls) => {
      for (const client of cls) {
        client.postMessage({ type: "chain-alarm" });
        break; // one client is enough
      }
    });
    event.waitUntil(Promise.all([showNotif, playAlarm]));
  } else {
    event.waitUntil(showNotif);
  }
});

// ── Notification Click Handler ───────────────────────────────────────────

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const data = event.notification.data || {};

  // Determine URL to open
  let url = "https://www.torn.com/factions.php?step=your#/war/rank";
  if (data.url) {
    url = data.url;
  } else if (data.targetId) {
    url = `https://www.torn.com/page.php?sid=attack&user2ID=${data.targetId}`;
  }

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      // Focus existing Torn tab if open
      for (const client of clientList) {
        if (client.url.includes("torn.com") && "focus" in client) {
          return client.focus().then((c) => c.navigate(url));
        }
      }
      // Otherwise open new tab
      return clients.openWindow(url);
    }),
  );
});

// ── Service Worker Lifecycle ─────────────────────────────────────────────

self.addEventListener("install", (event) => {
  // Activate immediately — no waiting
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Claim all clients immediately
  event.waitUntil(self.clients.claim());
});
