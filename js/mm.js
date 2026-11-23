// MysMatch website statistics (Nov 23 2026) — our own replacement for Plausible
// after its trial ended. Same privacy model: no cookies, nothing stored in the
// browser, no personal data. The page sends only: the page URL, the referring
// site, screen width and time zone. The server (Supabase function site-event)
// turns that into an anonymous daily visitor code; the IP address is never
// stored. Described in the privacy policy.
//
// What is counted (same as Plausible gave us):
//  * page views (+ where visitors came from, UTM campaigns)
//  * engagement: active time on the page and how far down it was scrolled,
//    sent when the tab is hidden or closed (time on page, visit duration)
//  * custom events through window.mmTrack(name, props) — "Store badge click"
//    (below) and "Challenge signup" (js/challenge.js)
//  * outbound link clicks, file downloads, and 404 pages
// Every call is wrapped so the page never breaks if sending fails or a
// blocker stops it. File name and endpoint avoid "analytics"/"track"/"collect"
// on purpose: generic ad-block lists block those words.
(function () {
  'use strict';
  var ENDPOINT = 'https://fgekipaehyzizwvaiijz.supabase.co/functions/v1/site-event';
  // Only the live site sends (local previews and test copies don't pollute the numbers).
  var LIVE = /^(www\.)?mysmatch\.com$/.test(location.hostname);
  var tz = '';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {}

  function send(name, extra) {
    if (!LIVE || navigator.webdriver) return;   // webdriver = automated/headless browser
    var body = { n: name, u: location.href, r: document.referrer || '', w: (window.screen && screen.width) || 0, tz: tz };
    if (extra) for (var k in extra) body[k] = extra[k];
    var s = JSON.stringify(body);
    try {
      // Plain-text beacon: survives page unload and needs no CORS preflight.
      if (navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, s)) return;
    } catch (e) {}
    try { fetch(ENDPOINT, { method: 'POST', body: s, keepalive: true, mode: 'no-cors' }); } catch (e) {}
  }

  // Custom events. Keeps the old names working: mmTrack (js/challenge.js) and
  // a plausible(name, {props}) shim in case an old call is left anywhere.
  function track(name, props) {
    try { send(name, props ? { p: props } : null); } catch (e) {}
  }
  window.mmTrack = track;
  window.plausible = function (name, opts) { track(name, opts && opts.props); };

  // Page view, or "404" on the not-found page (GitHub serves 404.html at the
  // missing URL, so the path is the broken link).
  var is404 = !!document.querySelector('meta[name="mm-page"][content="404"]');
  send('pageview');
  if (is404) track('404', { path: location.pathname });

  // Engagement: only time while the tab is visible counts. Sent as the time
  // since the last report, so several reports for one page add up.
  var visibleSince = document.visibilityState === 'visible' ? Date.now() : 0;
  var unsent = 0, maxScroll = 0;
  function measureScroll() {
    var d = document.documentElement, b = document.body;
    var h = Math.max(d.scrollHeight, b ? b.scrollHeight : 0);
    var seen = (window.pageYOffset || d.scrollTop || 0) + window.innerHeight;
    var pct = h > 0 ? Math.min(100, Math.round(100 * seen / h)) : 100;
    if (pct > maxScroll) maxScroll = pct;
  }
  var scrollQueued = false;
  window.addEventListener('scroll', function () {
    if (scrollQueued) return; scrollQueued = true;
    requestAnimationFrame(function () { scrollQueued = false; measureScroll(); });
  }, { passive: true });
  window.addEventListener('load', measureScroll);
  function flush() {
    if (visibleSince) { unsent += Date.now() - visibleSince; visibleSince = 0; }
    measureScroll();
    if (unsent >= 1000) { send('engagement', { e: unsent, s: maxScroll }); unsent = 0; }
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flush();
    else visibleSince = Date.now();
  });
  window.addEventListener('pagehide', flush);

  // Clicks: one delegated listener (also covers links added later by page scripts).
  var FILE = /\.(pdf|xlsx?|docx?|pptx?|csv|zip|ics|apk)(\?|#|$)/i;
  document.addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.href || '';
    var store = /apps\.apple\.com/i.test(href) ? 'ios' : /play\.google\.com/i.test(href) ? 'android' : '';
    if (store) track('Store badge click', { store: store, page: location.pathname });
    if (FILE.test(href)) track('File Download', { url: href.split('?')[0] });
    else if (/^https?:/i.test(href) && a.hostname !== location.hostname) {
      track('Outbound Link: Click', { url: (a.origin + a.pathname).slice(0, 300) });
    }
  }, true);
})();
