// Ideation / Creator Challenge — data layer for /challenge (Oct 2026).
// Loaded after js/supabase.js (uses MM.db). Everything is enforced on the
// server (MyApp migration 20261015100000_ideation_challenge.sql): per-user RLS,
// the deadline (server clock), judge-only status, file limits. This file only
// wraps those calls and turns server error codes into readable messages.
(function () {
  if (!window.MM || !MM.db) { console.error('[MMC] js/supabase.js must load first'); return; }
  var db = MM.db;
  var SLUG = 'creator-2026';
  var BUCKET = 'challenge-files';
  // Google sign-in on the website needs the Google provider's web client +
  // secret in Supabase and the redirect in Google Cloud. Off until that is set up.
  var GOOGLE_WEB_ENABLED = false;
  var SITE = 'https://www.mysmatch.com';

  var TRACKS = [
    { id: 'scenario', num: '01', tag: 'Writing', title: 'Scenario', desc: 'Write the script for a Reel or TikTok about student life and MysMatch: the hook, the scenes, the punchline.', deliver: 'A written script, scene by scene' },
    { id: 'post', num: '02', tag: 'Static', title: 'Creative post', desc: 'Design a single post or carousel that makes a student stop scrolling and want to download the app.', deliver: '1–5 images (PNG, JPG or WebP)' },
    { id: 'video', num: '03', tag: 'Video', title: 'Content creator', desc: 'Record a short video in your own style, as if you were already filming for our channels.', deliver: 'A Google Drive link to your video' },
  ];
  var STATUSES = [
    { id: 'submitted', label: 'Submitted' }, { id: 'in_review', label: 'In review' },
    { id: 'shortlisted', label: 'Shortlisted' }, { id: 'interview', label: 'Interview' },
    { id: 'selected', label: 'Selected' }, { id: 'not_selected', label: 'Not selected' },
  ];
  // Same limits as the server (challenge_files_check) so people learn early.
  var SLOTS = {
    cv: { kind: 'cv', max: 1, mb: 5, exts: ['pdf', 'doc', 'docx'], hint: 'PDF, DOC or DOCX · 1 file · 5 MB' },
    extra: { kind: 'extra', max: 2, mb: 10, exts: ['pdf', 'doc', 'docx', 'png', 'jpg', 'jpeg', 'webp'], hint: 'Cover letter, references, portfolio · up to 2 files · 10 MB each' },
    scenario: { kind: 'scenario_pdf', max: 1, mb: 10, exts: ['pdf'], hint: 'PDF · 1 file · 10 MB' },
    concept: { kind: 'concept_pdf', max: 1, mb: 10, exts: ['pdf'], hint: 'PDF · 1 file · 10 MB' },
    post: { kind: 'post_image', max: 5, mb: 3, exts: ['png', 'jpg', 'jpeg', 'webp'], hint: 'PNG, JPG or WebP · up to 5 images' },
  };
  var MIME = {
    pdf: 'application/pdf', doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  };
  var extOf = function (n) { return (String(n || '').split('.').pop() || '').toLowerCase(); };

  var challenge = null;
  async function getChallenge() {
    if (challenge) return challenge;
    var r = await db.from('challenges').select('id,slug,title,season,closes_at').eq('slug', SLUG).maybeSingle();
    if (r.error) throw r.error;
    challenge = r.data;
    return challenge;
  }
  function isOpen(c) { return !!c && Date.now() < new Date(c.closes_at).getTime(); }

  // ---- Auth -----------------------------------------------------------------
  async function session() { var r = await db.auth.getSession(); return r.data ? r.data.session : null; }
  function onAuth(cb) { db.auth.onAuthStateChange(function (_e, s) { cb(s); }); }

  async function signUp(email, password) {
    var r = await db.auth.signUp({
      email: email, password: password,
      // signup_source=web → the account is a 'web' account (handle_new_user),
      // not a half-finished app sign-up that the app would clean up.
      // No #anchor: Supabase appends the login token to the URL fragment.
      options: { data: { signup_source: 'web' }, emailRedirectTo: SITE + '/challenge/?welcome=1' },
    });
    if (r.error) return { ok: false, error: friendlyAuth(r.error) };
    // Supabase hides "already registered" behind an empty identities list.
    if (r.data.user && !r.data.session && r.data.user.identities && r.data.user.identities.length === 0) {
      return { ok: false, error: 'An account with this email already exists. Please sign in.' };
    }
    return { ok: true, needsConfirm: !r.data.session };
  }
  async function signIn(email, password) {
    var r = await db.auth.signInWithPassword({ email: email, password: password });
    if (r.error) return { ok: false, error: friendlyAuth(r.error) };
    return { ok: true };
  }
  async function signInGoogle() {
    var r = await db.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: SITE + '/challenge/?welcome=1' } });
    if (r.error) return { ok: false, error: r.error.message };
    return { ok: true };
  }
  async function resetPassword(email) {
    // The reset email's link carries redirect_to → auth-callback sends website
    // resets to /challenge/reset.html (app resets still open the app).
    var r = await db.auth.resetPasswordForEmail(email, { redirectTo: SITE + '/challenge/reset.html' });
    if (r.error) return { ok: false, error: friendlyAuth(r.error) };
    return { ok: true };
  }
  async function signOut() { await db.auth.signOut({ scope: 'local' }); }
  function friendlyAuth(e) {
    var m = (e && e.message) || 'Something went wrong.';
    if (/invalid login credentials/i.test(m)) return 'Wrong email or password.';
    if (/email not confirmed/i.test(m)) return 'Please confirm your email first — check your inbox (and spam).';
    if (/known to be weak|pwned|leaked/i.test(m)) return 'This password appeared in a data leak. Please choose a different one.';
    if (/at least 6/i.test(m)) return 'Password must be at least 6 characters.';
    if (/rate limit|too many/i.test(m)) return 'Too many attempts. Please wait a minute and try again.';
    return m;
  }

  // ---- Entries --------------------------------------------------------------
  var ENTRY_COLS = 'id,track,full_name,email,phone,city,country,portfolio_url,social_handle,right_now,open_to,title,made_for,scenario_text,concept_text,drive_url,questions,consent,eligible,submitted_at,status,status_changed_at,created_at,updated_at';
  async function myEntries() {
    var c = await getChallenge();
    var r = await db.from('challenge_entries').select(ENTRY_COLS).eq('challenge_id', c.id).order('created_at');
    if (r.error) throw r.error;
    var entries = r.data || [];
    if (entries.length) {
      var f = await db.from('challenge_files').select('id,entry_id,kind,file_name,path,size_bytes,mime')
        .in('entry_id', entries.map(function (e) { return e.id; })).order('created_at');
      if (f.error) throw f.error;
      entries.forEach(function (e) { e.files = (f.data || []).filter(function (x) { return x.entry_id === e.id; }); });
    }
    return entries;
  }

  // Create or update the entry row; returns its id. Text fields only — files
  // and the final "send" are separate steps (see saveEntry).
  async function upsertEntryRow(entryId, fields) {
    var c = await getChallenge();
    if (entryId) {
      var u = await db.from('challenge_entries').update(fields).eq('id', entryId).select('id');
      if (u.error) throw u.error;
      if (!u.data || !u.data.length) throw new Error('closed');
      return entryId;
    }
    var s = await session();
    var ins = await db.from('challenge_entries')
      .insert(Object.assign({ challenge_id: c.id, user_id: s.user.id }, fields)).select('id').single();
    if (ins.error) throw ins.error;
    return ins.data.id;
  }

  // Images are re-encoded in the browser (longest side 2048 px, JPEG 0.85) so
  // a phone photo of 8 MB becomes ~1 MB — fits the 3 MB server limit and keeps
  // storage small. Falls back to the original if it is already small enough.
  function shrinkImage(file) {
    return new Promise(function (resolve) {
      if (file.size <= 1.5 * 1048576) { resolve(file); return; }
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function () {
        var max = 2048, w = img.naturalWidth, h = img.naturalHeight, k = Math.min(1, max / Math.max(w, h));
        var cv = document.createElement('canvas'); cv.width = Math.round(w * k); cv.height = Math.round(h * k);
        var ctx = cv.getContext('2d'); ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, cv.width, cv.height);
        ctx.drawImage(img, 0, 0, cv.width, cv.height);
        URL.revokeObjectURL(url);
        cv.toBlob(function (b) {
          if (!b || b.size >= file.size) { resolve(file); return; }
          resolve(new File([b], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' }));
        }, 'image/jpeg', 0.85);
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }

  function randomId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
    return (Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/[^a-z0-9]/g, '');
  }

  // Register the file row first (server checks count/size/type/path), then
  // upload to the private bucket (allowed only for a registered path). If the
  // upload fails the row is removed again.
  async function uploadFile(entryId, slotKey, file) {
    var slot = SLOTS[slotKey];
    if (slotKey === 'post') file = await shrinkImage(file);
    var ext = extOf(file.name); if (ext === 'jpeg') ext = 'jpg';
    var mime = MIME[ext] || file.type;
    var s = await session();
    var path = s.user.id + '/' + entryId + '/' + randomId() + '.' + ext;
    var reg = await db.from('challenge_files').insert({
      entry_id: entryId, user_id: s.user.id, kind: slot.kind,
      file_name: String(file.name).slice(0, 200), path: path, size_bytes: file.size, mime: mime,
    }).select('id').single();
    if (reg.error) throw reg.error;
    var up = await db.storage.from(BUCKET).upload(path, file, { contentType: mime, upsert: false });
    if (up.error) {
      await db.from('challenge_files').delete().eq('id', reg.data.id);
      throw up.error;
    }
  }

  async function removeFile(fileId) {
    var r = await db.from('challenge_files').delete().eq('id', fileId);
    if (r.error) throw r.error;
  }

  // Full save: text → removed files → new files → submit check. Returns
  // { ok, entryId, problem } where problem is the server's completeness code.
  async function saveEntry(opts) {
    var entryId = await upsertEntryRow(opts.entryId, opts.fields);
    // Tell the page the id at once: if a later upload fails it reloads this
    // draft from the server instead of re-uploading files that already went up.
    if (opts.onSaved) opts.onSaved(entryId);
    for (var i = 0; i < (opts.removeFileIds || []).length; i++) await removeFile(opts.removeFileIds[i]);
    for (var j = 0; j < (opts.newFiles || []).length; j++) {
      var nf = opts.newFiles[j];
      if (opts.onProgress) opts.onProgress(j + 1, opts.newFiles.length, nf.file.name);
      await uploadFile(entryId, nf.slot, nf.file);
    }
    var sub = await db.rpc('submit_challenge_entry', { p_entry: entryId });
    if (sub.error) throw sub.error;
    return { ok: sub.data === 'ok', entryId: entryId, problem: sub.data };
  }

  async function withdraw(entryId) {
    var r = await db.from('challenge_entries').delete().eq('id', entryId).select('id');
    if (r.error) throw r.error;
    if (!r.data || !r.data.length) throw new Error('closed');
  }

  async function fileUrl(path) {
    var r = await db.storage.from(BUCKET).createSignedUrl(path, 600);
    if (r.error || !r.data) return null;
    return r.data.signedUrl;
  }

  // Server error → sentence for the person filling in the form.
  function friendlyError(e) {
    var m = (e && (e.message || e.details)) || String(e || '');
    if (/challenge_file_limit/.test(m)) return 'That is more files than allowed for this field.';
    if (/challenge_file_too_big|exceeded the maximum allowed size|Payload too large/i.test(m)) return 'A file is too big.';
    if (/challenge_file_type|mime type/i.test(m)) return 'A file has a type we can’t accept.';
    if (/duplicate key.*challenge_entries/i.test(m)) return 'You already have an entry in this track — edit it from “Your entries”.';
    if (/row-level security|closed/i.test(m)) return 'Submissions are closed, or your session ended. Please reload the page.';
    if (/check constraint/i.test(m)) return 'Please check the highlighted fields.';
    if (/Failed to fetch|NetworkError/i.test(m)) return 'No connection. Your entry was not sent — please try again.';
    return m;
  }

  // ---- Judge ------------------------------------------------------------------
  async function isJudge() {
    var r = await db.rpc('is_challenge_admin');
    return !r.error && r.data === true;
  }
  async function judgeEntries() {
    var c = await getChallenge();
    var r = await db.from('challenge_entries').select(ENTRY_COLS + ',user_id')
      .eq('challenge_id', c.id).not('submitted_at', 'is', null).order('submitted_at', { ascending: false });
    if (r.error) throw r.error;
    var entries = r.data || [];
    var ids = entries.map(function (e) { return e.id; });
    var files = [], notes = [];
    if (ids.length) {
      var f = await db.from('challenge_files').select('id,entry_id,kind,file_name,path,size_bytes,mime').in('entry_id', ids);
      if (f.error) throw f.error; files = f.data || [];
      var n = await db.from('challenge_reviews').select('entry_id,notes,updated_at').in('entry_id', ids);
      if (n.error) throw n.error; notes = n.data || [];
    }
    entries.forEach(function (e) {
      e.files = files.filter(function (x) { return x.entry_id === e.id; });
      var nn = notes.find(function (x) { return x.entry_id === e.id; });
      e.notes = nn ? nn.notes || '' : '';
    });
    return entries;
  }
  async function setStatus(entryId, status) {
    var r = await db.rpc('set_challenge_status', { p_entry: entryId, p_status: status });
    if (r.error) throw r.error;
    if (r.data !== 'ok') throw new Error(r.data);
  }
  async function saveNotes(entryId, notes) {
    var r = await db.from('challenge_reviews').upsert({ entry_id: entryId, notes: notes, updated_at: new Date().toISOString() });
    if (r.error) throw r.error;
  }

  window.MMC = {
    TRACKS: TRACKS, STATUSES: STATUSES, SLOTS: SLOTS, GOOGLE_WEB_ENABLED: GOOGLE_WEB_ENABLED, extOf: extOf,
    getChallenge: getChallenge, isOpen: isOpen, session: session, onAuth: onAuth,
    signUp: signUp, signIn: signIn, signInGoogle: signInGoogle, resetPassword: resetPassword, signOut: signOut,
    myEntries: myEntries, saveEntry: saveEntry, withdraw: withdraw, fileUrl: fileUrl, friendlyError: friendlyError,
    isJudge: isJudge, judgeEntries: judgeEntries, setStatus: setStatus, saveNotes: saveNotes,
  };
})();
