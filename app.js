/* Ζωγραφιά με Ζωή AI — frontend brain.
   Single-file vanilla JS. Talks to zografia-backend.onrender.com.
*/

const BACKEND = (window.ZOGRAFIA_BACKEND || 'https://zografia-backend.onrender.com').replace(/\/+$/, '');
const URL_ANIMATE  = BACKEND + '/api/animate-drawing';
const URL_STATUS   = BACKEND + '/api/animate-status';
const URL_TTS      = BACKEND + '/api/tts';
const URL_USAGE    = BACKEND + '/api/usage';
const URL_CHECKOUT = BACKEND + '/api/checkout';
const URL_OWNER    = BACKEND + '/api/owner-unlock';
const URL_DL_PROXY = BACKEND + '/api/download-video';

function getDeviceId() {
  try {
    let id = localStorage.getItem('zografia_device_id');
    if (id && id.length >= 8) return id;
    id = (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'd-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 14);
    localStorage.setItem('zografia_device_id', id);
    return id;
  } catch (e) {
    return 'd-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 14);
  }
}
const DEVICE_ID = getDeviceId();

const $ = (s, r = document) => r.querySelector(s);
const app = $('#app');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function toast(msg, ms = 2400) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

/* ---------- State ---------- */
/* ---------- i18n ---------- */
// Two-locale app: T('el', 'en') returns the active language string. We keep
// translations inline at the call site so context never gets lost.
const SUPPORTED_LANGS = ['el', 'en'];
let LANG = (function () {
  try {
    const stored = localStorage.getItem('zografia_lang');
    if (SUPPORTED_LANGS.includes(stored)) return stored;
  } catch (e) {}
  const nav = (navigator.language || 'el').toLowerCase();
  return nav.startsWith('en') ? 'en' : 'el';
})();
function T(el, en) { return LANG === 'en' ? en : el; }
function setLang(l) {
  if (!SUPPORTED_LANGS.includes(l) || l === LANG) return;
  LANG = l;
  try { localStorage.setItem('zografia_lang', l); } catch (e) {}
  document.documentElement.lang = l;
  const btn = $('#langBtn'); if (btn) btn.textContent = (l === 'el' ? 'EN' : 'EL');
  render();
}

const state = {
  screen: 'home',
  childName: localStorage.getItem('zografia_child_name') || '',
  customMotion: '',            // optional Greek motion hint (cleared after each animate)
  draft: null,                 // { image: dataURL, child, title, mood }
  loading: false,
  loadingMsg: '',
  result: null,                // animation response
  audio: null,                 // current Audio instance
  audioPlaying: false,
  usage: null,                 // { plan, used, quota, remaining, is_active, is_paid, ... }
  checkoutLoading: '',
  checkoutError: '',
  gallery: loadGallery(),
  /* AKOOL video state for current result */
  video: { task_id: '', status: 'none', url: '', polling: false },
};

function loadGallery() {
  try { return JSON.parse(localStorage.getItem('zografia_gallery') || '[]'); }
  catch (e) { return []; }
}
function saveGallery() {
  try { localStorage.setItem('zografia_gallery', JSON.stringify(state.gallery.slice(0, 24))); }
  catch (e) {}
}

/* ---------- Image resize before upload ---------- */
function resizeImageFile(file, maxSize = 1024, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Δεν διαβάστηκε το αρχείο.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Δεν αναγνωρίστηκε ως εικόνα.'));
      img.onload = () => {
        let { width: w, height: h } = img;
        const scale = Math.min(1, maxSize / Math.max(w, h));
        w = Math.round(w * scale);
        h = Math.round(h * scale);
        const canvas = $('#resizeCanvas') || document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        try {
          const url = canvas.toDataURL('image/jpeg', quality);
          resolve(url);
        } catch (e) { reject(e); }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/* ---------- API ---------- */
async function fetchUsage() {
  try {
    const res = await fetch(URL_USAGE, { headers: { 'X-Device-Id': DEVICE_ID } });
    if (res.ok) state.usage = await res.json();
  } catch (e) {}
}

async function callAnimate(payload) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  // Tell the backend which language to write the story in.
  const body = Object.assign({ lang: LANG }, payload);
  const res = await fetch(URL_ANIMATE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-Id': DEVICE_ID },
    body: JSON.stringify(body),
    signal: ctrl.signal,
  });
  clearTimeout(timer);
  if (res.status === 402) { const err = new Error('quota_exceeded'); err.code = 402; throw err; }
  if (!res.ok) {
    let m = T('Δεν τα κατάφερα τώρα. Δοκίμασε ξανά.', "Couldn't do it now. Try again.");
    try { const j = await res.json(); if (j && j.detail) m = String(j.detail); } catch (e) {}
    throw new Error(m);
  }
  return await res.json();
}

let _currentAudio = null;
async function playFromUrl(url) {
  if (!url) return;
  try { if (_currentAudio) { _currentAudio.pause(); _currentAudio.src = ''; } } catch (e) {}
  _currentAudio = null;
  state.audioPlaying = false;
  const audio = new Audio(url);
  audio.preload = 'auto';
  _currentAudio = audio;
  state.audioPlaying = true;
  audio.onended = () => {
    state.audioPlaying = false;
    if (_currentAudio === audio) _currentAudio = null;
    render();
  };
  audio.onerror = () => {
    state.audioPlaying = false;
    toast('Δεν μπόρεσα να παίξω τον ήχο.');
    render();
  };
  render();
  try { await audio.play(); }
  catch (e) {
    state.audioPlaying = false;
    toast('Πάτα «Άκου ξανά» για να ξεκινήσει η φωνή.');
    render();
  }
}

async function playTTS(text) {
  if (!text) return;
  // Prefer the audio_url returned by /api/animate-drawing (no extra OpenAI call).
  const cached = state.result && state.result.audio_url;
  if (cached) return playFromUrl(cached);
  // Fallback: synthesize on-demand from /api/tts.
  try { if (_currentAudio) { _currentAudio.pause(); _currentAudio.src = ''; } } catch (e) {}
  _currentAudio = null;
  state.audioPlaying = false;
  render();
  try {
    const res = await fetch(URL_TTS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-Id': DEVICE_ID },
      body: JSON.stringify({ text, voice: 'shimmer' }),
    });
    if (!res.ok) throw new Error('tts_failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    _currentAudio = audio;
    state.audioPlaying = true;
    audio.onended = () => {
      try { URL.revokeObjectURL(url); } catch (e) {}
      state.audioPlaying = false;
      if (_currentAudio === audio) _currentAudio = null;
      render();
    };
    audio.onerror = () => {
      try { URL.revokeObjectURL(url); } catch (e) {}
      state.audioPlaying = false;
      toast('Δεν μπόρεσα να παίξω τον ήχο.');
      render();
    };
    render();
    await audio.play();
  } catch (e) {
    state.audioPlaying = false;
    toast('Δεν μπόρεσα να παίξω τον ήχο τώρα.');
    render();
  }
}

function stopAudio() {
  try { if (_currentAudio) { _currentAudio.pause(); _currentAudio.src = ''; } } catch (e) {}
  _currentAudio = null;
  state.audioPlaying = false;
  render();
}

/* ---------- AKOOL video poll ---------- */
let _videoPollTimer = null;
let _videoPollAttempts = 0;

function stopVideoPoll() {
  if (_videoPollTimer) { clearTimeout(_videoPollTimer); _videoPollTimer = null; }
  state.video.polling = false;
}

function startVideoPoll(taskId) {
  stopVideoPoll();
  state.video = { task_id: taskId, status: 'queued', url: '', polling: true };
  _videoPollAttempts = 0;
  const tick = async () => {
    _videoPollAttempts += 1;
    try {
      const res = await fetch(URL_STATUS + '?task_id=' + encodeURIComponent(taskId));
      const data = await res.json().catch(() => ({}));
      const s = data.status || 'queued';
      state.video.status = s;
      if (s === 'success' && data.video_url) {
        state.video.url = data.video_url;
        state.video.polling = false;
        _videoPollTimer = null;
        // also attach to current result so it can be saved to gallery
        if (state.result) state.result._video_url = data.video_url;
        render();
        return;
      }
      if (s === 'failed') {
        state.video.polling = false;
        _videoPollTimer = null;
        render();
        return;
      }
    } catch (e) { /* keep polling */ }
    // up to ~6 minutes (45 ticks × 8s = 360s) — AKOOL can be slow under load
    if (_videoPollAttempts >= 45) {
      state.video.status = 'timeout';
      state.video.polling = false;
      _videoPollTimer = null;
      render();
      return;
    }
    render();
    _videoPollTimer = setTimeout(tick, 8000);
  };
  // first poll after 6 sec to give AKOOL a moment
  _videoPollTimer = setTimeout(tick, 6000);
}

async function ownerUnlock() {
  const inp = $('#ownerEmail');
  const email = (inp && inp.value || '').trim();
  if (!email || !email.includes('@')) {
    toast('Βάλε ένα έγκυρο email.');
    return;
  }
  try {
    const res = await fetch(URL_OWNER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-Id': DEVICE_ID },
      body: JSON.stringify({ email }),
    });
    if (res.ok) {
      const data = await res.json();
      state.usage = data;
      toast('✓ Ενεργοποιήθηκε η επαγγελματική χρήση!');
      render();
    } else if (res.status === 403) {
      toast('Το email δεν είναι στη λίστα κατόχων.');
    } else {
      toast('Σφάλμα. Δοκίμασε ξανά.');
    }
  } catch (e) {
    toast('Πρόβλημα σύνδεσης.');
  }
}

async function startCheckout(planId) {
  state.checkoutLoading = planId;
  state.checkoutError = '';
  render();
  try {
    const res = await fetch(URL_CHECKOUT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-Id': DEVICE_ID },
      body: JSON.stringify({ plan: planId }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.url) { window.location.href = data.url; return; }
    state.checkoutError = data.detail
      ? `Οι πληρωμές δεν είναι έτοιμες ακόμα (${data.detail}). Δοκίμασε σε λίγο.`
      : 'Δεν μπόρεσα να ανοίξω την πληρωμή. Δοκίμασε ξανά.';
  } catch (e) {
    state.checkoutError = 'Πρόβλημα σύνδεσης για την πληρωμή. Δοκίμασε σε λίγο.';
  } finally {
    state.checkoutLoading = '';
    render();
  }
}

/* ---------- Plan badge ---------- */
function planLabel(u) {
  if (!u) return '';
  if (u.plan === 'owner' && u.is_active) return T('🔑 Owner · Απεριόριστα', '🔑 Owner · Unlimited');
  if (u.plan === 'yearly' && u.is_active) {
    const rem = (u.remaining == null) ? '∞' : u.remaining;
    return T(`✓ Ετήσιο · ${rem} ζωντανέματα ακόμα`, `✓ Yearly · ${rem} animations left`);
  }
  if (u.plan === 'full' && u.is_active) {
    const rem = (u.remaining == null) ? '∞' : u.remaining;
    return T(`✓ Full · ${rem} ζωντανέματα ακόμα`, `✓ Full · ${rem} animations left`);
  }
  if (u.plan === 'basic' && u.is_active) {
    const rem = (u.remaining == null) ? '∞' : u.remaining;
    return T(`Basic · ${rem} ζωντανέματα ακόμα`, `Basic · ${rem} animations left`);
  }
  const rem = (u.remaining == null) ? '?' : u.remaining;
  return T(`Δωρεάν · ${rem}/${u.quota ?? '?'} ζωντανέματα`,
           `Free · ${rem}/${u.quota ?? '?'} animations`);
}
function planBadge() {
  const u = state.usage;
  if (!u) return '';
  const isFull = u.plan === 'full' && u.is_active;
  const low = u.plan === 'trial' && (u.remaining ?? 9) <= 1;
  const cls = isFull ? 'full' : (low ? 'low' : '');
  return `<button class="plan-badge ${cls}" data-go="paywall">${esc(planLabel(u))}</button>`;
}

/* ---------- Nav ---------- */
function bottomNav(active) {
  const items = [
    ['home',     '🏠', T('Αρχική', 'Home')],
    ['gallery',  '🖼️', T('Άλμπουμ', 'Album')],
    ['paywall',  '💎', T('Πακέτα', 'Plans')],
    ['contact',  '💬', T('Βοήθεια', 'Help')],
  ];
  return `<div class="bottom-nav">${items.map(([id, ico, lbl]) =>
    `<button class="${active === id ? 'active' : ''}" data-go="${id}"><span class="ico">${ico}</span>${esc(lbl)}</button>`
  ).join('')}</div>`;
}

/* ---------- Views ---------- */
function homeView() {
  const last = state.gallery.slice(0, 4);
  const dateLocale = LANG === 'en' ? 'en-GB' : 'el-GR';
  return `
  <section class="screen">
    <div class="hero">
      <img class="logo" src="assets/logo.png" alt="${T('Ζωγραφιά με Ζωή AI', 'Drawing Alive AI')}" />
      <h1>${T('Ζωγραφιά με Ζωή AI', 'Drawing Alive AI')}</h1>
      <p class="tagline">${T(
        `Η ζωγραφιά σου <b class="rainbow-text">ζωντανεύει!</b> ✨<br>Γίνεται βίντεο, μιλάει και σου λέει μια μαγική ιστορία.`,
        `Your drawing <b class="rainbow-text">comes alive!</b> ✨<br>It turns into a video, talks and tells you a magical story.`
      )}</p>
      <div class="pill">${esc(planLabel(state.usage) || T('Δωρεάν δοκιμή', 'Free trial'))}</div>
    </div>

    <button class="btn primary big wide" data-go="upload">${T('✨ Ζωντάνεψε τη ζωγραφιά μου!', '✨ Bring my drawing to life!')}</button>

    <div class="card">
      <b>🎨 ${T('Πώς δουλεύει', 'How it works')}</b>
      <small>${T(
        '1) Ζωγραφίζεις σε χαρτί. 2) Τραβάς φωτό. 3) Πατάς «Ζωντάνεψε». 4) Η AI φτιάχνει ιστορία και τη λέει με χαρούμενη φωνή!',
        '1) Draw on paper. 2) Take a photo. 3) Tap «Bring to life». 4) The AI writes a story and reads it in a cheerful voice!'
      )}</small>
    </div>

    ${last.length ? `
      <div class="card">
        <b style="display:flex;align-items:center;gap:8px">🖼️ ${T('Πρόσφατες', 'Recent')} <button class="btn ghost" data-go="gallery" style="margin-left:auto;padding:6px 10px;font-size:13px">${T('Όλες', 'All')}</button></b>
        <div class="gallery-grid" style="margin-top:10px">
          ${last.map(g => `
            <button class="gallery-card" data-open="${esc(g.id)}">
              <img src="${esc(g.thumb || g.image)}" alt="${esc(g.title || T('Ζωγραφιά', 'Drawing'))}">
              <b>${esc(g.title || T('Η ζωγραφιά μου', 'My drawing'))}</b>
              <small>${new Date(g.timestamp).toLocaleDateString(dateLocale)}</small>
            </button>
          `).join('')}
        </div>
      </div>
    ` : ''}

    ${bottomNav('home')}
  </section>`;
}

function uploadView() {
  const hasDraft = !!(state.draft && state.draft.image);
  return `
  <section class="screen">
    <div class="topbar">
      <button class="icon-btn" data-go="home">←</button>
      <h2>${T('Νέα ζωγραφιά', 'New drawing')}</h2>
      ${planBadge() || '<span style="width:44px"></span>'}
    </div>

    <div class="card">
      <div class="draw-area" style="position:relative">
        ${hasDraft
          ? `<img src="${esc(state.draft.image)}" alt="${T('Η ζωγραφιά σου', 'Your drawing')}">
             <button type="button" class="draft-delete-btn" data-action="draft-delete"
                     aria-label="${T('Διαγραφή', 'Delete')}"
                     title="${T('Διαγραφή & νέα ζωγραφιά', 'Delete & pick new')}">×</button>`
          : `<div class="draw-empty">
               <div class="big-emoji">🖍️</div>
               <b>${T('Πώς θες να φτιάξεις τη ζωγραφιά;', 'How would you like to make the drawing?')}</b>
               <small>${T('Διάλεξε τρόπο πιο κάτω.', 'Choose a method below.')}</small>
             </div>`
        }
      </div>
      ${hasDraft ? `
        <div class="row" style="margin-top:10px">
          <button class="btn gold wide" data-go="decorate">🎨 ${T('Διακόσμησε τη φωτό', 'Decorate the photo')}</button>
        </div>
        <div class="row" style="margin-top:8px">
          <button class="btn ghost wide" data-action="draft-delete">🗑️ ${T('Διαγραφή & νέα ζωγραφιά', 'Delete & pick new')}</button>
        </div>` : `
        <div class="row" style="margin-top:12px">
          <button class="btn gold" data-action="open-camera">📷 ${T('Τράβα φωτό', 'Take photo')}</button>
          <button class="btn ghost" data-action="pick-file">📁 ${T('Από αρχείο', 'From file')}</button>
        </div>
        <div class="row" style="margin-top:10px">
          <button class="btn primary wide" data-go="coloring">🎨 ${T('Ζωγράφισε εδώ μέσα', 'Draw inside the app')}</button>
        </div>`}
    </div>

    <div class="card">
      <b>👤 ${T("Όνομα παιδιού", "Child's name")} <small style="font-weight:400">(${T('προαιρετικό', 'optional')})</small></b>
      <div class="form-row" style="margin-top:8px">
        <input id="childName" type="text" placeholder="${T('π.χ. Νικόλας', 'e.g. Sophia')}" value="${esc(state.childName)}" maxlength="40" />
      </div>
    </div>

    <div class="card">
      <b>✨ ${T('Τι θέλεις να κάνει η ζωγραφιά;', 'What should the drawing do?')} <small style="font-weight:400">(${T('προαιρετικό', 'optional')})</small></b>
      <small style="display:block;margin-top:4px;color:var(--muted)">${T(
        'Γράψε σύντομα — η ζωγραφιά μένει η ίδια, μόνο η κίνηση αλλάζει.',
        'Write a short hint — the drawing stays the same, only the motion changes.'
      )}</small>
      <div class="form-row" style="margin-top:10px">
        <textarea id="customMotion" rows="3" maxlength="240"
                  placeholder="${T('π.χ. ο ήλιος να χαμογελάει, τα παιδιά να χορεύουν απαλά', 'e.g. the sun smiles, the children sway gently')}"
                  style="width:100%;border:1.5px solid #e8d8ff;border-radius:14px;padding:12px 14px;font-size:15px;font-family:inherit;resize:vertical;background:#fff;color:var(--ink);min-height:74px">${esc(state.customMotion || '')}</textarea>
      </div>
    </div>

    <button class="btn primary big wide" data-action="animate" ${hasDraft ? '' : 'disabled'}>
      ${hasDraft ? T('✨ Ζωντάνεψε τη ζωγραφιά!', '✨ Bring the drawing to life!') : T('Πρώτα βάλε μια ζωγραφιά', 'First add a drawing')}
    </button>

    ${bottomNav('home')}
  </section>`;
}

function loadingView() {
  return `
  <section class="screen">
    <div class="loading">
      <div class="spinner" aria-hidden="true"></div>
      <h2>${esc(state.loadingMsg || T('Ζωντανεύω τη ζωγραφιά σου…', 'Bringing your drawing to life…'))}</h2>
      <small>${T(
        `Μια στιγμή — ${state.childName?.trim() || 'φίλε μου'}, η AI κοιτάει προσεκτικά κάθε λεπτομέρεια ✨`,
        `One moment — ${state.childName?.trim() || 'friend'}, the AI is looking at every detail carefully ✨`
      )}</small>
    </div>
    ${bottomNav('home')}
  </section>`;
}

function videoBlock(r) {
  // Already have a finished video (from current poll or from gallery)?
  const finishedUrl = (state.video && state.video.url) || (r && r._video_url) || '';
  if (finishedUrl) {
    return `
      <div class="video-wrap">
        <video src="${esc(finishedUrl)}" controls playsinline preload="metadata" poster="${esc(r._image || '')}"></video>
      </div>
      <div class="audio-row" style="margin:-4px 0 10px">
        <button class="btn ghost" onclick="(function(u){const a=document.createElement('a');a.href=u;a.download='zografia-video.mp4';document.body.appendChild(a);a.click();document.body.removeChild(a);})('${esc(finishedUrl)}')">⬇️ Κατέβασε το βίντεο</button>
      </div>
    `;
  }
  const v = state.video || {};
  if (v.polling || v.status === 'queued' || v.status === 'processing') {
    const ticks = (typeof _videoPollAttempts === 'number') ? _videoPollAttempts : 0;
    const pct = Math.min(95, Math.round(5 + (ticks / 22) * 90));
    const phaseLabel = (v.status === 'processing')
      ? T('Φτιάχνω την κίνηση…', 'Painting the motion…')
      : (ticks < 4 ? T('Ξεκινάω το AI…', 'Starting the AI…') : T('Στην ουρά του AI…', 'In the AI queue…'));
    return `
      <div class="video-wait">
        <div style="display:flex;align-items:center;gap:12px;width:100%">
          <span class="pulse" aria-hidden="true"></span>
          <div style="flex:1;min-width:0">
            <b>🎬 ${esc(phaseLabel)}</b>
            <small>${T('~2-3 λεπτά. Στο μεταξύ άκου την ιστορία!', '~2-3 minutes. Meanwhile, listen to the story!')}</small>
          </div>
          <span class="ai-pct" aria-live="polite">${pct}%</span>
        </div>
        <div class="ai-progress" aria-label="${T('Πρόοδος βίντεο', 'Video progress')}">
          <div class="ai-progress-bar" style="width:${pct}%"></div>
          <div class="ai-progress-shimmer"></div>
        </div>
      </div>`;
  }
  if (v.status === 'failed' || v.status === 'timeout') {
    return `
      <div class="video-wait" style="background:linear-gradient(135deg,#ffe0e0,#fff0f0);border-color:#ffc7c7">
        <span style="font-size:22px">⚠️</span>
        <div>
          <b>${T('Το βίντεο δεν τα κατάφερε αυτή τη φορά.', 'The video didn’t make it this time.')}</b>
          <small>${T('Η φωνή + η ιστορία μένουν εδώ — δοκίμασε ξανά αργότερα.', 'The voice + story stay here — try again later.')}</small>
        </div>
      </div>`;
  }
  return '';
}

function resultView() {
  const r = state.result;
  if (!r) { state.screen = 'home'; return homeView(); }
  const linesHTML = (r.lines || []).map(l => `
    <div class="bubble"><b>${esc(l.speaker || 'η ζωγραφιά')}</b><p>${esc(l.text || '')}</p></div>
  `).join('');

  // The magic: once AKOOL returns the animated MP4, swap the static drawing
  // photo for the actual video inside the same frame so the child sees their
  // own drawing literally come alive in place.
  const videoUrl = (state.video && state.video.url) || r._video_url || '';
  const stillImage = r._image || (state.draft && state.draft.image) || '';
  const heroBlock = videoUrl
    ? `<div class="result-image is-video">
         <video src="${esc(videoUrl)}" controls playsinline preload="metadata"
                poster="${esc(stillImage)}" autoplay muted loop
                style="display:block;width:100%;height:auto;border-radius:18px;background:#fff"></video>
         <span class="sparkle s1">✨</span>
         <span class="sparkle s2">⭐</span>
         <span class="sparkle s3">💫</span>
         <span class="sparkle s4">✨</span>
       </div>`
    : `<div class="result-image">
         <img src="${esc(stillImage)}" alt="Η ζωγραφιά σου">
         <span class="sparkle s1">✨</span>
         <span class="sparkle s2">⭐</span>
         <span class="sparkle s3">💫</span>
         <span class="sparkle s4">✨</span>
       </div>`;

  return `
  <section class="screen">
    <div class="topbar">
      <button class="icon-btn" data-go="home">←</button>
      <h2>${esc(r.title || T('Η ζωγραφιά σου ζωντάνεψε!', 'Your drawing came alive!'))}</h2>
      <button class="icon-btn" data-action="reanimate" title="${T('Νέα ιστορία', 'New story')}">🔁</button>
    </div>

    <div class="result-card">
      ${heroBlock}

      ${videoUrl
        ? `<div class="audio-row" style="margin:8px 0 14px">
             <button class="btn primary" data-action="share">📤 ${T('Στείλε', 'Send')}</button>
             <button class="btn gold" data-action="download-video">💾 ${T('Αποθήκευση', 'Save')}</button>
             <button class="btn ghost" data-action="play-browser">📺 ${T('Παίξε', 'Play')}</button>
           </div>`
        : videoBlock(r)}

      ${r.what_i_see ? `<div class="card highlight" style="margin-bottom:12px"><b>👀 ${T('Τι βλέπω', 'What I see')}</b><small>${esc(r.what_i_see)}</small></div>` : ''}

      <p class="story">${esc(r.story || '')}</p>

      ${linesHTML ? `<div class="lines">${linesHTML}</div>` : ''}

      ${r.follow_up ? `<div class="follow-up">💜 ${esc(r.follow_up)}</div>` : ''}

      <div class="audio-row">
        <button class="btn primary" data-action="${state.audioPlaying ? 'audio-stop' : 'audio-play'}">
          ${state.audioPlaying ? T('⏸️ Παύση', '⏸️ Pause') : T('🔊 Άκου ξανά', '🔊 Listen again')}
        </button>
        <button class="btn gold" data-action="save-gallery">💾 ${T('Αποθήκευση', 'Save')}</button>
      </div>
      <div class="audio-row">
        <button class="btn ghost" data-go="upload">🖼️ ${T('Νέα ζωγραφιά', 'New drawing')}</button>
        <button class="btn ghost" data-action="share">📤 ${T('Διαμοίρασε', 'Share')}</button>
      </div>
    </div>

    ${bottomNav('home')}
  </section>`;
}

function galleryView() {
  const dateLocale = LANG === 'en' ? 'en-GB' : 'el-GR';
  if (!state.gallery.length) {
    return `
    <section class="screen">
      <div class="topbar"><button class="icon-btn" data-go="home">←</button><h2>${T('Το άλμπουμ μου', 'My album')}</h2><span style="width:44px"></span></div>
      <div class="card" style="text-align:center;padding:30px">
        <div style="font-size:64px">🖼️</div>
        <b style="margin-top:10px">${T('Άδειο ακόμα', 'Empty for now')}</b>
        <small>${T('Φτιάξε την πρώτη σου ζωντανή ζωγραφιά!', 'Create your first living drawing!')}</small>
        <button class="btn primary wide" style="margin-top:14px" data-go="upload">${T('✨ Ξεκίνα', '✨ Start')}</button>
      </div>
      ${bottomNav('gallery')}
    </section>`;
  }
  return `
  <section class="screen">
    <div class="topbar"><button class="icon-btn" data-go="home">←</button><h2>${T('Το άλμπουμ μου', 'My album')}</h2><button class="icon-btn" data-action="gallery-clear" title="${T('Καθαρισμός', 'Clear')}">🗑️</button></div>
    <div class="gallery-grid">
      ${state.gallery.map(g => `
        <button class="gallery-card" data-open="${esc(g.id)}">
          <img src="${esc(g.thumb || g.image)}" alt="${esc(g.title || T('Ζωγραφιά', 'Drawing'))}">
          <b>${esc(g.title || T('Η ζωγραφιά μου', 'My drawing'))}</b>
          <small>${new Date(g.timestamp).toLocaleDateString(dateLocale)}</small>
        </button>
      `).join('')}
    </div>
    ${bottomNav('gallery')}
  </section>`;
}

function planCard(opts) {
  const loading = state.checkoutLoading === opts.id;
  const bullets = (opts.bullets || []).map(b => `<li>${esc(b)}</li>`).join('');
  return `
  <div class="card pay-card ${opts.featured ? 'featured' : ''}">
    ${opts.badge ? `<div class="badge">${esc(opts.badge)}</div>` : ''}
    <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap">
      <b style="font-size:21px">${esc(opts.name)}</b>
      <span class="price" style="margin-left:auto">${esc(opts.price)}<small>${esc(opts.period)}</small></span>
    </div>
    <ul>${bullets}</ul>
    <button class="btn ${opts.featured ? 'primary' : 'gold'} wide" data-plan="${esc(opts.id)}" ${loading ? 'disabled' : ''}>
      ${loading ? T('Μια στιγμή…', 'One moment…') : T('Επιλογή', 'Choose')}
    </button>
  </div>`;
}

function paywallView() {
  const u = state.usage || {};
  const out = u.plan === 'trial' && (u.remaining ?? 1) <= 0;
  return `
  <section class="screen">
    <div class="topbar"><button class="icon-btn" data-go="home">←</button><h2>💎 ${T('Πακέτα', 'Plans')}</h2><span style="width:44px"></span></div>
    <div class="card">
      <b>${out
        ? T('💜 Η δωρεάν δοκιμή τελείωσε', '💜 Your free trial is over')
        : T('✨ Πάμε για περισσότερα ζωντανέματα!', '✨ Time for more animations!')}</b>
      <small>${out
        ? T('Διάλεξε ένα πακέτο για να συνεχίσεις χωρίς όρια.', 'Pick a plan to keep going without limits.')
        : T('Με τη συνδρομή ξεκλειδώνεις περισσότερα ή απεριόριστα ζωντανέματα.', 'A subscription unlocks more or unlimited animations.')}</small>
      ${state.usage ? `<div style="margin-top:10px">${planBadge()}</div>` : ''}
    </div>

    ${planCard({
      id: 'basic_monthly', name: 'Basic',
      price: T('2,99€', '€2.99'), period: T(' / μήνα', ' / month'),
      bullets: [
        T('10 ζωντανέματα τον μήνα', '10 animations per month'),
        T('Premium γυναικεία φωνή', 'Premium female voice'),
        T('Άλμπουμ ζωγραφιών', 'Drawings album'),
        T('Ακύρωση όποτε θες', 'Cancel anytime'),
      ]
    })}
    ${planCard({
      id: 'full_monthly', featured: true, badge: T('Πιο αγαπημένο', 'Most loved'),
      name: 'Full',
      price: T('5,99€', '€5.99'), period: T(' / μήνα', ' / month'),
      bullets: [
        T('✨ 25 ζωντανέματα τον μήνα', '✨ 25 animations per month'),
        T('Premium γυναικεία φωνή', 'Premium female voice'),
        T('Άλμπουμ ζωγραφιών', 'Drawings album'),
        T('Νέα ιστορία στην ίδια ζωγραφιά', 'New story on the same drawing'),
      ]
    })}
    ${planCard({
      id: 'full_yearly', name: T('Ετήσιο', 'Yearly'),
      price: T('49,99€', '€49.99'), period: T(' / χρόνο', ' / year'),
      bullets: [
        T('300 ζωντανέματα τον χρόνο', '300 animations per year'),
        T('Πληρώνεις μία φορά τον χρόνο', 'Pay once a year'),
        T('Εξοικονόμηση ~22€ / χρόνο', 'Save ~€22 per year'),
      ]
    })}

    ${state.checkoutError ? `<small style="display:block;color:#c11;text-align:center;margin-top:6px">${esc(state.checkoutError)}</small>` : ''}
    <small style="display:block;text-align:center;color:var(--muted);margin-top:6px">${T('Ασφαλής πληρωμή μέσω Stripe. Ακύρωση οποτεδήποτε.', 'Secure payments via Stripe. Cancel anytime.')}</small>
    ${bottomNav('paywall')}
  </section>`;
}

function contactView() {
  return `
  <section class="screen">
    <div class="topbar"><button class="icon-btn" data-go="home">←</button><h2>💬 ${T('Επικοινωνία', 'Contact')}</h2><span style="width:44px"></span></div>
    <div class="card">
      <b>💜 ev labs ai</b>
      <small>${T(
        'Φτιάχνουμε ασφαλείς AI εφαρμογές με αγάπη για τα παιδιά και τις οικογένειες. Είμαστε εδώ για κάθε ερώτηση, ιδέα ή υποστήριξη.',
        'We build safe AI apps with love for children and families. We are here for any question, idea or support.'
      )}</small>
    </div>
    <a class="card" href="mailto:info@evlabsai.gr?subject=Ζωγραφιά%20με%20Ζωή%20AI" style="text-decoration:none;color:inherit">
      <b>✉️ ${T('Στείλε μας email', 'Email us')}</b>
      <small>info@evlabsai.gr</small>
    </a>
    <a class="card" href="https://evlabsai.gr" target="_blank" rel="noopener noreferrer" style="text-decoration:none;color:inherit">
      <b>🌐 ${T('Το site μας', 'Our website')}</b>
      <small>${T('evlabsai.gr — δες κι άλλες AI εφαρμογές μας', 'evlabsai.gr — explore our other AI apps')}</small>
    </a>
    <div class="card">
      <b>📍 ${T('Έδρα', 'Based in')}</b>
      <small>${T('Χαλάνδρι, Αθήνα · Ελλάδα', 'Chalandri, Athens · Greece')}</small>
    </div>
    <div class="card">
      <b>🛡️ ${T('Απόρρητο', 'Privacy')}</b>
      <small>${T(
        'Οι φωτογραφίες ζωγραφιών μένουν τοπικά στη συσκευή σου. Στέλνουμε στην AI μόνο τη ζωγραφιά (όχι όνομα/φωτό παιδιού) για να σου φτιάξει ιστορία.',
        'Drawing photos stay locally on your device. We send only the drawing to the AI (no name or photo of the child) to generate the story.'
      )}</small>
    </div>
    <button class="btn ghost wide" data-go="terms">📜 ${T('Όροι & Απόρρητο', 'Terms & Privacy')}</button>

    <details class="card" style="margin-top:14px">
      <summary style="cursor:pointer;font-weight:800;list-style:none">🔑 ${T('Επαγγελματική χρήση / παρουσιάσεις', 'Professional use / presentations')}</summary>
      <small style="display:block;margin-top:8px">${T(
        'Αν είσαι ο/η κάτοχος του app και χρειάζεσαι απεριόριστες χρήσεις για παρουσιάσεις / events, βάλε το επαγγελματικό email σου:',
        "If you are the owner of the app and need unlimited usage for presentations / events, enter your professional email:"
      )}</small>
      <div class="form-row" style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
        <input id="ownerEmail" type="email" placeholder="email@example.com" autocomplete="email" style="flex:1;min-width:180px;border:1.5px solid #e8d8ff;border-radius:14px;padding:12px 14px;font-size:15px;font-family:inherit" />
        <button class="btn primary" data-action="owner-unlock">${T('Ξεκλείδωμα', 'Unlock')}</button>
      </div>
      ${state.usage && state.usage.plan === 'owner' ? `<small style="display:block;margin-top:8px;color:#0a7;font-weight:800">${T('✓ Επαγγελματική χρήση ενεργή — απεριόριστα.', '✓ Professional access active — unlimited.')}</small>` : ''}
    </details>

    ${bottomNav('contact')}
  </section>`;
}

function termsView() {
  return `
  <section class="screen">
    <div class="topbar"><button class="icon-btn" data-go="contact">←</button><h2>📜 Όροι & Απόρρητο</h2><span style="width:44px"></span></div>

    <div class="card">
      <b>👨‍👩‍👧 Για γονείς & κηδεμόνες</b>
      <small>Η «Ζωγραφιά με Ζωή AI» είναι εφαρμογή για παιδιά με την επίβλεψη γονέα/κηδεμόνα. Συνιστώμενη ηλικία 4+.</small>
    </div>
    <div class="card">
      <b>🔒 Τι μένει τοπικά</b>
      <small>Όνομα παιδιού (αν βάλεις) και οι ζωγραφιές του άλμπουμ αποθηκεύονται <b>μόνο τοπικά</b> στη συσκευή σου (browser). Δεν μας στέλνονται, δεν τα μοιραζόμαστε.</small>
    </div>
    <div class="card">
      <b>🤖 Τι ταξιδεύει στο internet</b>
      <small>Όταν πατάς «Ζωντάνεψε», στέλνουμε <b>μόνο τη φωτογραφία της ζωγραφιάς</b> στους AI παρόχους:
        <br>• <b>OpenAI</b> — βλέπει τη ζωγραφιά και φτιάχνει ιστορία + φωνή
        <br>• <b>Stripe</b> — μόνο για πληρωμές
        <br>Δεν στέλνουμε ποτέ όνομα ή φωτό παιδιού πέρα από τη ζωγραφιά.
      </small>
    </div>
    <div class="card">
      <b>💳 Συνδρομές</b>
      <small>Ασφαλείς πληρωμές μέσω <b>Stripe</b> — δεν βλέπουμε τα στοιχεία της κάρτας. Η συνδρομή ανανεώνεται αυτόματα· ακύρωσε όποτε θες από το email Stripe ή με mail σε εμάς.</small>
    </div>
    <div class="card">
      <b>🧹 Διαγραφή δεδομένων</b>
      <small>Δύο τρόποι:
        <br>• Στις <b>Ρυθμίσεις browser</b> → καθάρισμα δεδομένων ιστότοπου.
        <br>• Email στο <b>info@evlabsai.gr</b> για διαγραφή στοιχείων συνδρομής.
      </small>
    </div>
    <div class="card">
      <b>🛡️ Ασφάλεια περιεχομένου</b>
      <small>Η AI παράγει μόνο <b>χαρούμενο, παιδικό, ασφαλές</b> περιεχόμενο. Καμία ανοιχτή συνομιλία. Καμία τρομαχτική αναφορά.</small>
    </div>
    <div class="card">
      <b>📜 GDPR — Τα δικαιώματά σου</b>
      <small>Πρόσβαση, διόρθωση, διαγραφή και φορητότητα: <b>info@evlabsai.gr</b>.</small>
    </div>
    <div class="card">
      <b>⚖️ Δίκαιο</b>
      <small>Ελληνικό Δίκαιο. Πάροχος: <b>ev labs ai</b>, Χαλάνδρι, Αθήνα.</small>
    </div>
    ${bottomNav('contact')}
  </section>`;
}

/* ---------- Coloring Studio ---------- */
// Inline SVG line templates — kept simple, kid-safe, all in stroke="#222" so they
// render crisply on a white background. viewBox 0 0 600 600 across the board.
const COLORING_TEMPLATES = [
  { name: { el: 'Ήλιος',     en: 'Sun'       }, emoji: '☀️', svg: `<svg viewBox="0 0 600 600" xmlns="http://www.w3.org/2000/svg"><g fill="none" stroke="#222" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"><circle cx="300" cy="300" r="110"/><g><line x1="300" y1="80" x2="300" y2="140"/><line x1="300" y1="460" x2="300" y2="520"/><line x1="80" y1="300" x2="140" y2="300"/><line x1="460" y1="300" x2="520" y2="300"/><line x1="145" y1="145" x2="190" y2="190"/><line x1="410" y1="410" x2="455" y2="455"/><line x1="455" y1="145" x2="410" y2="190"/><line x1="190" y1="410" x2="145" y2="455"/></g><circle cx="270" cy="290" r="6" fill="#222"/><circle cx="330" cy="290" r="6" fill="#222"/><path d="M 260 330 Q 300 360 340 330"/></g></svg>` },
  { name: { el: 'Καρδιά',    en: 'Heart'     }, emoji: '❤️', svg: `<svg viewBox="0 0 600 600" xmlns="http://www.w3.org/2000/svg"><path d="M300 480 C 80 320 80 150 220 150 C 270 150 300 190 300 230 C 300 190 330 150 380 150 C 520 150 520 320 300 480 Z" fill="none" stroke="#222" stroke-width="7" stroke-linejoin="round"/></svg>` },
  { name: { el: 'Λουλούδι',  en: 'Flower'    }, emoji: '🌸', svg: `<svg viewBox="0 0 600 600" xmlns="http://www.w3.org/2000/svg"><g fill="none" stroke="#222" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"><circle cx="300" cy="240" r="40"/><ellipse cx="300" cy="130" rx="60" ry="80"/><ellipse cx="410" cy="240" rx="80" ry="60"/><ellipse cx="300" cy="350" rx="60" ry="80"/><ellipse cx="190" cy="240" rx="80" ry="60"/><line x1="300" y1="430" x2="300" y2="560"/><path d="M 300 470 Q 360 460 370 510"/></g></svg>` },
  { name: { el: 'Σπίτι',     en: 'House'     }, emoji: '🏠', svg: `<svg viewBox="0 0 600 600" xmlns="http://www.w3.org/2000/svg"><g fill="none" stroke="#222" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"><polyline points="100,320 100,520 500,520 500,320"/><polyline points="60,320 300,140 540,320"/><rect x="240" y="380" width="90" height="140"/><rect x="380" y="360" width="70" height="70"/><line x1="380" y1="395" x2="450" y2="395"/><line x1="415" y1="360" x2="415" y2="430"/></g></svg>` },
  { name: { el: 'Ψάρι',      en: 'Fish'      }, emoji: '🐠', svg: `<svg viewBox="0 0 600 600" xmlns="http://www.w3.org/2000/svg"><g fill="none" stroke="#222" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"><path d="M 80 300 Q 200 160 380 300 Q 200 440 80 300 Z"/><polyline points="380,300 500,200 480,300 500,400 380,300"/><circle cx="160" cy="280" r="8" fill="#222"/><path d="M 220 260 Q 260 240 300 260"/><path d="M 220 300 Q 260 290 300 300"/><path d="M 220 340 Q 260 350 300 340"/></g></svg>` },
  { name: { el: 'Πεταλούδα', en: 'Butterfly' }, emoji: '🦋', svg: `<svg viewBox="0 0 600 600" xmlns="http://www.w3.org/2000/svg"><g fill="none" stroke="#222" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="300" cy="300" rx="14" ry="120"/><circle cx="300" cy="190" r="14"/><line x1="294" y1="180" x2="280" y2="150"/><line x1="306" y1="180" x2="320" y2="150"/><path d="M 286 240 Q 140 140 130 280 Q 140 360 286 320"/><path d="M 314 240 Q 460 140 470 280 Q 460 360 314 320"/><path d="M 286 320 Q 160 360 200 440 Q 240 460 286 380"/><path d="M 314 320 Q 440 360 400 440 Q 360 460 314 380"/></g></svg>` },
];
const COLORING_COLORS = [
  '#ff3b5c','#ff6cc7','#ffa84d','#ffd166','#9be7a3','#7cc4ff','#b48bff','#7b3fff',
  '#3a8d4d','#246a8d','#7a4824','#222222'
];
const COLORING_BRUSHES = [
  { size:  8, label: { el: 'Λεπτό',  en: 'Thin'   } },
  { size: 18, label: { el: 'Μεσαίο', en: 'Medium' } },
  { size: 32, label: { el: 'Χοντρό', en: 'Thick'  } },
];

const coloringState = {
  templateIdx: 0,
  color: COLORING_COLORS[1],
  brush: 18,
  // history of completed strokes for undo, each is a flat ImageData snapshot
  history: [],
};

function coloringView() {
  const tmpl = COLORING_TEMPLATES[coloringState.templateIdx] || COLORING_TEMPLATES[0];
  const palette = COLORING_COLORS.map(c => `
    <button class="palette-color${c === coloringState.color ? ' selected' : ''}"
            data-color="${esc(c)}" aria-label="${T('Χρώμα', 'Color')} ${esc(c)}"
            style="background:${esc(c)}"></button>
  `).join('');
  const brushes = COLORING_BRUSHES.map(b => {
    const lbl = b.label[LANG] || b.label.el;
    return `
    <button class="brush-pick${b.size === coloringState.brush ? ' selected' : ''}"
            data-brush="${b.size}" aria-label="${esc(lbl)}">
      <span class="brush-dot" style="width:${Math.min(b.size,28)}px;height:${Math.min(b.size,28)}px"></span>
      <small>${esc(lbl)}</small>
    </button>`;
  }).join('');
  const templates = COLORING_TEMPLATES.map((t, i) => {
    const nm = t.name[LANG] || t.name.el;
    return `
    <button class="tmpl-pick${i === coloringState.templateIdx ? ' selected' : ''}"
            data-template="${i}" aria-label="${esc(nm)}">
      <span class="tmpl-emoji">${esc(t.emoji)}</span>
      <small>${esc(nm)}</small>
    </button>`;
  }).join('');
  return `
  <section class="screen">
    <div class="topbar">
      <button class="icon-btn" data-go="upload">←</button>
      <h2>🎨 ${T('Ζωγράφισε εδώ', 'Draw here')}</h2>
      <span style="width:44px"></span>
    </div>

    <div class="card" style="padding:10px">
      <div class="tmpl-row">${templates}</div>
    </div>

    <div class="card coloring-stage">
      <div class="coloring-canvas-wrap">
        <canvas id="coloringCanvas" width="900" height="900"></canvas>
        <div id="coloringSvg" class="coloring-svg">${tmpl.svg}</div>
      </div>
    </div>

    <div class="card" style="padding:10px">
      <div class="palette-row">${palette}</div>
    </div>

    <div class="card" style="padding:10px">
      <div class="brush-row">${brushes}</div>
    </div>

    <div class="audio-row">
      <button class="btn ghost" data-action="coloring-undo">↶ ${T('Ακύρωση', 'Undo')}</button>
      <button class="btn ghost" data-action="coloring-clear">🧽 ${T('Σβήσε όλα', 'Clear all')}</button>
    </div>
    <button class="btn primary big wide" data-action="coloring-done">${T('✅ Έτοιμη! Πάμε για ζωντάνεμα', '✅ Done! Bring it to life')}</button>

    ${bottomNav('home')}
  </section>`;
}

let _coloringPainting = false;
let _coloringLast = null;
let _coloringPreStroke = null;

function _coloringPointFromEvent(canvas, ev) {
  const rect = canvas.getBoundingClientRect();
  const x = (ev.clientX - rect.left) * (canvas.width  / rect.width);
  const y = (ev.clientY - rect.top ) * (canvas.height / rect.height);
  return { x, y };
}

function initColoringCanvas() {
  const canvas = $('#coloringCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const onDown = (ev) => {
    ev.preventDefault();
    _coloringPainting = true;
    // snapshot for undo before this stroke
    try { _coloringPreStroke = ctx.getImageData(0,0,canvas.width,canvas.height); } catch (e) {}
    const p = _coloringPointFromEvent(canvas, ev.touches ? ev.touches[0] : ev);
    _coloringLast = p;
    ctx.strokeStyle = coloringState.color;
    ctx.lineWidth   = coloringState.brush * 2;  // canvas is 900px wide → upscale brush
    ctx.beginPath();
    ctx.arc(p.x, p.y, ctx.lineWidth/2, 0, Math.PI * 2);
    ctx.fillStyle = coloringState.color;
    ctx.fill();
  };
  const onMove = (ev) => {
    if (!_coloringPainting) return;
    ev.preventDefault();
    const p = _coloringPointFromEvent(canvas, ev.touches ? ev.touches[0] : ev);
    ctx.beginPath();
    ctx.moveTo(_coloringLast.x, _coloringLast.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    _coloringLast = p;
  };
  const onUp = () => {
    if (_coloringPainting && _coloringPreStroke) {
      coloringState.history.push(_coloringPreStroke);
      if (coloringState.history.length > 20) coloringState.history.shift();
      _coloringPreStroke = null;
    }
    _coloringPainting = false;
    _coloringLast = null;
  };

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointerleave', onUp);
  canvas.addEventListener('pointercancel', onUp);
}

function coloringClear() {
  const canvas = $('#coloringCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  try { coloringState.history.push(ctx.getImageData(0,0,canvas.width,canvas.height)); } catch (e) {}
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function coloringUndo() {
  const canvas = $('#coloringCanvas');
  if (!canvas) return;
  const snap = coloringState.history.pop();
  if (!snap) return;
  const ctx = canvas.getContext('2d');
  ctx.putImageData(snap, 0, 0);
}

async function coloringDone() {
  const canvas = $('#coloringCanvas');
  const svgWrap = $('#coloringSvg');
  if (!canvas || !svgWrap) return;
  // Composite paint + black lines onto an offscreen canvas, then hand it to the
  // main animate flow as if the user had uploaded a photo.
  const out = document.createElement('canvas');
  out.width = 900; out.height = 900;
  const octx = out.getContext('2d');
  octx.fillStyle = '#ffffff';
  octx.fillRect(0, 0, out.width, out.height);
  // 1) the paint
  octx.drawImage(canvas, 0, 0);
  // 2) the SVG lines, on top (we serialize → Blob URL → Image → drawImage)
  const svgEl = svgWrap.querySelector('svg');
  if (!svgEl) { _coloringFallback(out); return; }
  const xml = new XMLSerializer().serializeToString(svgEl);
  const svg64 = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
  const img = new Image();
  img.onload = () => {
    octx.drawImage(img, 0, 0, out.width, out.height);
    const dataURL = out.toDataURL('image/jpeg', 0.92);
    state.draft = state.draft || {};
    state.draft.image = dataURL;
    state.customMotion = state.customMotion || '';
    state.screen = 'upload';
    render();
    toast('Έτοιμη! Πάτα ✨ Ζωντάνεψε για το βίντεο.');
  };
  img.onerror = () => _coloringFallback(out);
  img.src = svg64;
}

function _coloringFallback(out) {
  const dataURL = out.toDataURL('image/jpeg', 0.92);
  state.draft = state.draft || {};
  state.draft.image = dataURL;
  state.screen = 'upload';
  render();
}

/* ---------- Photo Decoration (paint over selfie / any photo) ---------- */
// Reuses the COLORING_COLORS/BRUSHES palette + coloringState (color/brush/history)
// so the parent / child has the same tools they know from the Coloring Studio,
// only the background is their photo instead of an SVG template.

let _decoratePhotoLoaded = false;

function decorateView() {
  if (!state.draft || !state.draft.image) {
    state.screen = 'upload';
    return uploadView();
  }
  const palette = COLORING_COLORS.map(c => `
    <button class="palette-color${c === coloringState.color ? ' selected' : ''}"
            data-color="${esc(c)}" aria-label="${T('Χρώμα', 'Color')} ${esc(c)}"
            style="background:${esc(c)}"></button>
  `).join('');
  const brushes = COLORING_BRUSHES.map(b => {
    const lbl = b.label[LANG] || b.label.el;
    return `
    <button class="brush-pick${b.size === coloringState.brush ? ' selected' : ''}"
            data-brush="${b.size}" aria-label="${esc(lbl)}">
      <span class="brush-dot" style="width:${Math.min(b.size,28)}px;height:${Math.min(b.size,28)}px"></span>
      <small>${esc(lbl)}</small>
    </button>`;
  }).join('');
  return `
  <section class="screen">
    <div class="topbar">
      <button class="icon-btn" data-go="upload">←</button>
      <h2>🎨 ${T('Διακόσμηση', 'Decorate')}</h2>
      <span style="width:44px"></span>
    </div>

    <div class="card highlight" style="margin-bottom:10px">
      <small>${T(
        'Διάλεξε χρώμα + πινέλο και ζωγράφισε πάνω στη φωτό σου. (Π.χ. βάφε το πρόσωπο σε σέλφι, βάλε καπέλο στον σκύλο, καρδούλες παντού…)',
        'Pick a color + brush and paint on top of your photo. (E.g. paint a face on a selfie, draw a hat on the dog, hearts everywhere…)'
      )}</small>
    </div>

    <div class="card coloring-stage">
      <div class="decorate-canvas-wrap">
        <canvas id="decorateCanvas"></canvas>
      </div>
    </div>

    <div class="card" style="padding:10px">
      <div class="palette-row">${palette}</div>
    </div>

    <div class="card" style="padding:10px">
      <div class="brush-row">${brushes}</div>
    </div>

    <div class="audio-row">
      <button class="btn ghost" data-action="decorate-undo">↶ ${T('Ακύρωση', 'Undo')}</button>
      <button class="btn ghost" data-action="decorate-clear">🧹 ${T('Καθαρά πίσω στη φωτό', 'Reset to photo')}</button>
    </div>
    <button class="btn primary big wide" data-action="decorate-done">${T('✅ Έτοιμη! Πίσω στη ζωγραφιά', '✅ Done! Back to drawing')}</button>
    <button class="btn ghost wide" style="margin-top:8px" data-action="decorate-skip">${T('⏭️ Παράλειψη (χωρίς ζωγραφική)', '⏭️ Skip (no painting)')}</button>

    ${bottomNav('home')}
  </section>`;
}

function initDecorateCanvas() {
  const canvas = $('#decorateCanvas');
  if (!canvas || !state.draft || !state.draft.image) return;
  const ctx = canvas.getContext('2d');
  _decoratePhotoLoaded = false;
  coloringState.history = [];

  const img = new Image();
  img.onload = () => {
    // Fit the photo into a max 900px canvas keeping aspect ratio. The canvas
    // gets the photo's natural shape (so a landscape selfie stays landscape).
    const max = 900;
    const w = img.naturalWidth || 900, h = img.naturalHeight || 900;
    const scale = Math.min(1, max / Math.max(w, h));
    canvas.width  = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    // Snapshot the pristine photo as undo-floor — Reset returns here, not white.
    try { coloringState.history.push(ctx.getImageData(0, 0, canvas.width, canvas.height)); } catch (e) {}
    _decoratePhotoLoaded = true;
  };
  img.onerror = () => {
    // Fallback: blank white canvas with same defaults
    canvas.width = 900; canvas.height = 900;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 900, 900);
    _decoratePhotoLoaded = true;
  };
  img.src = state.draft.image;

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Reuse the painting handlers from the coloring studio — same shape, same UX.
  const onDown = (ev) => {
    if (!_decoratePhotoLoaded) return;
    ev.preventDefault();
    _coloringPainting = true;
    try { _coloringPreStroke = ctx.getImageData(0, 0, canvas.width, canvas.height); } catch (e) {}
    const p = _coloringPointFromEvent(canvas, ev.touches ? ev.touches[0] : ev);
    _coloringLast = p;
    ctx.strokeStyle = coloringState.color;
    ctx.lineWidth   = coloringState.brush * 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fillStyle = coloringState.color;
    ctx.fill();
  };
  const onMove = (ev) => {
    if (!_coloringPainting) return;
    ev.preventDefault();
    const p = _coloringPointFromEvent(canvas, ev.touches ? ev.touches[0] : ev);
    ctx.beginPath();
    ctx.moveTo(_coloringLast.x, _coloringLast.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    _coloringLast = p;
  };
  const onUp = () => {
    if (_coloringPainting && _coloringPreStroke) {
      coloringState.history.push(_coloringPreStroke);
      if (coloringState.history.length > 25) coloringState.history.shift();
      _coloringPreStroke = null;
    }
    _coloringPainting = false;
    _coloringLast = null;
  };

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointerleave', onUp);
  canvas.addEventListener('pointercancel', onUp);
}

function decorateClear() {
  const canvas = $('#decorateCanvas');
  if (!canvas) return;
  // "Reset to photo" means: undo every stroke back to the original snapshot.
  // The pristine photo is the first entry in history; keep it, drop the rest.
  if (coloringState.history.length > 0) {
    const pristine = coloringState.history[0];
    coloringState.history = [pristine];
    canvas.getContext('2d').putImageData(pristine, 0, 0);
  }
}

function decorateUndo() {
  const canvas = $('#decorateCanvas');
  if (!canvas) return;
  // Pop the most recent pre-stroke snapshot. Never pop the very first entry
  // (the pristine photo) — that's the floor.
  if (coloringState.history.length > 1) {
    const snap = coloringState.history.pop();
    canvas.getContext('2d').putImageData(snap, 0, 0);
  }
}

function decorateDone() {
  const canvas = $('#decorateCanvas');
  if (!canvas) return;
  // Hand the painted-over photo back to the upload screen.
  try {
    state.draft.image = canvas.toDataURL('image/jpeg', 0.9);
  } catch (e) {}
  state.screen = 'upload';
  render();
  toast(T('Διακοσμημένη! Πάτα ✨ Ζωντάνεψε.', 'Decorated! Tap ✨ Bring to life.'));
}

function decorateSkip() {
  state.screen = 'upload';
  render();
}

const views = {
  home: homeView,
  upload: uploadView,
  loading: loadingView,
  result: resultView,
  coloring: coloringView,
  decorate: decorateView,
  gallery: galleryView,
  paywall: paywallView,
  contact: contactView,
  terms: termsView,
};

function render() {
  const v = views[state.screen] || homeView;
  app.innerHTML = v();
  // restore focus convenience: child name input
  const cn = $('#childName');
  if (cn) cn.addEventListener('input', (e) => {
    state.childName = e.target.value;
    try { localStorage.setItem('zografia_child_name', state.childName); } catch (err) {}
  });
  // custom motion textarea (cleared after each animate)
  const cm = $('#customMotion');
  if (cm) cm.addEventListener('input', (e) => { state.customMotion = e.target.value; });
  // coloring screen post-render init
  if (state.screen === 'coloring') {
    initColoringCanvas();
  }
  // decorate screen post-render init
  if (state.screen === 'decorate') {
    initDecorateCanvas();
  }
}

/* ---------- Animate flow ---------- */
async function runAnimate({ regenerate = false } = {}) {
  if (!state.draft || !state.draft.image) {
    state.screen = 'upload'; render();
    toast(T('Πρώτα βάλε μια ζωγραφιά.', 'First add a drawing.'));
    return;
  }
  state.loading = true;
  state.loadingMsg = regenerate
    ? T('Φτιάχνω νέα ιστορία…', 'Writing a new story…')
    : T('Βλέπω τη ζωγραφιά σου…', 'Looking at your drawing…');
  state.screen = 'loading';
  state.result = null;
  render();
  // rotate loading messages
  const msgs = LANG === 'en' ? [
    'Looking at your drawing…',
    'Counting the colors…',
    'Whispering to the drawing…',
    'Preparing the voice…',
    'Sprinkling sparkles ✨…',
  ] : [
    'Βλέπω τη ζωγραφιά σου…',
    'Μετράω τα χρώματα…',
    'Ψιθυρίζω στη ζωγραφιά…',
    'Ετοιμάζω τη φωνή…',
    'Σκορπάω αστράκια ✨…',
  ];
  let mi = 0;
  const interval = setInterval(() => {
    mi = (mi + 1) % msgs.length;
    state.loadingMsg = msgs[mi];
    if (state.screen === 'loading') render();
  }, 2200);
  try {
    const data = await callAnimate({
      image: state.draft.image,
      child_name: state.childName || null,
      custom_motion: state.customMotion || null,
    });
    clearInterval(interval);
    data._image = state.draft.image;
    state.result = data;
    if (data.usage) state.usage = data.usage;
    state.screen = 'result';
    state.loading = false;
    // Reset video state and kick off AKOOL poll if backend started one
    stopVideoPoll();
    state.video = { task_id: '', status: 'none', url: '', polling: false };
    if (data.video_task_id) {
      startVideoPoll(data.video_task_id);
    }
    render();
    // auto-play story
    setTimeout(() => { playTTS(data.speakable || data.story || ''); }, 350);
  } catch (e) {
    clearInterval(interval);
    state.loading = false;
    if (e.code === 402) {
      state.screen = 'paywall';
      await fetchUsage();
      render();
      toast(T('Τελείωσαν τα δωρεάν ζωντανέματα.', 'Your free animations ran out.'));
      return;
    }
    state.screen = 'upload';
    render();
    toast(e.message || T('Κάτι πήγε στραβά. Δοκίμασε ξανά.', 'Something went wrong. Try again.'));
  }
}

/* ---------- File picker ---------- */
function pickFile(useCamera) {
  const input = useCamera ? $('#cameraInput') : $('#fileInput');
  if (!input) return;
  input.value = '';
  input.onchange = async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try {
      const url = await resizeImageFile(f, 1024, 0.85);
      state.draft = state.draft || {};
      state.draft.image = url;
      if (state.screen !== 'upload') state.screen = 'upload';
      render();
    } catch (err) {
      toast('Δεν διαβάστηκε η εικόνα.');
    }
  };
  input.click();
}

/* ---------- Live Camera (getUserMedia) ---------- */
let _cameraStream = null;
let _cameraFacing = 'environment'; // 'environment' (back) | 'user' (front)

function showCameraError(msg) {
  const box = $('#cameraError');
  if (!box) return;
  box.textContent = msg;
  box.hidden = false;
}
function hideCameraError() {
  const box = $('#cameraError');
  if (box) box.hidden = true;
}

function showCameraTip(show) {
  const tip = $('#cameraTip');
  if (tip) tip.style.display = show ? 'block' : 'none';
}

async function openCamera() {
  const overlay = $('#cameraOverlay');
  if (!overlay) return pickFile(true);  // fallback
  hideCameraError();
  showCameraTip(true);
  // Explicit display flip (inline style:display:none cannot be cleared by [hidden])
  overlay.style.display = 'flex';
  overlay.hidden = false;
  // Lock background scroll while overlay is open
  document.body.style.overflow = 'hidden';

  // Permission / API check
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showCameraError('Ο browser δεν υποστηρίζει live κάμερα. Κλείσε με «Άκυρο» και χρησιμοποίησε «Από αρχείο».');
    return;
  }
  if (!window.isSecureContext) {
    showCameraError('Η κάμερα θέλει HTTPS. Άνοιξε ξανά από zografia-ai.onrender.com.');
    return;
  }

  try {
    if (_cameraStream) stopCamera();
    // Try ideal facingMode first; if that fails on a device without back cam,
    // catch below and fall back to default.
    _cameraStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: _cameraFacing },
        width:  { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    });
    const video = $('#cameraVideo');
    if (video) {
      video.srcObject = _cameraStream;
      try { await video.play(); } catch (e) {}
      showCameraTip(false);
    }
  } catch (err) {
    const name = (err && err.name) || '';
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      // Permission denied → auto-fallback to file picker so the user is never stuck.
      closeCamera();
      toast('Χωρίς άδεια κάμερας — άνοιξα τα αρχεία σου.');
      setTimeout(() => pickFile(false), 250);
      return;
    } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      // Retry without facingMode constraint
      try {
        _cameraStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        const video = $('#cameraVideo');
        if (video) {
          video.srcObject = _cameraStream;
          try { await video.play(); } catch (e) {}
          showCameraTip(false);
        }
        return;
      } catch (err2) {
        closeCamera();
        toast('Δεν βρέθηκε κάμερα — άνοιξα τα αρχεία σου.');
        setTimeout(() => pickFile(false), 250);
        return;
      }
    } else {
      showCameraError('Πρόβλημα κάμερας (' + (name || 'error') + '). Πάτα «📁 Από αρχείο» πιο κάτω ή «✕ Πίσω».');
    }
  }
}

function stopCamera() {
  if (_cameraStream) {
    try { _cameraStream.getTracks().forEach(t => t.stop()); } catch (e) {}
    _cameraStream = null;
  }
  const video = $('#cameraVideo');
  if (video) {
    try { video.pause(); } catch (e) {}
    video.srcObject = null;
  }
}

function closeCamera() {
  stopCamera();
  const overlay = $('#cameraOverlay');
  if (overlay) {
    overlay.style.display = 'none';
    overlay.hidden = true;
  }
  hideCameraError();
  showCameraTip(true);
  // Restore background scroll
  document.body.style.overflow = '';
}

async function switchCamera() {
  _cameraFacing = (_cameraFacing === 'environment') ? 'user' : 'environment';
  await openCamera();
}

function captureFromCamera() {
  const video = $('#cameraVideo');
  if (!_cameraStream || !video || !video.videoWidth) {
    showCameraError('Πρώτα πάτα Allow / περίμενε να ανοίξει η κάμερα.');
    return;
  }
  const canvas = $('#captureCanvas') || document.createElement('canvas');
  const w = video.videoWidth, h = video.videoHeight;
  // downscale to ~1024px max so the backend payload stays small
  const max = 1024;
  const scale = Math.min(1, max / Math.max(w, h));
  canvas.width  = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const dataURL = canvas.toDataURL('image/jpeg', 0.85);
  state.draft = state.draft || {};
  state.draft.image = dataURL;
  closeCamera();
  state.screen = 'upload';
  render();
}

// Defensive: even if a stale cached HTML left the overlay visible, force it
// hidden on every app boot. Only openCamera() (explicit user action) can open
// it after this. Belt-and-braces fix for users still served pre-v8 cache.
(function ensureCameraOverlayHidden() {
  function hide() {
    const o = document.getElementById('cameraOverlay');
    if (o) { o.style.display = 'none'; o.hidden = true; }
    if (document.body) document.body.style.overflow = '';
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hide);
  else hide();
})();

// Wire the persistent EN/EL language toggle (lives in index.html, top-right).
(function wireLangBtn() {
  function init() {
    const btn = $('#langBtn');
    if (!btn) return;
    // The label shows the OTHER language (the one a tap will switch TO).
    btn.textContent = (LANG === 'el' ? 'EN' : 'EL');
    document.documentElement.lang = LANG;
    btn.addEventListener('click', () => setLang(LANG === 'el' ? 'en' : 'el'));
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

// Wire camera buttons once (they live in index.html, outside the SPA render).
(function wireCameraButtons() {
  function wire() {
    const closeBtn   = $('#cameraCloseBtn');
    const captureBtn = $('#cameraCaptureBtn');
    const switchBtn  = $('#cameraSwitchBtn');
    const toFileBtn  = $('#cameraToFileBtn');
    if (closeBtn)   closeBtn.addEventListener('click', closeCamera);
    if (captureBtn) captureBtn.addEventListener('click', captureFromCamera);
    if (switchBtn)  switchBtn.addEventListener('click', switchCamera);
    if (toFileBtn)  toFileBtn.addEventListener('click', () => {
      closeCamera();
      setTimeout(() => pickFile(false), 200);
    });
    // Escape key closes the camera too
    document.addEventListener('keydown', (e) => {
      const overlay = $('#cameraOverlay');
      if (overlay && !overlay.hidden && e.key === 'Escape') closeCamera();
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();

/* ---------- Save / open / share ---------- */
function saveToGallery() {
  if (!state.result) return;
  const id = 'g-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  // make a small thumbnail to keep storage small
  try {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const TH = 320;
      const scale = Math.min(1, TH / Math.max(img.width, img.height));
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const thumb = canvas.toDataURL('image/jpeg', 0.7);
      const entry = {
        id,
        timestamp: Date.now(),
        title: state.result.title || 'Η ζωγραφιά μου',
        story: state.result.story || '',
        lines: state.result.lines || [],
        follow_up: state.result.follow_up || '',
        what_i_see: state.result.what_i_see || '',
        image: state.result._image || '',
        video_url: state.video?.url || state.result._video_url || '',
        audio_url: state.result.audio_url || '',
        thumb,
      };
      state.gallery = [entry, ...state.gallery].slice(0, 24);
      saveGallery();
      toast('Αποθηκεύτηκε στο άλμπουμ! 💜');
      render();
    };
    img.src = state.result._image;
  } catch (e) {
    toast('Δεν αποθηκεύτηκε.');
  }
}

function openFromGallery(id) {
  const g = state.gallery.find(x => x.id === id);
  if (!g) return;
  state.result = {
    title: g.title, story: g.story, lines: g.lines,
    follow_up: g.follow_up, what_i_see: g.what_i_see,
    _image: g.image || g.thumb,
    _video_url: g.video_url || '',
    audio_url: g.audio_url || '',
    speakable: (g.story ? g.story + '\n\n' : '') +
               (g.lines || []).map(l => (l.speaker ? l.speaker + ': ' : '') + l.text).join('\n\n') +
               (g.follow_up ? '\n\n' + g.follow_up : ''),
  };
  stopVideoPoll();
  state.video = { task_id: '', status: g.video_url ? 'success' : 'none', url: g.video_url || '', polling: false };
  state.draft = { image: g.image || g.thumb };
  state.screen = 'result';
  render();
}

async function downloadVideo(url) {
  if (!url) return;
  toast(T('Κατεβάζω το βίντεο…', 'Downloading the video…'), 3000);
  let blob;
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('http ' + resp.status);
    const rawBlob = await resp.blob();
    // Force video/mp4 so Windows Movies&TV (and the OS file picker on iOS)
    // associate the saved file with the right player.
    blob = new Blob([rawBlob], { type: 'video/mp4' });
  } catch (e) {
    toast(T('Πρόβλημα σύνδεσης. Δοκίμασε ξανά.', 'Network error. Try again.'));
    return;
  }
  const file = new File([blob], 'zografia-zoi.mp4', { type: 'video/mp4' });

  // Mobile: native share/save sheet (Save to Photos / Files / AirDrop / etc).
  if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: T('Η ζωγραφιά μου ζωντάνεψε', 'My drawing came alive') });
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      // fall through to download path
    }
  }

  // Desktop: use our backend proxy URL with Content-Disposition: attachment.
  // The browser will save the file as zografia-zoi.mp4 with a guaranteed
  // video/mp4 MIME — sidesteps the Windows Media Player "can't open" quirk
  // that bit users when we did the blob+<a download> dance.
  const proxyUrl = URL_DL_PROXY + '?url=' + encodeURIComponent(url);
  const a = document.createElement('a');
  a.href = proxyUrl;
  a.download = 'zografia-zoi.mp4';
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  toast(T(
    '✓ Κατεβαίνει το zografia-zoi.mp4 στον φάκελο Λήψεις. Αν δεν παίζει, πάτα «Παίξε» — παίζει πάντα στο browser.',
    '✓ Downloading zografia-zoi.mp4 to your Downloads folder. If it doesn’t play, tap «Play» — that always works in the browser.'
  ), 6500);
}

function openVideoInBrowser(url) {
  if (!url) return;
  // Opens the video in a new tab where the browser's native HTML5 player plays it.
  // Works on EVERY OS / device, regardless of installed local players.
  window.open(url, '_blank', 'noopener,noreferrer');
}

async function shareResult() {
  if (!state.result) return;
  const r = state.result;
  const videoUrl = (state.video && state.video.url) || r._video_url || '';
  const title = r.title || T('Η ζωγραφιά μου ζωντάνεψε!', 'My drawing came alive!');
  const text = (r.story || '') + (r.follow_up ? '\n\n' + r.follow_up : '') +
               '\n\n— Ζωγραφιά με Ζωή AI · evlabsai.gr';

  // 1) Mobile / Web Share API with file (iOS/Android opens native share sheet
  //    that already includes WhatsApp / Viber / Messenger / Photos etc).
  if (videoUrl && navigator.share && navigator.canShare) {
    toast(T('Ετοιμάζω το βίντεο…', 'Preparing the video…'));
    try {
      const resp = await fetch(videoUrl);
      if (resp.ok) {
        const rawBlob = await resp.blob();
        const blob = new Blob([rawBlob], { type: 'video/mp4' });
        const file = new File([blob], 'zografia-zoi.mp4', { type: 'video/mp4' });
        if (navigator.canShare({ files: [file] })) {
          try {
            await navigator.share({ title, text, files: [file] });
            return;
          } catch (e) {
            if (e && e.name === 'AbortError') return;
          }
        }
      }
    } catch (e) {
      console.warn('file share failed', e);
    }
  }

  // 2) Desktop (and mobile fallback): open our own share menu with explicit
  //    WhatsApp / Viber / Telegram / Email buttons. Works on any OS.
  openShareMenu({ videoUrl, title, text });
}

function openShareMenu({ videoUrl, title, text }) {
  // Build a one-shot modal — we replace the body's tail rather than rendering
  // via the SPA so it sits cleanly above whatever screen is open.
  let host = document.getElementById('shareModal');
  if (host) host.remove();
  host = document.createElement('div');
  host.id = 'shareModal';
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:rgba(15,10,30,.78);display:flex;align-items:flex-end;justify-content:center;padding:0';

  const msg = `${title}\n\n${text}${videoUrl ? '\n\n🎬 ' + T('Βίντεο', 'Video') + ': ' + videoUrl : ''}`;
  const msgEnc = encodeURIComponent(msg);
  const urlEnc = encodeURIComponent(videoUrl || '');
  const subjectEnc = encodeURIComponent(title);

  // Compose option list. WhatsApp/Viber/Messenger/Telegram links work both
  // in their desktop apps (via custom URL schemes) and via web.
  const opts = [
    { label: T('💚 WhatsApp', '💚 WhatsApp'),
      href:  `https://wa.me/?text=${msgEnc}`, target: '_blank' },
    { label: T('💜 Viber', '💜 Viber'),
      href:  `viber://forward?text=${msgEnc}`, target: '_self' },
    { label: T('🔵 Messenger', '🔵 Messenger'),
      href:  `https://www.facebook.com/sharer/sharer.php?u=${urlEnc}`, target: '_blank' },
    { label: T('✈️ Telegram', '✈️ Telegram'),
      href:  `https://t.me/share/url?url=${urlEnc}&text=${encodeURIComponent(title)}`, target: '_blank' },
    { label: T('✉️ Email', '✉️ Email'),
      href:  `mailto:?subject=${subjectEnc}&body=${msgEnc}`, target: '_self' },
  ];

  host.innerHTML = `
    <div role="dialog" aria-modal="true"
         style="background:#fff;width:100%;max-width:480px;border-radius:24px 24px 0 0;padding:18px 16px 24px;
                box-shadow:0 -20px 60px rgba(0,0,0,.4);max-height:85vh;overflow-y:auto;
                font-family:inherit;animation:shareSlideUp .22s ease-out">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
        <b style="flex:1;font-size:17px;color:#222">${esc(T('📤 Στείλε το βίντεο', '📤 Share the video'))}</b>
        <button type="button" id="shareCloseBtn" aria-label="Close"
                style="background:#f0e7ff;color:#7b3fff;border:0;border-radius:50%;width:36px;height:36px;font-size:18px;font-weight:900;cursor:pointer">×</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        ${opts.map(o => `
          <a href="${esc(o.href)}" target="${esc(o.target)}" rel="noopener noreferrer"
             style="display:flex;align-items:center;justify-content:center;gap:6px;
                    padding:14px 10px;border-radius:14px;background:#f6f0ff;color:#222;
                    text-decoration:none;font-weight:800;font-size:15px;border:1px solid #e8d8ff">
            ${esc(o.label)}
          </a>`).join('')}
        <button type="button" id="shareCopyBtn"
                style="padding:14px 10px;border-radius:14px;background:#fff7e0;border:1px solid #ffe0c8;color:#7b3fff;font-weight:800;font-size:15px;cursor:pointer;font-family:inherit">
          📋 ${esc(T('Αντιγραφή link', 'Copy link'))}
        </button>
        <button type="button" id="shareDlBtn"
                style="padding:14px 10px;border-radius:14px;background:linear-gradient(135deg,#ff6cc7,#ffa84d);border:0;color:#fff;font-weight:900;font-size:15px;cursor:pointer;font-family:inherit">
          💾 ${esc(T('Κατέβασε mp4', 'Download mp4'))}
        </button>
      </div>
      <small style="display:block;text-align:center;color:#888;margin-top:14px;font-size:12px">
        ${esc(T(
          'Σε WhatsApp Web / Viber Desktop: αφού στείλεις το κείμενο, σύρε & άσε το mp4 (αν το κατέβασες) για να σταλεί ως βίντεο.',
          'On WhatsApp Web / Viber Desktop: after sending the text, drag-and-drop the mp4 (if you downloaded it) to send it as a video.'
        ))}
      </small>
    </div>`;
  // Slide-up keyframe (injected once)
  if (!document.getElementById('shareModalKeyframes')) {
    const style = document.createElement('style');
    style.id = 'shareModalKeyframes';
    style.textContent = '@keyframes shareSlideUp { from{transform:translateY(100%);opacity:.2} to{transform:translateY(0);opacity:1} }';
    document.head.appendChild(style);
  }
  document.body.appendChild(host);
  document.body.style.overflow = 'hidden';

  const close = () => { host.remove(); document.body.style.overflow = ''; };
  host.addEventListener('click', (e) => { if (e.target === host) close(); });
  $('#shareCloseBtn').addEventListener('click', close);
  $('#shareCopyBtn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(videoUrl ? `${title}\n${videoUrl}` : `${title}\n${text}`);
      toast(T('Αντιγράφηκε στο πρόχειρο 💜', 'Copied to clipboard 💜'));
    } catch (e) {
      toast(T('Δεν αντιγράφηκε.', 'Could not copy.'));
    }
  });
  $('#shareDlBtn').addEventListener('click', () => {
    close();
    if (videoUrl) downloadVideo(videoUrl);
  });
}

function clearGalleryWithConfirm() {
  if (!state.gallery.length) return;
  if (!confirm('Σίγουρα; Θα διαγραφεί όλο το άλμπουμ.')) return;
  state.gallery = [];
  saveGallery();
  render();
}

/* ---------- Click router ---------- */
document.addEventListener('click', (e) => {
  const goEl = e.target.closest('[data-go]');
  if (goEl) {
    const dest = goEl.dataset.go;
    if (dest === 'upload') {
      // reset prior result audio
      stopAudio();
    }
    state.screen = dest;
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  const openEl = e.target.closest('[data-open]');
  if (openEl) { openFromGallery(openEl.dataset.open); return; }
  const planEl = e.target.closest('[data-plan]');
  if (planEl) { startCheckout(planEl.dataset.plan); return; }
  // coloring: pick color / brush / template (no full re-render, direct DOM swap)
  const colorEl = e.target.closest('[data-color]');
  if (colorEl) {
    coloringState.color = colorEl.dataset.color;
    document.querySelectorAll('.palette-color.selected').forEach(el => el.classList.remove('selected'));
    colorEl.classList.add('selected');
    return;
  }
  const brushEl = e.target.closest('[data-brush]');
  if (brushEl) {
    coloringState.brush = parseInt(brushEl.dataset.brush, 10) || 18;
    document.querySelectorAll('.brush-pick.selected').forEach(el => el.classList.remove('selected'));
    brushEl.classList.add('selected');
    return;
  }
  const tmplEl = e.target.closest('[data-template]');
  if (tmplEl) {
    const idx = parseInt(tmplEl.dataset.template, 10) || 0;
    if (idx !== coloringState.templateIdx) {
      coloringState.templateIdx = idx;
      coloringState.history = [];
      render();
    }
    return;
  }
  const actEl = e.target.closest('[data-action]');
  if (!actEl) return;
  const a = actEl.dataset.action;
  switch (a) {
    case 'open-camera': openCamera(); break;
    case 'pick-camera': pickFile(true); break;  // legacy fallback
    case 'pick-file':   pickFile(false); break;
    case 'owner-unlock': ownerUnlock(); break;
    case 'animate':     runAnimate(); break;
    case 'reanimate':   runAnimate({ regenerate: true }); break;
    case 'audio-play':  playTTS(state.result && (state.result.speakable || state.result.story)); break;
    case 'audio-stop':  stopAudio(); break;
    case 'save-gallery': saveToGallery(); break;
    case 'share':       shareResult(); break;
    case 'gallery-clear': clearGalleryWithConfirm(); break;
    case 'coloring-undo':  coloringUndo(); break;
    case 'coloring-clear': coloringClear(); break;
    case 'coloring-done':  coloringDone(); break;
    case 'decorate-undo':  decorateUndo(); break;
    case 'decorate-clear': decorateClear(); break;
    case 'decorate-done':  decorateDone(); break;
    case 'decorate-skip':  decorateSkip(); break;
    case 'download-video': {
      const url = (state.video && state.video.url) || (state.result && state.result._video_url) || '';
      if (url) downloadVideo(url);
      break;
    }
    case 'play-browser': {
      const url = (state.video && state.video.url) || (state.result && state.result._video_url) || '';
      if (url) openVideoInBrowser(url);
      break;
    }
    case 'draft-delete': {
      // Clear the staged image so the parent / child can pick a new one
      // (camera / file / coloring) without having to first run animate.
      state.draft = null;
      state.customMotion = '';
      render();
      toast(T('Έτοιμη για νέα ζωγραφιά.', 'Ready for a new drawing.'));
      break;
    }
  }
});

/* ---------- Stripe return ---------- */
(function handleCheckoutReturn() {
  try {
    const sp = new URLSearchParams(window.location.search);
    if (sp.get('checkout') === 'success') {
      history.replaceState({}, '', window.location.pathname);
      setTimeout(fetchUsage, 1200);
      setTimeout(fetchUsage, 4000);
      setTimeout(() => alert('✅ Η συνδρομή ενεργοποιήθηκε! Καλώς ήρθες. 💜'), 50);
      state.screen = 'home';
    } else if (sp.get('checkout') === 'cancel') {
      history.replaceState({}, '', window.location.pathname);
      state.screen = 'paywall';
    }
  } catch (e) {}
})();

/* ---------- Boot ---------- */
render();
fetchUsage().then(render).catch(() => {});
