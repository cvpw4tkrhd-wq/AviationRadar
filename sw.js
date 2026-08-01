// LUFTRUM service worker — caches the app shell only.
// Bump CACHE_NAME whenever index.html/app.js/style.css/icons change, so old
// clients pick up the new files instead of serving a stale cached shell.
var CACHE_NAME = 'luftrum-shell-v1';

var SHELL_FILES = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './192px_icon.png',
  './512px_icon.png'
];

self.addEventListener('install', function(event){
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache){
      return cache.addAll(SHELL_FILES);
    }).then(function(){
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function(event){
  event.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(
        keys.filter(function(key){ return key !== CACHE_NAME; })
            .map(function(key){ return caches.delete(key); })
      );
    }).then(function(){
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function(event){
  var url = new URL(event.request.url);

  // Only handle same-origin GET requests (the app shell). Everything else —
  // adsb.lol, adsb.fi, OpenSky, adsbdb, the CORS proxies, map tiles, fonts —
  // must always go straight to the network so flight data is never stale.
  if (url.origin !== self.location.origin || event.request.method !== 'GET'){
    return;
  }

  event.respondWith(
    caches.match(event.request).then(function(cached){
      var networkFetch = fetch(event.request).then(function(response){
        if (response && response.ok){
          var copy = response.clone();
          caches.open(CACHE_NAME).then(function(cache){ cache.put(event.request, copy); });
        }
        return response;
      }).catch(function(){
        return cached; // offline — fall back to whatever's cached, if anything
      });
      // Cache-first for instant load, but refresh the cache in the background.
      return cached || networkFetch;
    })
  );
});
