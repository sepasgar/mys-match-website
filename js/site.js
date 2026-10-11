// Shared page motion for the sub-pages (vanilla port of the design export's
// logic, same as the homepage's inline script). WHY a file: every sub-page
// needs the same mobile menu, scroll reveals and header progress bar.
(function () {
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Mobile menu: toggle, and close after tapping a link.
  var nav = document.getElementById('nav'), btn = document.getElementById('menu-btn');
  if (nav && btn) {
    var setMenu = function (open) { nav.classList.toggle('open', open); btn.setAttribute('aria-expanded', open ? 'true' : 'false'); };
    btn.addEventListener('click', function () { setMenu(!nav.classList.contains('open')); });
    document.querySelectorAll('#nav-links a').forEach(function (a) { a.addEventListener('click', function () { setMenu(false); }); });
  }

  // Header progress bar.
  var bar = document.getElementById('progress');
  function onScroll() {
    if (!bar) return;
    var max = document.documentElement.scrollHeight - window.innerHeight;
    bar.style.width = (max > 0 ? (window.scrollY / max) * 100 : 0) + '%';
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  if (reduce || !('IntersectionObserver' in window)) return;
  document.documentElement.classList.add('js');

  // Scroll reveals, staggered among siblings. Exposed as MMReveal so pages can
  // register elements they render later (e.g. event cards from Supabase).
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      if (!en.isIntersecting) return;
      var el = en.target; io.unobserve(el);
      var sibs = [].filter.call(el.parentElement.children, function (c) { return c.hasAttribute('data-reveal'); });
      el.style.transitionDelay = Math.min(6, Math.max(0, sibs.indexOf(el))) * 110 + 'ms';
      el.classList.add('shown');
    });
  }, { rootMargin: '0px 0px -8% 0px' });
  window.MMReveal = function (root) {
    (root || document).querySelectorAll('[data-reveal]:not(.shown)').forEach(function (el) { io.observe(el); });
  };
  window.MMReveal();
})();
