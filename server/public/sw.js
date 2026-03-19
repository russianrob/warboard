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

  const options = {
    body: payload.body || "",
    icon: payload.icon || "/icon-192.png",
    badge: "/icon-badge.png",
    tag: payload.tag || "factionops",
    renotify: true,
    vibrate: [200, 100, 200],
    data: payload.data || {},
    actions: [],
  };

  // Add contextual actions based on notification type
  const type = payload.data?.type;
  if (type === "call" || type === "hospital-pop") {
    options.actions = [{ action: "attack", title: "Attack" }];
  } else if (type === "chain-alert" || type === "bonus") {
    options.actions = [{ action: "attack", title: "Attack Now" }];
  }

  event.waitUntil(self.registration.showNotification(payload.title || "FactionOps", options));
});

// ── Notification Click Handler ───────────────────────────────────────────

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const data = event.notification.data || {};

  // Determine URL to open
  let url = "https://www.torn.com/factions.php?step=your#/war/rank";
  if (data.targetId) {
    url = `https://www.torn.com/loader.php?sid=attack&user2ID=${data.targetId}`;
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
