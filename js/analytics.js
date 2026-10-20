// Plausible custom events (Oct 2026). WHY: the owner wants three numbers —
// home visits (Plausible counts page views on its own), store-badge clicks
// (here) and challenge sign-ups (js/challenge.js). Plausible sets no cookies,
// so no consent banner. Every call goes through track(), which does nothing
// when the script is blocked (ad blockers), so the page never breaks.
(function () {
  function track(name, props) {
    try { if (typeof window.plausible === 'function') window.plausible(name, { props: props || {} }); } catch (e) {}
  }
  window.mmTrack = track;

  // One delegated listener instead of one per badge, so badges added later
  // (or rendered by page scripts) are counted without touching this file.
  document.addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
    if (!a) return;
    var store = /apps\.apple\.com/i.test(a.href) ? 'ios' : /play\.google\.com/i.test(a.href) ? 'android' : '';
    if (store) track('Store badge click', { store: store, page: location.pathname });
  }, true);
})();
