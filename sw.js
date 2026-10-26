// Lets phones install the app. It doesn't store any copies of the app, so updates always show right away.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});   // network as usual
