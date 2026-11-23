// Where guests come from: a fallback for sites without the marketing attribution script.
// When that script (window.HRA, loaded from config.js trackUrl) is on the page, it does this job
// and this file steps aside. Both remember, in this browser only, the first and latest way the
// guest arrived in the same format (utm_*, ad click IDs, referrer), and orders, bookings and
// sign-ups send it with window.HRA.get(). The server sorts it into a channel (core.js channelOf).
(function () {
  var KEY = 'ro-src', DAY = 86400000;
  var load = function () { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } };
  var save = function (s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* private mode: this visit only */ } };
  var cookie = function (name) { var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : ''; };
  var s = load();
  if (!s.v) s.v = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);

  var q = new URLSearchParams(location.search), t = {};
  ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'ttclid']
    .forEach(function (p) { var v = q.get(p); if (v) t[p] = String(v).slice(0, 200); });
  var host = '';
  try { host = new URL(document.referrer).hostname.replace(/^www\./, ''); } catch (e) { /* no referrer */ }
  if (host === location.hostname.replace(/^www\./, '') || /(^|\.)(stripe\.com|clover\.com|squareup\.com|authorize\.net)$/.test(host)) host = '';
  if (Object.keys(t).length || host) {
    if (host) t.referrer = document.referrer.slice(0, 500);
    t.landing_url = (location.origin + location.pathname).slice(0, 300);
    t.at = new Date().toISOString();
    if (!s.f) s.f = t;
    s.l = t;
    if (t.fbclid) s.fbc = 'fb.1.' + Date.now() + '.' + t.fbclid;
  }
  save(s);

  if (window.HRA) return; // the attribution script is already here
  window.HRA = {
    fallback: true,
    get: function () {
      var x = load(), fresh = function (v) { return v && Date.now() - Date.parse(v.at) < 90 * DAY ? v : null; };
      var ga = cookie('_ga').split('.').slice(-2).join('.');
      return { visitorId: x.v, firstTouch: fresh(x.f), lastTouch: fresh(x.l), gaClientId: ga || undefined, fbc: x.fbc || cookie('_fbc') || undefined, fbp: cookie('_fbp') || undefined };
    },
  };
})();
