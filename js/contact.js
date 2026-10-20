// Impressum contact form (Oct 2026). WHY a plain fetch: one anon RPC call
// doesn't need the supabase-js bundle. submit_contact_message checks lengths,
// rate-limits (3/hour per sender, 30/hour overall) and pushes the team; it
// returns 'ok' | 'invalid' | 'rate_limited'. Status texts are elements in the
// page (translated by i18n/build.py), this file only shows/hides them.
(function () {
  var URL = 'https://fgekipaehyzizwvaiijz.supabase.co/rest/v1/rpc/submit_contact_message';
  // Public anon key (same one as js/supabase.js). Not a secret.
  var KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZnZWtpcGFlaHl6aXp3dmFpaWp6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY2NzQ2NjUsImV4cCI6MjA4MjI1MDY2NX0.UXBWicDvFtBK9_h826tQRMXMgFqzLnbNvnihWgnieXQ';
  var form = document.getElementById('cf');
  if (!form) return;
  var btn = document.getElementById('cf-btn');
  var msgs = ['cf-ok', 'cf-invalid', 'cf-limit', 'cf-fail'];
  function show(id) { msgs.forEach(function (m) { document.getElementById(m).hidden = m !== id; }); }

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var f = form.elements;
    var name = f.name.value.trim(), email = f.email.value.trim(), message = f.message.value.trim();
    // Same rules as the server, so most mistakes are caught without a request.
    if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || message.length < 5) { show('cf-invalid'); return; }
    btn.disabled = true;
    fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: KEY, Authorization: 'Bearer ' + KEY },
      body: JSON.stringify({
        p_name: name, p_email: email, p_message: message,
        p_lang: document.documentElement.lang || 'en', p_website: f.website.value,
      }),
    })
      .then(function (r) { return r.ok ? r.json() : 'fail'; })
      .then(function (res) {
        if (res === 'ok') { form.reset(); show('cf-ok'); }
        else show(res === 'invalid' ? 'cf-invalid' : res === 'rate_limited' ? 'cf-limit' : 'cf-fail');
      })
      .catch(function () { show('cf-fail'); })
      .then(function () { btn.disabled = false; });
  });
})();
