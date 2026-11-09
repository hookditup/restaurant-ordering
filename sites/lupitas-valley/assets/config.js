/* Lupita's Valley site settings. These are the only values you need to edit before launch.
   reviewUrl:    Google "Ask for reviews" link from the Business Profile. While blank, the
                 review button opens the Google Maps listing.
   orderUrl:     Online ordering link. While blank, every order button says "Call to order".
                 Once set, every order button says "Order online" and goes to this link.
   trackUrl:     Marketing attribution service. While blank, no tracking script loads.
                 Testing: https://track-test.hookditup.com   Live: https://go.lupitasvalley.com */
window.LV = {
  reviewUrl: '',
  orderUrl: '/menu',
  trackUrl: 'https://track-test.hookditup.com'
};

/* Online ordering connection. The key is public by design; security rules live in the database. */
window.RO = {
  url: 'https://khvwoynoqnatcqgvoyar.supabase.co',
  key: 'sb_publishable_kdiyPT_FKfxLkvmjIVbV7g_CFZaPe2H',
  restaurant: 'lupitas-valley'
};

/* Marketing attribution: records which post, ad, link or QR code brought each guest, so orders,
   reservations and rewards sign-ups can be credited to it. Not loaded on staff screens. */
(function () {
  var url = window.LV && window.LV.trackUrl;
  if (!url || /^\/(kitchen|admin)(\/|$)/.test(location.pathname)) return;
  var s = document.createElement('script');
  s.src = url.replace(/\/$/, '') + '/t.js';
  s.async = true;
  s.setAttribute('data-restaurant', window.RO.restaurant);
  s.setAttribute('data-endpoint', url);
  document.head.appendChild(s);
})();
