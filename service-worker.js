// FactoryFlow OS Service Worker
const CACHE_NAME = 'factoryflow-v1';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/style.css',
  '/script.js',
  '/manifest.json'
];

// API domains that should bypass cache
const API_DOMAINS = [
  'script.google.com',
  'script.googleusercontent.com'
];

// Install event - cache assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('FactoryFlow OS: Caching app assets');
        return cache.addAll(ASSETS_TO_CACHE);
      })
      .then(() => self.skipWaiting())
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('FactoryFlow OS: Removing old cache', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Check if URL is an API request that should bypass cache
function isApiRequest(url) {
  try {
    const urlObj = new URL(url);
    return API_DOMAINS.some(domain => urlObj.hostname.endsWith(domain));
  } catch (e) {
    return false;
  }
}

// Fetch event - serve from cache, fallback to network
self.addEventListener('fetch', (event) => {
  // Skip non-GET requests
  if (event.request.method !== 'GET') return;
  
  // Skip API requests - let them go directly to network
  if (isApiRequest(event.request.url)) return;

  event.respondWith(
    caches.match(event.request)
      .then((cachedResponse) => {
        if (cachedResponse) {
          // Return cached version but also fetch update in background
          event.waitUntil(
            fetch(event.request)
              .then((networkResponse) => {
                if (networkResponse && networkResponse.status === 200) {
                  caches.open(CACHE_NAME)
                    .then((cache) => cache.put(event.request, networkResponse.clone()));
                }
              })
              .catch(() => {})
          );
          return cachedResponse;
        }
        
        // Not in cache - fetch from network
        return fetch(event.request)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              const responseClone = networkResponse.clone();
              caches.open(CACHE_NAME)
                .then((cache) => cache.put(event.request, responseClone));
            }
            return networkResponse;
          })
          .catch(() => {
            // Offline fallback for HTML pages
            const acceptHeader = event.request.headers.get('accept') || '';
            if (acceptHeader.includes('text/html')) {
              return caches.match('/index.html');
            }
          });
      })
  );
});
