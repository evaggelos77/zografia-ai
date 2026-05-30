/* Ζωγραφιά με Ζωή AI — frontend brain.
   Single-file vanilla JS. Talks to zografia-backend.onrender.com.
*/

const BACKEND = (window.ZOGRAFIA_BACKEND || 'https://zografia-backend.onrender.com').replace(/\/+$/, '');
const URL_ANIMATE  = BACKEND + '/api/animate-drawing';
const URL_TTS      = BACKEND + '/api/tts';
const URL_USAGE    = BACKEND + '/api/usage';
const URL_CHECKOUT = BACKEND + '/api/checkout';

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
const state = {
  screen: 'home',
  childName: localStorage.getItem('zografia_child_name') || '',
  draft: null,                 // { image: dataURL, child, title, mood }
  loading: false,
  loadingMsg: '',
  result: null,                // animation response
  audio: null,                 // current Audio instance
  audioPlaying: false,
  usage: null,                 // { plan, used, quota, remaining, is_active, is_full, ... }
  checkoutLoading: '',
  checkoutError: '',
  gallery: loadGallery(),
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
  const res = await fetch(URL_ANIMATE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-Id': DEVICE_ID },
    body: JSON.stringify(payload),
    signal: ctrl.signal,
  });
  clearTimeout(timer);
  if (res.status === 402) { const err = new Error('quota_exceeded'); err.code = 402; throw err; }
  if (!res.ok) {
    let m = 'Δεν τα κατάφερα τώρα. Δοκίμασε ξανά.';
    try { const j = await res.json(); if (j && j.detail) m = String(j.detail); } catch (e) {}
    throw new Error(m);
  }
  return await res.json();
}

let _currentAudio = null;
async function playTTS(text) {
  if (!text) return;
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
  if (u.plan === 'full' && u.is_active) return '✓ Full · Απεριόριστα';
  if (u.plan === 'basic' && u.is_active) {
    const rem = (u.remaining == null) ? '∞' : u.remaining;
    return `Basic · ${rem} ζωντανέματα ακόμα`;
  }
  const rem = (u.remaining == null) ? '?' : u.remaining;
  return `Δωρεάν · ${rem}/${u.quota ?? '?'} ζωντανέματα`;
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
    ['home',     '🏠', 'Αρχική'],
    ['gallery',  '🖼️', 'Άλμπουμ'],
    ['paywall',  '💎', 'Πακέτα'],
    ['contact',  '💬', 'Βοήθεια'],
  ];
  return `<div class="bottom-nav">${items.map(([id, ico, lbl]) =>
    `<button class="${active === id ? 'active' : ''}" data-go="${id}"><span class="ico">${ico}</span>${esc(lbl)}</button>`
  ).join('')}</div>`;
}

/* ---------- Views ---------- */
function homeView() {
  const last = state.gallery.slice(0, 4);
  return `
  <section class="screen">
    <div class="hero">
      <img class="logo" src="assets/logo.png" alt="Ζωγραφιά με Ζωή AI" />
      <h1>Ζωγραφιά με Ζωή AI</h1>
      <p class="tagline">Η ζωγραφιά σου ζωντανεύει — μιλάει και σου λέει μια μικρή ιστορία ✨</p>
      <div class="pill">${esc(planLabel(state.usage) || 'Δωρεάν δοκιμή')}</div>
    </div>

    <button class="btn primary big wide" data-go="upload">✨ Ζωντάνεψε τη ζωγραφιά μου!</button>

    <div class="card">
      <b>🎨 Πώς δουλεύει</b>
      <small>1) Ζωγραφίζεις σε χαρτί. 2) Πατάς «Ζωντάνεψε» και τραβάς φωτό. 3) Η AI φτιάχνει ιστορία και τη λέει με χαρούμενη φωνή!</small>
    </div>

    ${last.length ? `
      <div class="card">
        <b style="display:flex;align-items:center;gap:8px">🖼️ Πρόσφατες <button class="btn ghost" data-go="gallery" style="margin-left:auto;padding:6px 10px;font-size:13px">Όλες</button></b>
        <div class="gallery-grid" style="margin-top:10px">
          ${last.map(g => `
            <button class="gallery-card" data-open="${esc(g.id)}">
              <img src="${esc(g.thumb || g.image)}" alt="${esc(g.title || 'Ζωγραφιά')}">
              <b>${esc(g.title || 'Η ζωγραφιά μου')}</b>
              <small>${new Date(g.timestamp).toLocaleDateString('el-GR')}</small>
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
      <h2>Νέα ζωγραφιά</h2>
      ${planBadge() || '<span style="width:44px"></span>'}
    </div>

    <div class="card">
      <div class="draw-area">
        ${hasDraft
          ? `<img src="${esc(state.draft.image)}" alt="Η ζωγραφιά σου">`
          : `<div class="draw-empty">
               <div class="big-emoji">🖍️</div>
               <b>Τράβα φωτό τη ζωγραφιά</b>
               <small>Φωτογράφισε το χαρτί σου ή ανέβασε εικόνα από το τηλέφωνο.</small>
             </div>`
        }
      </div>
      <div class="row" style="margin-top:12px">
        <button class="btn gold" data-action="pick-camera">📷 Τράβα φωτό</button>
        <button class="btn ghost" data-action="pick-file">📁 Από αρχείο</button>
      </div>
    </div>

    <div class="card">
      <b>👤 Όνομα παιδιού <small style="font-weight:400">(προαιρετικό)</small></b>
      <div class="form-row" style="margin-top:8px">
        <input id="childName" type="text" placeholder="π.χ. Νικόλας" value="${esc(state.childName)}" maxlength="40" />
      </div>
    </div>

    <button class="btn primary big wide" data-action="animate" ${hasDraft ? '' : 'disabled'}>
      ${hasDraft ? '✨ Ζωντάνεψε τη ζωγραφιά!' : 'Πρώτα βάλε μια ζωγραφιά'}
    </button>

    ${bottomNav('home')}
  </section>`;
}

function loadingView() {
  return `
  <section class="screen">
    <div class="loading">
      <div class="spinner" aria-hidden="true"></div>
      <h2>${esc(state.loadingMsg || 'Ζωντανεύω τη ζωγραφιά σου…')}</h2>
      <small>Μια στιγμή — ${esc(state.childName?.trim() || 'φίλε μου')}, η AI κοιτάει προσεκτικά κάθε λεπτομέρεια ✨</small>
    </div>
    ${bottomNav('home')}
  </section>`;
}

function resultView() {
  const r = state.result;
  if (!r) { state.screen = 'home'; return homeView(); }
  const linesHTML = (r.lines || []).map(l => `
    <div class="bubble"><b>${esc(l.speaker || 'η ζωγραφιά')}</b><p>${esc(l.text || '')}</p></div>
  `).join('');
  return `
  <section class="screen">
    <div class="topbar">
      <button class="icon-btn" data-go="home">←</button>
      <h2>${esc(r.title || 'Η ζωγραφιά σου ζωντάνεψε!')}</h2>
      <button class="icon-btn" data-action="reanimate" title="Νέα ιστορία">🔁</button>
    </div>

    <div class="result-card">
      <div class="result-image">
        <img src="${esc(r._image || (state.draft && state.draft.image) || '')}" alt="Η ζωγραφιά σου">
        <span class="sparkle s1">✨</span>
        <span class="sparkle s2">⭐</span>
        <span class="sparkle s3">💫</span>
        <span class="sparkle s4">✨</span>
      </div>

      ${r.what_i_see ? `<div class="card highlight" style="margin-bottom:12px"><b>👀 Τι βλέπω</b><small>${esc(r.what_i_see)}</small></div>` : ''}

      <p class="story">${esc(r.story || '')}</p>

      ${linesHTML ? `<div class="lines">${linesHTML}</div>` : ''}

      ${r.follow_up ? `<div class="follow-up">💜 ${esc(r.follow_up)}</div>` : ''}

      <div class="audio-row">
        <button class="btn primary" data-action="${state.audioPlaying ? 'audio-stop' : 'audio-play'}">
          ${state.audioPlaying ? '⏸️ Παύση' : '🔊 Άκου ξανά'}
        </button>
        <button class="btn gold" data-action="save-gallery">💾 Αποθήκευση</button>
      </div>
      <div class="audio-row">
        <button class="btn ghost" data-go="upload">🖼️ Νέα ζωγραφιά</button>
        <button class="btn ghost" data-action="share">📤 Διαμοίρασε</button>
      </div>
    </div>

    ${bottomNav('home')}
  </section>`;
}

function galleryView() {
  if (!state.gallery.length) {
    return `
    <section class="screen">
      <div class="topbar"><button class="icon-btn" data-go="home">←</button><h2>Το άλμπουμ μου</h2><span style="width:44px"></span></div>
      <div class="card" style="text-align:center;padding:30px">
        <div style="font-size:64px">🖼️</div>
        <b style="margin-top:10px">Άδειο ακόμα</b>
        <small>Φτιάξε την πρώτη σου ζωντανή ζωγραφιά!</small>
        <button class="btn primary wide" style="margin-top:14px" data-go="upload">✨ Ξεκίνα</button>
      </div>
      ${bottomNav('gallery')}
    </section>`;
  }
  return `
  <section class="screen">
    <div class="topbar"><button class="icon-btn" data-go="home">←</button><h2>Το άλμπουμ μου</h2><button class="icon-btn" data-action="gallery-clear" title="Καθαρισμός">🗑️</button></div>
    <div class="gallery-grid">
      ${state.gallery.map(g => `
        <button class="gallery-card" data-open="${esc(g.id)}">
          <img src="${esc(g.thumb || g.image)}" alt="${esc(g.title || 'Ζωγραφιά')}">
          <b>${esc(g.title || 'Η ζωγραφιά μου')}</b>
          <small>${new Date(g.timestamp).toLocaleDateString('el-GR')}</small>
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
      ${loading ? 'Μια στιγμή…' : 'Επιλογή'}
    </button>
  </div>`;
}

function paywallView() {
  const u = state.usage || {};
  const out = u.plan === 'trial' && (u.remaining ?? 1) <= 0;
  return `
  <section class="screen">
    <div class="topbar"><button class="icon-btn" data-go="home">←</button><h2>💎 Πακέτα</h2><span style="width:44px"></span></div>
    <div class="card">
      <b>${out ? '💜 Η δωρεάν δοκιμή τελείωσε' : '✨ Πάμε για περισσότερα ζωντανέματα!'}</b>
      <small>${out
        ? 'Διάλεξε ένα πακέτο για να συνεχίσεις χωρίς όρια.'
        : 'Με τη συνδρομή ξεκλειδώνεις περισσότερα ή απεριόριστα ζωντανέματα.'}</small>
      ${state.usage ? `<div style="margin-top:10px">${planBadge()}</div>` : ''}
    </div>

    ${planCard({
      id: 'basic_monthly', name: 'Basic', price: '2,99€', period: ' / μήνα',
      bullets: [
        '15 ζωντανέματα τον μήνα',
        'Premium γυναικεία φωνή',
        'Άλμπουμ ζωγραφιών',
        'Ακύρωση όποτε θες'
      ]
    })}
    ${planCard({
      id: 'full_monthly', featured: true, badge: 'Πιο αγαπημένο',
      name: 'Full', price: '5,99€', period: ' / μήνα',
      bullets: [
        '✨ Απεριόριστα ζωντανέματα',
        'Premium γυναικεία φωνή',
        'Άλμπουμ ζωγραφιών',
        'Νέα ιστορία στην ίδια ζωγραφιά'
      ]
    })}
    ${planCard({
      id: 'full_yearly', name: 'Full Ετήσιο', price: '49,99€', period: ' / χρόνο',
      bullets: [
        'Όλα του Full',
        'Πληρώνεις μία φορά τον χρόνο',
        'Εξοικονόμηση ~22€ / χρόνο'
      ]
    })}

    ${state.checkoutError ? `<small style="display:block;color:#c11;text-align:center;margin-top:6px">${esc(state.checkoutError)}</small>` : ''}
    <small style="display:block;text-align:center;color:var(--muted);margin-top:6px">Ασφαλής πληρωμή μέσω Stripe. Ακύρωση οποτεδήποτε.</small>
    ${bottomNav('paywall')}
  </section>`;
}

function contactView() {
  return `
  <section class="screen">
    <div class="topbar"><button class="icon-btn" data-go="home">←</button><h2>💬 Επικοινωνία</h2><span style="width:44px"></span></div>
    <div class="card">
      <b>💜 ev labs ai</b>
      <small>Φτιάχνουμε ασφαλείς AI εφαρμογές με αγάπη για τα παιδιά και τις οικογένειες. Είμαστε εδώ για κάθε ερώτηση, ιδέα ή υποστήριξη.</small>
    </div>
    <a class="card" href="mailto:info@evlabsai.gr?subject=Ζωγραφιά%20με%20Ζωή%20AI" style="text-decoration:none;color:inherit">
      <b>✉️ Στείλε μας email</b>
      <small>info@evlabsai.gr</small>
    </a>
    <a class="card" href="https://evlabsai.gr" target="_blank" rel="noopener noreferrer" style="text-decoration:none;color:inherit">
      <b>🌐 Το site μας</b>
      <small>evlabsai.gr — δες κι άλλες AI εφαρμογές μας</small>
    </a>
    <div class="card">
      <b>📍 Έδρα</b>
      <small>Χαλάνδρι, Αθήνα · Ελλάδα</small>
    </div>
    <div class="card">
      <b>🛡️ Απόρρητο</b>
      <small>Οι φωτογραφίες ζωγραφιών μένουν τοπικά στη συσκευή σου. Στέλνουμε στην AI μόνο τη ζωγραφιά (όχι όνομα/φωτό παιδιού) για να σου φτιάξει ιστορία.</small>
    </div>
    <button class="btn ghost wide" data-go="terms">📜 Όροι & Απόρρητο</button>
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

const views = {
  home: homeView,
  upload: uploadView,
  loading: loadingView,
  result: resultView,
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
}

/* ---------- Animate flow ---------- */
async function runAnimate({ regenerate = false } = {}) {
  if (!state.draft || !state.draft.image) {
    state.screen = 'upload'; render();
    toast('Πρώτα βάλε μια ζωγραφιά.');
    return;
  }
  state.loading = true;
  state.loadingMsg = regenerate ? 'Φτιάχνω νέα ιστορία…' : 'Βλέπω τη ζωγραφιά σου…';
  state.screen = 'loading';
  state.result = null;
  render();
  // rotate loading messages
  const msgs = [
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
    });
    clearInterval(interval);
    data._image = state.draft.image;
    state.result = data;
    if (data.usage) state.usage = data.usage;
    state.screen = 'result';
    state.loading = false;
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
      toast('Τελείωσαν τα δωρεάν ζωντανέματα.');
      return;
    }
    state.screen = 'upload';
    render();
    toast(e.message || 'Κάτι πήγε στραβά. Δοκίμασε ξανά.');
  }
}

/* ---------- File pickers ---------- */
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
    speakable: (g.story ? g.story + '\n\n' : '') +
               (g.lines || []).map(l => (l.speaker ? l.speaker + ': ' : '') + l.text).join('\n\n') +
               (g.follow_up ? '\n\n' + g.follow_up : ''),
  };
  state.draft = { image: g.image || g.thumb };
  state.screen = 'result';
  render();
}

async function shareResult() {
  if (!state.result) return;
  const text = state.result.title + '\n\n' + state.result.story + '\n\n' +
               (state.result.lines || []).map(l => (l.speaker ? l.speaker + ': ' : '') + l.text).join('\n');
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Η ζωγραφιά μου ζωντάνεψε!', text });
      return;
    }
  } catch (e) {}
  try {
    await navigator.clipboard.writeText(text);
    toast('Αντιγράφηκε στο πρόχειρο 💜');
  } catch (e) {
    toast('Δεν μπόρεσα να κάνω διαμοιρασμό.');
  }
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
  const actEl = e.target.closest('[data-action]');
  if (!actEl) return;
  const a = actEl.dataset.action;
  switch (a) {
    case 'pick-camera': pickFile(true); break;
    case 'pick-file':   pickFile(false); break;
    case 'animate':     runAnimate(); break;
    case 'reanimate':   runAnimate({ regenerate: true }); break;
    case 'audio-play':  playTTS(state.result && (state.result.speakable || state.result.story)); break;
    case 'audio-stop':  stopAudio(); break;
    case 'save-gallery': saveToGallery(); break;
    case 'share':       shareResult(); break;
    case 'gallery-clear': clearGalleryWithConfirm(); break;
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
