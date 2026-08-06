// Enkel "app shell" cache för offline-bruk.
// Höj CACHE_NAME (t.ex. till 'golf-scorekort-v2') när du gör en större uppdatering
// av index.html för att tvinga fram en ny cache.
var CACHE_NAME = 'golf-scorekort-v43';
var APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './courses.json',
  './i18n.json'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(APP_SHELL);
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (key) { return key !== CACHE_NAME; })
          .map(function (key) { return caches.delete(key); })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;

  // Only handle same-origin GET requests; let everything else (Overpass API,
  // Google Fonts, etc.) pass straight through to the network as usual.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.match(req).then(function (cached) {
      var networkFetch = fetch(req).then(function (resp) {
        if (resp && resp.status === 200) {
          var copy = resp.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(req, copy); });
        }
        return resp;
      }).catch(function () { return cached; });
      // Cache-first for instant offline loads, but refresh cache in the background.
      return cached || networkFetch;
    })
  );
});
