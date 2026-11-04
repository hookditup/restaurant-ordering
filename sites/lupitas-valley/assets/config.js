/* Lupita's Valley site settings. These are the only values you need to edit before launch.
   reviewUrl:    Google "Ask for reviews" link from the Business Profile. While blank, the
                 review button opens the Google Maps listing.
   orderUrl:     Online ordering link. While blank, every order button says "Call to order".
                 Once set, every order button says "Order online" and goes to this link. */
window.LV = {
  reviewUrl: '',
  orderUrl: '/menu'
};

/* Online ordering connection. The key is public by design; security rules live in the database. */
window.RO = {
  url: 'https://khvwoynoqnatcqgvoyar.supabase.co',
  key: 'sb_publishable_kdiyPT_FKfxLkvmjIVbV7g_CFZaPe2H',
  restaurant: 'lupitas-valley'
};
