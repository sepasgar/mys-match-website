// Shared Supabase client + helpers for the public MysMatch website.
//
// Loaded after the supabase-js UMD bundle (see each page's <head>). Uses the
// PUBLIC anon key — safe to expose; row access is governed by RLS on the
// Supabase side. The website only ever touches:
//   * events  (read: anon policy exposes publish_to_web && !is_private rows)
//   * RPC get_event_registration_counts[_batch]  (read counts, granted to anon)
//   * RPC register_web_attendee                  (guest sign-up, granted to anon)
//   * RPC get_event_attendees                    (creator dashboard, authed)
// There is NO matching/discovery surface here by design.
(function () {
  const SUPABASE_URL = 'https://fgekipaehyzizwvaiijz.supabase.co';
  // Public anon key (same one shipped in the app bundle). Not a secret.
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZnZWtpcGFlaHl6aXp3dmFpaWp6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY2NzQ2NjUsImV4cCI6MjA4MjI1MDY2NX0.UXBWicDvFtBK9_h826tQRMXMgFqzLnbNvnihWgnieXQ';

  if (!window.supabase || !window.supabase.createClient) {
    console.error('[MM] supabase-js failed to load — check the CDN <script> tag.');
    return;
  }

  const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  // --- Counts (sum party_size; includes web guests via the unioned RPC) -----
  async function countsBatch(ids) {
    const map = {};
    if (!ids || ids.length === 0) return map;
    const { data, error } = await db.rpc('get_event_registration_counts_batch', { p_event_ids: ids });
    if (error) { console.error('[MM] countsBatch', error.message); return map; }
    (data || []).forEach((r) => { map[r.event_id] = { total: r.total, male: r.male, female: r.female }; });
    return map;
  }

  async function getCounts(id) {
    const { data, error } = await db.rpc('get_event_registration_counts', { p_event_id: id });
    if (error || !data) return { total: 0, male: 0, female: 0 };
    const row = Array.isArray(data) ? data[0] : data;
    return { total: row && row.total || 0, male: row && row.male || 0, female: row && row.female || 0 };
  }

  // --- Public event listing -------------------------------------------------
  // Since Oct 2026 the website lists EVERY non-private upcoming event. Events
  // without web registration ("Register on web too" off in the app) come back
  // as previews: e.web_registration === false and NO date / time / location /
  // city fields — the server leaves them out (get_web_events), so they can't be
  // read from the page source. Pages show "Download the app to see the location
  // and time" for those. Order is by the real start moment, done server-side.
  async function listEvents() {
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
    const { data, error } = await db.rpc('get_web_events', { p_from: startOfToday.toISOString() });
    if (error) { console.error('[MM] listEvents', error.message); return []; }
    const events = Array.isArray(data) ? data : [];
    const counts = await countsBatch(events.map((e) => e.id));
    events.forEach((e) => { e._counts = counts[e.id] || { total: 0, male: 0, female: 0 }; });
    return events;
  }

  // One event: full details when web registration is on, a preview otherwise
  // (see listEvents), null when it doesn't exist or is private.
  async function getEvent(id) {
    const { data, error } = await db.rpc('get_web_event', { p_id: id });
    if (error) { console.error('[MM] getEvent', error.message); return null; }
    return data || null;
  }

  // --- Guest registration (server-validated by the SECURITY DEFINER RPC) ----
  async function registerGuest(opts) {
    const { data, error } = await db.rpc('register_web_attendee', {
      p_event_id: opts.eventId,
      p_name: opts.name,
      p_email: opts.email,
      p_answers: opts.answers || {},
      p_user_gender: opts.gender || null,
      p_party_size: opts.partySize || 1,
      p_document_url: opts.documentUrl || null,
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true, id: data };
  }

  // Upload a guest's document to the private event-documents bucket under the
  // event's web/ folder — allowed for anon by a scoped storage policy (path must
  // be `{eventId}/web/...` under a web-published event). Returns the storage path.
  async function uploadGuestDocument(eventId, file) {
    const ext = file.type === 'image/png' ? 'png' : (file.type === 'image/webp' ? 'webp' : 'jpg');
    const rand = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : (Date.now() + '-' + Math.random().toString(36).slice(2));
    const path = eventId + '/web/' + rand + '.' + ext;
    const { error } = await db.storage.from('event-documents').upload(path, file, { contentType: file.type, upsert: false });
    if (error) return { ok: false, error: error.message };
    return { ok: true, path: path };
  }

  // Creator-only: sign a private event document for viewing (1h URL). Works for
  // both app and web docs — storage read RLS authorizes the event creator.
  async function signEventDoc(path) {
    const { data, error } = await db.storage.from('event-documents').createSignedUrl(path, 3600);
    if (error || !data) return null;
    return data.signedUrl;
  }

  // --- Creator auth + dashboard --------------------------------------------
  async function signIn(email, password) {
    const { data, error } = await db.auth.signInWithPassword({ email, password });
    if (error) return { ok: false, error: error.message };
    return { ok: true, user: data.user };
  }

  async function signOut() { await db.auth.signOut(); }

  async function currentUser() {
    const { data } = await db.auth.getUser();
    return data ? data.user : null;
  }

  // Events owned by the logged-in creator (RLS lets a creator read their own
  // rows regardless of publish_to_web/private, so the dashboard shows them all).
  async function myEvents(userId) {
    const { data, error } = await db
      .from('events')
      .select('id,title,date,starts_at,timezone,location,city,publish_to_web,is_private,max_capacity')
      .eq('creator_id', userId)
      .order('starts_at', { ascending: false });
    if (error) { console.error('[MM] myEvents', error.message); return []; }
    const events = data || [];
    const counts = await countsBatch(events.map((e) => e.id));
    events.forEach((e) => { e._counts = counts[e.id] || { total: 0, male: 0, female: 0 }; });
    return events;
  }

  // Combined app + web attendees for an event (creator-authorized in SQL).
  async function eventAttendees(eventId) {
    const { data, error } = await db.rpc('get_event_attendees', { p_event_id: eventId });
    if (error) { console.error('[MM] eventAttendees', error.message); return []; }
    return data || [];
  }

  // --- Public jobs board (Sept 2026) ----------------------------------------
  // Every job from the app, read through SECURITY DEFINER RPCs that return a
  // fixed column set (no application questions, no poster id) and skip deleted
  // organizations. The jobs table itself stays signed-in only. Applying is
  // app-only, so there is nothing to write from the web.
  async function listJobs() {
    const { data, error } = await db.rpc('get_public_jobs', { p_limit: 200 });
    if (error) { console.error('[MM] listJobs', error.message); return []; }
    return data || [];
  }

  async function getJob(id) {
    const { data, error } = await db.rpc('get_public_job', { p_id: id });
    if (error) { console.error('[MM] getJob', error.message); return null; }
    return (Array.isArray(data) ? data[0] : data) || null;
  }

  // Same labels as the app's jobs board.
  const JOB_TYPE_LABELS = {
    full_time: 'Full-time', part_time: 'Part-time', mini_job: 'Mini-job',
    internship: 'Internship', volunteer: 'Volunteer',
  };

  // "Posted today" / "Posted 3 days ago" — jobs have no closing date yet, so
  // the age is the one freshness signal a visitor gets.
  function postedAgo(iso) {
    const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
    if (!(days >= 0)) return '';
    if (days === 0) return 'Posted today';
    if (days === 1) return 'Posted yesterday';
    if (days < 30) return 'Posted ' + days + ' days ago';
    const months = Math.floor(days / 30);
    return 'Posted ' + months + (months === 1 ? ' month' : ' months') + ' ago';
  }

  window.MM = {
    db, SUPABASE_URL,
    listEvents, getEvent, getCounts, countsBatch, registerGuest,
    uploadGuestDocument, signEventDoc,
    signIn, signOut, currentUser, myEvents, eventAttendees,
    listJobs, getJob, JOB_TYPE_LABELS, postedAgo,
  };
})();
