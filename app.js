// Familien Essensplan – einfache, lokale Web‑App mit optionaler Gemini‑Integration

// --- Utilities ---
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const fmtDate = (d) => new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit' }).format(d);
const fmtShort = (d) => new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit' }).format(d);
const iso = (d) => d.toISOString().slice(0, 10);
const uid = () => Math.random().toString(36).slice(2, 10);
const DEFAULT_AI_KEY = '';

// Optional: preset lock configuration and hint image
// If presetPattern is provided, the app stores its hash on first load
// and requires unlock; no user setup prompt.
// The hintImage (e.g., 'muster.jpg') is shown underneath the grid as guidance.
const LOCK_CONFIG = {
  // Sperre aktivieren: Beim Start wird immer das Muster verlangt
  enabled: true,
  // Example pattern indices (0..8) in a 3x3 grid left-to-right, top-to-bottom
  // Mapping:
  // 0 1 2
  // 3 4 5
  // 6 7 8
  // User-specified pattern: 6-3-0-4-7-5
  presetPattern: [6, 3, 0, 4, 7, 5],
  // Enforce preset even if a different lock exists
  enforcePreset: true,
  // Visual hint image shown under the grid
  hintImage: 'muster.jpg',
  hintOpacity: 0.18,
  // Never show hint while unlocking (nur beim Setup zeigen)
  showHintInUnlock: false,
  // Do not use insecure hashing fallback
  allowInsecureHash: true,
};

// Compute Monday of the week for a given date
function weekStart(date) {
  const d = new Date(date);
  const day = (d.getDay() + 6) % 7; // 0 = Monday
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

// Persistence helpers (IndexedDB via window.kv, with localStorage mirror)
const persist = {
  set(key, value) {
    try { if (window.kv && kv.set) kv.set(key, value).catch(() => {}); } catch {}
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  },
  del(key) {
    try { if (window.kv && kv.del) kv.del(key).catch(() => {}); } catch {}
    try { localStorage.removeItem(key); } catch {}
  },
  async get(key, fallback) {
    try { if (window.kv && kv.get) { const v = await kv.get(key); return v ?? fallback; } } catch {}
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  getLS(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  }
};

// --- Data Model ---
const DB = {
  profiles: null,
  foods: null,
  prefs: {}, // { [profileId]: { [foodId]: 'like'|'dislike'|'neutral' } }
  plans: {}, // { [weekKey]: Plan }
  aiKey: '',
  customPrompt: '',
};

function ensureDefaults() {
  if (!DB.profiles || !Array.isArray(DB.profiles) || DB.profiles.length === 0) {
    const names = ['Paul','Hannes','Jonas','Mark','Helen','Emil'];
    DB.profiles = names.map(n => ({ id: uid(), name: n, color: `hsl(${Math.floor(Math.random()*360)} 60% 50%)`, isCook: n === 'Helen' }));
  }
  if (!DB.foods || !Array.isArray(DB.foods)) {
    DB.foods = [
      { id: uid(), name: 'Spaghetti Bolognese', type: 'Hauptgericht', tags: ['italienisch'] },
      { id: uid(), name: 'Gemischter Salat', type: 'Salat', tags: ['leicht'] },
      { id: uid(), name: 'Knoblauchbrot', type: 'Beilage', tags: ['italienisch'] },
      { id: uid(), name: 'Obstsalat', type: 'Dessert', tags: ['frisch'] },
      { id: uid(), name: 'Linsensuppe', type: 'Hauptgericht', tags: ['vegetarisch'] },
      { id: uid(), name: 'Reis', type: 'Beilage', tags: ['asiatisch'] },
    ];
  }
  if (!DB.prefs || typeof DB.prefs !== 'object') DB.prefs = {};
  if (!DB.plans || typeof DB.plans !== 'object') DB.plans = {};
}

function aiKeyFromUrl() {
  // Entferne evtl. vorhandenen Key aus der URL, nutze ihn aber NICHT
  try {
    const u = new URL(location.href);
    if (u.searchParams.has('aiKey') || u.searchParams.has('key')) {
      u.searchParams.delete('aiKey');
      u.searchParams.delete('key');
      history.replaceState({}, '', u.toString());
    }
  } catch {}
  return '';
}

async function loadInitialData() {
  try { if (window.kv && kv.init) await kv.init(); } catch {}
  const keys = ['fe_profiles','fe_foods','fe_prefs','fe_plans','fe_customPrompt'];
  let fromKV = {};
  try { if (window.kv && kv.getMany) fromKV = await kv.getMany(keys); } catch { fromKV = {}; }

  DB.profiles = fromKV.fe_profiles ?? persist.getLS('fe_profiles', null);
  DB.foods   = fromKV.fe_foods   ?? persist.getLS('fe_foods', null);
  DB.prefs   = fromKV.fe_prefs   ?? persist.getLS('fe_prefs', {});
  DB.plans   = fromKV.fe_plans   ?? persist.getLS('fe_plans', {});
  DB.aiKey   = '';
  DB.customPrompt = fromKV.fe_customPrompt ?? persist.getLS('fe_customPrompt', '');

  // Key aus URL übernehmen, falls übergeben (?aiKey=... oder ?key=...)
  aiKeyFromUrl(); // entfernt nur aus der URL, ignoriert den Wert

  ensureDefaults();
  // Sync to DB to ensure presence
  persist.set('fe_profiles', DB.profiles);
  persist.set('fe_foods', DB.foods);
  persist.set('fe_prefs', DB.prefs);
  persist.set('fe_plans', DB.plans);
  // AI-Key nie persistieren
  try { persist.del('fe_aiKey'); } catch {}
  persist.set('fe_customPrompt', DB.customPrompt);
}

// Active state
let ACTIVE = {
  profileId: null,
  currentWeekStart: weekStart(new Date()),
};

// --- Pattern lock ---
async function ensurePatternLock() {
  if (LOCK_CONFIG && LOCK_CONFIG.enabled === false) return; // Sperre deaktiviert
  const hasSecureCrypto = !!(window.crypto && crypto.subtle && crypto.subtle.digest);
  if (!hasSecureCrypto && !LOCK_CONFIG.allowInsecureHash) {
    console.warn('Pattern-Lock deaktiviert: unsicherer Kontext (kein SubtleCrypto)');
    return;
  }
  const saved = await persist.get('fe_lock', null);
  const hasPreset = Array.isArray(LOCK_CONFIG.presetPattern) && LOCK_CONFIG.presetPattern.length >= 3;

  if (!saved) {
    if (hasPreset) {
      const seq = LOCK_CONFIG.presetPattern
        .map(n => parseInt(n, 10))
        .filter(n => Number.isInteger(n) && n >= 0 && n <= 8);
      if (seq.length >= 3) {
        const salt = (window.crypto?.getRandomValues ? (() => { const a = new Uint8Array(16); crypto.getRandomValues(a); return Array.from(a).map(b=>b.toString(16).padStart(2,'0')).join(''); })() : Math.random().toString(36).slice(2));
        const hash = await hashPattern(seq, salt);
        if (!hash) { console.warn('Lock-Hash fehlgeschlagen'); return; }
        const preset = { salt, hash };
        persist.set('fe_lock', preset);
        showLockOverlay('unlock', preset);
        return;
      }
    }
    // No preset pattern: ask user to set up once
    showLockOverlay('setup1');
    return;
  }

  // If a different lock exists but a preset is configured and enforcePreset is on, replace it
  if (hasPreset && LOCK_CONFIG.enforcePreset) {
    try {
      const seq = LOCK_CONFIG.presetPattern
        .map(n => parseInt(n, 10))
        .filter(n => Number.isInteger(n) && n >= 0 && n <= 8);
      if (seq.length >= 3) {
        // Try to check match using saved salt
        const should = await hashPattern(seq, saved?.salt || '');
        if (!saved || (should && should !== saved.hash)) {
          const salt = (window.crypto?.getRandomValues ? (() => { const a = new Uint8Array(16); crypto.getRandomValues(a); return Array.from(a).map(b=>b.toString(16).padStart(2,'0')).join(''); })() : Math.random().toString(36).slice(2));
          const hash = await hashPattern(seq, salt);
          if (!hash) { console.warn('Lock-Hash fehlgeschlagen'); return; }
          const preset = { salt, hash };
          persist.set('fe_lock', preset);
          showLockOverlay('unlock', preset);
          return;
        }
      }
    } catch {}
  }

  // Pattern exists: require unlocking with the saved hash.
  showLockOverlay('unlock', saved);
}

function buildLockUI(container, mode) {
  container.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'lock-card';
  card.innerHTML = '<h2>Entsperren</h2>';
  const wrap = document.createElement('div');
  wrap.className = 'pattern-wrap';
  // Optional visual hint image under the grid
  const showHint = LOCK_CONFIG.hintImage && (mode !== 'unlock' || LOCK_CONFIG.showHintInUnlock);
  if (showHint) {
    const hint = document.createElement('img');
    hint.src = LOCK_CONFIG.hintImage;
    hint.alt = '';
    hint.className = 'pattern-hint';
    hint.style.opacity = String(LOCK_CONFIG.hintOpacity ?? 0.18);
    wrap.appendChild(hint);
  }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'pattern-svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  const linesGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  svg.appendChild(linesGroup);
  const grid = document.createElement('div');
  grid.className = 'pattern-grid';
  for (let i = 0; i < 9; i++) {
    const d = document.createElement('div');
    d.className = 'dot';
    d.dataset.ix = String(i);
    grid.appendChild(d);
  }
  wrap.appendChild(svg);
  wrap.appendChild(grid);
  const msg = document.createElement('div');
  msg.id = 'lockMsg';
  msg.className = 'lock-msg';
  card.appendChild(wrap);
  card.appendChild(msg);
  container.appendChild(card);
  return { svg, linesGroup, grid, msg };
}

function dotCenters(grid) {
  const rect = grid.getBoundingClientRect();
  const dots = Array.from(grid.querySelectorAll('.dot'));
  return dots.map(d => {
    const r = d.getBoundingClientRect();
    return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
  });
}

function toSvgCoords(x, y, grid) {
  const r = grid.getBoundingClientRect();
  const relX = ((x - r.left) / r.width) * 100;
  const relY = ((y - r.top) / r.height) * 100;
  return { x: relX, y: relY };
}

function simpleHashStr(str) {
  let h1 = 0xdeadbeef ^ str.length;
  let h2 = 0x41c6ce57 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = (h1 ^ (h1 >>> 16)) >>> 0;
  h2 = (h2 ^ (h2 >>> 16)) >>> 0;
  return h1.toString(16).padStart(8,'0') + h2.toString(16).padStart(8,'0');
}

async function hashPattern(seq, salt) {
  const input = (salt || '') + '|' + seq.join('-');
  try {
    if (window.crypto && crypto.subtle && crypto.subtle.digest) {
      const data = new TextEncoder().encode(input);
      const buf = await crypto.subtle.digest('SHA-256', data);
      const arr = Array.from(new Uint8Array(buf));
      return arr.map(b => b.toString(16).padStart(2, '0')).join('');
    }
  } catch {}
  // In unsicheren Kontexten nur optionalen Fallback nutzen
  if (LOCK_CONFIG.allowInsecureHash) return simpleHashStr(input);
  return null;
}

function showLockOverlay(mode, saved) {
  const overlay = $('#lockScreen');
  overlay.hidden = false;
  overlay.removeAttribute('hidden');
  overlay.style.display = 'grid';
  overlay.setAttribute('aria-hidden', 'false');
  document.body.classList.add('is-locked');
  const { svg, linesGroup, grid, msg } = buildLockUI(overlay, mode);

  let seq = [];
  let isDown = false;
  let centers = [];
  let lastPt = null;
  let firstSeq = null;
  let pickRadius = 32; // dynamic per grid size

  function renderLines(currentPoint) {
    while (linesGroup.firstChild) linesGroup.removeChild(linesGroup.firstChild);
    if (seq.length === 0) return;
    // draw connecting segments
    for (let i = 0; i < seq.length - 1; i++) {
      const a = centers[seq[i]];
      const b = centers[seq[i+1]];
      const A = toSvgCoords(a.x, a.y, grid);
      const B = toSvgCoords(b.x, b.y, grid);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', A.x); line.setAttribute('y1', A.y);
      line.setAttribute('x2', B.x); line.setAttribute('y2', B.y);
      line.setAttribute('stroke', 'var(--primary)');
      line.setAttribute('stroke-width', '2');
      linesGroup.appendChild(line);
    }
    if (currentPoint && seq.length > 0) {
      const a = centers[seq[seq.length - 1]];
      const A = toSvgCoords(a.x, a.y, grid);
      const C = toSvgCoords(currentPoint.x, currentPoint.y, grid);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', A.x); line.setAttribute('y1', A.y);
      line.setAttribute('x2', C.x); line.setAttribute('y2', C.y);
      line.setAttribute('stroke', 'var(--primary)');
      line.setAttribute('stroke-width', '2');
      line.setAttribute('stroke-dasharray', '2 2');
      linesGroup.appendChild(line);
    }
  }

  function resetDots() {
    seq = [];
    grid.querySelectorAll('.dot').forEach(d => d.classList.remove('active'));
    renderLines();
  }

  function handlePointerDown(ev) {
    isDown = true;
    centers = dotCenters(grid);
    seq = [];
    const r = grid.getBoundingClientRect();
    pickRadius = Math.min(r.width, r.height) / 8; // scale with grid size
    grid.setPointerCapture?.(ev.pointerId);
    handlePointerMove(ev);
  }
  function handlePointerUp() {
    isDown = false;
    if (seq.length < 3) { msg.textContent = 'Bitte mindestens 3 Punkte verbinden.'; resetDots(); return; }
    // Decide by mode
    if (mode === 'unlock') {
      const salt = saved.salt || '';
      hashPattern(seq, salt).then(h => {
        if (h === saved.hash) {
          overlay.hidden = true; overlay.setAttribute('aria-hidden', 'true'); overlay.style.display = 'none';
          document.body.classList.remove('is-locked');
        } else {
          msg.textContent = 'Falsches Muster. Nochmal versuchen.';
          setTimeout(resetDots, 400);
        }
      });
    } else if (mode === 'setup1') {
      firstSeq = seq.slice();
      msg.textContent = 'Bitte Muster zur Bestätigung erneut zeichnen.';
      mode = 'setup2';
      setTimeout(resetDots, 200);
    } else if (mode === 'setup2') {
      const same = firstSeq.length === seq.length && firstSeq.every((v,i) => v===seq[i]);
      if (!same) { msg.textContent = 'Stimmt nicht überein. Nochmal neu beginnen.'; mode = 'setup1'; setTimeout(resetDots, 400); return; }
      const salt = (window.crypto?.getRandomValues ? (() => { const a = new Uint8Array(16); crypto.getRandomValues(a); return Array.from(a).map(b=>b.toString(16).padStart(2,'0')).join(''); })() : Math.random().toString(36).slice(2));
      hashPattern(seq, salt).then(h => {
        if (!h) { console.warn('Lock-Hash fehlgeschlagen'); return; }
        persist.set('fe_lock', { salt, hash: h });
        msg.textContent = 'Muster gespeichert. Entsperrt.';
        setTimeout(() => { overlay.hidden = true; overlay.setAttribute('aria-hidden','true'); overlay.style.display='none'; document.body.classList.remove('is-locked'); }, 400);
      });
    }
  }
  function handlePointerMove(ev) {
    if (!isDown) return;
    const x = ev.clientX ?? (ev.touches && ev.touches[0]?.clientX);
    const y = ev.clientY ?? (ev.touches && ev.touches[0]?.clientY);
    if (x == null || y == null) return;
    const dots = Array.from(grid.querySelectorAll('.dot'));
    // find closest dot under threshold
    let picked = -1;
    for (let i = 0; i < centers.length; i++) {
      const c = centers[i];
      const dx = x - c.x, dy = y - c.y;
      const dist = Math.hypot(dx, dy);
      if (dist < pickRadius) { picked = i; break; }
    }
    if (picked >= 0 && !seq.includes(picked)) {
      // Include skipped middle dot like Android pattern lock
      const last = seq.length ? seq[seq.length - 1] : null;
      const mid = (last != null) ? computeMiddleIndex(last, picked) : null;
      if (mid != null && !seq.includes(mid)) {
        seq.push(mid);
        dots[mid].classList.add('active');
      }
      seq.push(picked);
      dots[picked].classList.add('active');
    }
    renderLines({ x, y });
  }

  function computeMiddleIndex(a, b) {
    const ar = Math.floor(a / 3), ac = a % 3;
    const br = Math.floor(b / 3), bc = b % 3;
    const dr = br - ar, dc = bc - ac;
    // same row skip
    if (ar === br && Math.abs(dc) === 2) return ar * 3 + (ac + bc) / 2;
    // same col skip
    if (ac === bc && Math.abs(dr) === 2) return ((ar + br) / 2) * 3 + ac;
    // diagonal skip across center
    if (Math.abs(dr) === 2 && Math.abs(dc) === 2) return 4; // center
    // middle in cross (1-7 via 4) or (3-5 via 4)
    if (Math.abs(dr) === 0 && Math.abs(dc) === 0) return null;
    if ((a === 1 && b === 7) || (a === 7 && b === 1) || (a === 3 && b === 5) || (a === 5 && b === 3)) return 4;
    return null;
  }

  // Pointer events preferred; fall back to touch/mouse if unavailable
  if (window.PointerEvent) {
    grid.addEventListener('pointerdown', handlePointerDown);
    grid.addEventListener('pointermove', handlePointerMove);
    grid.addEventListener('pointerup', handlePointerUp);
    grid.addEventListener('pointercancel', () => { isDown = false; resetDots(); });
  } else {
    // Touch fallback
    grid.addEventListener('touchstart', (e) => { e.preventDefault(); handlePointerDown(e.touches[0]); }, { passive: false });
    grid.addEventListener('touchmove', (e) => { e.preventDefault(); handlePointerMove(e.touches[0]); }, { passive: false });
    grid.addEventListener('touchend', (e) => { e.preventDefault(); handlePointerUp(); }, { passive: false });
    // Mouse fallback
    grid.addEventListener('mousedown', handlePointerDown);
    grid.addEventListener('mousemove', handlePointerMove);
    grid.addEventListener('mouseup', handlePointerUp);
    grid.addEventListener('mouseleave', () => { isDown = false; });
  }

  msg.textContent = mode.startsWith('setup') ? 'Muster zeichnen zum Festlegen.' : 'Muster zeichnen zum Entsperren.';
}

// --- Rendering ---
function renderWeekLabel() {
  const start = new Date(ACTIVE.currentWeekStart);
  const end = addDays(start, 6);
  $('#weekLabel').textContent = `${fmtShort(start)} – ${fmtShort(end)}`;
  // Toggle state of "Aktuelle Woche" button
  const curBtn = $('#currentWeekBtn');
  if (curBtn) {
    const isCur = weekKey(new Date()) === weekKey(start);
    curBtn.disabled = isCur;
    curBtn.title = isCur ? 'Bereits aktuelle Woche' : 'Zur aktuellen Woche springen';
  }
}

function renderProfiles() {
  const list = $('#profilesList');
  list.innerHTML = '';
  for (const p of DB.profiles) {
    const li = document.createElement('li');
    li.className = 'profile-item';
    const isActive = p.id === ACTIVE.profileId;
    const btn = document.createElement('button');
    btn.className = 'profile-btn';
    btn.dataset.id = p.id;
    const avatar = document.createElement('div');
    avatar.className = 'avatar' + (isActive ? ' active' : '');
    avatar.dataset.id = p.id;
    avatar.classList.add('profile-avatar');
    if (p.img) {
      const img = document.createElement('img'); img.src = p.img; img.alt = p.name; avatar.appendChild(img);
    } else {
      avatar.textContent = p.name.slice(0,1);
      avatar.style.background = '#eef5ed';
    }
    if (p.isCook) {
      const b = document.createElement('div'); b.className = 'badge-cook'; b.textContent = '👩‍🍳'; avatar.appendChild(b);
    }
    const name = document.createElement('div'); name.className = 'profile-name'; name.textContent = p.name;
    const sub = document.createElement('div'); sub.className = 'profile-meta'; sub.textContent = p.isCook ? 'Köchin' : '';
    btn.appendChild(avatar);
    btn.appendChild(name);
    btn.appendChild(sub);
    li.appendChild(btn);
    list.appendChild(li);
  }

  // Show/Hide generate button based on active being cook
  const ap = DB.profiles.find(p => p.id === ACTIVE.profileId);
  $('#generateBtn').style.display = ap?.isCook ? 'inline-block' : 'none';
  // Erwachsenen-Modus für Köchin aktivieren (zeigt adult-only Bereiche)
  document.body.classList.toggle('adult-mode', !!(ap && ap.isCook));
}

function ensurePrefs(profileId) {
  if (!DB.prefs[profileId]) DB.prefs[profileId] = {};
}

function likeCount(foodId) {
  let likes = 0, dislikes = 0;
  for (const pid of Object.keys(DB.prefs)) {
    const v = DB.prefs[pid]?.[foodId];
    if (v === 'like') likes++;
    if (v === 'dislike') dislikes++;
  }
  return { likes, dislikes };
}

function renderFoods() {
  const ul = $('#foodsList');
  ul.innerHTML = '';
  const activePrefs = DB.prefs[ACTIVE.profileId] || {};
  for (const f of DB.foods) {
    const li = document.createElement('li');
    li.className = 'food-item';
    const { likes, dislikes } = likeCount(f.id);
    const my = activePrefs[f.id] || 'neutral';
    li.innerHTML = `
      <div class="food-line">
        <div><strong>${esc(f.name)}</strong></div>
        <div class="food-type">${esc(f.type)}</div>
        <div class="food-tags">${(Array.isArray(f.tags)?f.tags:[]).map(esc).join(', ')}</div>
      </div>
      <div class="food-actions">
        <button class="pill ${my==='like'?'good':''}" data-act="like" data-id="${esc(f.id)}">👍 ${likes}</button>
        <button class="pill ${my==='dislike'?'bad':''}" data-act="dislike" data-id="${esc(f.id)}">👎 ${dislikes}</button>
      </div>
      <div>
        <button class="btn small" data-act="removeFood" data-id="${esc(f.id)}">Entfernen</button>
      </div>
    `;
    ul.appendChild(li);
  }
}

function weekKey(d) { return iso(weekStart(d)); }

function getPlanForWeek(startDate) {
  return DB.plans[weekKey(startDate)] || null;
}

function setPlanForWeek(startDate, plan) {
  DB.plans[weekKey(startDate)] = plan;
  persist.set('fe_plans', DB.plans);
}

function renderPlan() {
  const grid = $('#weekGrid');
  grid.innerHTML = '';
  const plan = getPlanForWeek(ACTIVE.currentWeekStart);
  const days = Array.from({ length: 7 }, (_, i) => addDays(ACTIVE.currentWeekStart, i));
  if (!plan) {
    for (const d of days) {
      const div = document.createElement('div');
      div.className = 'day-card';
      div.innerHTML = `
        <div class="day-head">
          <div><strong>${fmtDate(d)}</strong></div>
          <div class="day-date">${iso(d)}</div>
        </div>
        <div class="empty">Noch kein Plan. (Köchin kann generieren)</div>
      `;
      grid.appendChild(div);
    }
    return;
  }

  plan.days.forEach((day, di) => {
    const div = document.createElement('div');
    div.className = 'day-card';
    div.innerHTML = `
      <div class="day-head">
        <div><strong>${fmtDate(new Date(day.date))}</strong></div>
        <div class="day-date">${day.theme ? esc(day.theme) : ''}</div>
      </div>
    `;
    for (let mi = 0; mi < day.meals.length; mi++) {
      const meal = day.meals[mi];
      const mealDiv = document.createElement('div');
      const kind = (meal.name || '').toLowerCase().includes('früh') ? 'breakfast'
        : (meal.name || '').toLowerCase().includes('mittag') ? 'lunch'
        : 'dinner';
      mealDiv.className = `meal meal-${kind}`;
      mealDiv.innerHTML = `
        <div class="block">
          <p class="meal-label" style="margin:0; font-size:12px; color:#4A5548; font-weight:600;">${esc(meal.name)}</p>
          <ul class="items">${(Array.isArray(meal.items)?meal.items:[]).map(it => `<li>${esc(it.name)}${it.type?` <span class=\"food-type\">${esc(it.type)}</span>`:''}</li>`).join('')}</ul>
        </div>
        <div class="comments" id="comments-${di}-${mi}"></div>
        <div class="add-comment">
          <input type="text" placeholder="Kommentar hinzufügen" data-di="${di}" data-mi="${mi}" />
          <button class="btn small" data-act="addComment" data-di="${di}" data-mi="${mi}">Senden</button>
        </div>
      `;
      div.appendChild(mealDiv);
    }
    grid.appendChild(div);
  });

  // Render comments
  for (let di = 0; di < plan.days.length; di++) {
    for (let mi = 0; mi < plan.days[di].meals.length; mi++) {
      const key = `${di}_${mi}`;
      const container = $(`#comments-${di}-${mi}`);
      container.innerHTML = '';
      (plan.comments?.[key] || []).forEach(c => {
        const p = DB.profiles.find(p => p.id === c.profileId);
        const el = document.createElement('div');
        el.className = 'comment';
        el.textContent = `${p?.name ?? 'Jemand'}: ${c.text}`;
        container.appendChild(el);
      });
    }
  }
}

function renderAiStatus(msg) {
  const el = $('#aiStatus');
  if (el) el.textContent = msg || '';
}

// --- KI Suche ---
async function handleSearch() {
  const q = ($('#searchInput')?.value || '').trim();
  if (!q) return;
  const resBox = $('#searchResults');
  if (resBox) resBox.innerHTML = '';

  // Kontext sammeln (ähnlich wie Generierung)
  const startIso = iso(ACTIVE.currentWeekStart);
  const foods = DB.foods;
  const profiles = DB.profiles.map(p => ({ id: p.id, name: p.name }));
  const prefs = DB.prefs;
  const planKeys = Object.keys(DB.plans).sort();
  const lastKeys = planKeys.slice(-8);
  const history = [];
  const comments = [];
  for (const wk of lastKeys) {
    const plan = DB.plans[wk];
    if (!plan) continue;
    history.push({ weekStart: plan.weekStart || wk, days: plan.days?.map(d => ({ date: d.date, theme: d.theme, meals: d.meals?.map(m => ({ name: m.name, items: m.items?.map(it => ({ name: it.name, type: it.type })) })) })) });
    const cms = plan.comments || {};
    for (const key of Object.keys(cms)) {
      const parts = String(key).split('_');
      const di = parseInt(parts[0], 10);
      const mi = parseInt(parts[1], 10);
      const day = Array.isArray(plan.days) && plan.days[di] ? plan.days[di] : null;
      const meal = day && Array.isArray(day.meals) && day.meals[mi] ? day.meals[mi] : null;
      const date = day?.date || null;
      const mealName = meal?.name || null;
      for (const c of cms[key]) {
        const items = Array.isArray(c.items) && c.items.length
          ? c.items.map(it => ({ name: it.name, type: it.type }))
          : (meal?.items || []).map(it => ({ name: it.name, type: it.type }));
        const p = DB.profiles.find(x => x.id === c.profileId);
        comments.push({ when: c.time, by: p?.name || c.profileId, text: c.text, week: plan.weekStart || wk, date, mealName, items });
      }
    }
  }

  const body = { query: q, startIso, foods, profiles, prefs, history, comments };
  try {
    const resp = await fetch('/api/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    renderSearchResults(data, q);
  } catch (e) {
    renderSearchResults(offlineSearch(q), q);
  }
}

function renderSearchResults(data, query) {
  const box = $('#searchResults'); if (!box) return;
  const { answer, foodMatches, planMatches, commentInsights } = data || {};
  const mkMsg = (from, text) => {
    const d = document.createElement('div'); d.className = 'msg';
    const f = document.createElement('div'); f.className = 'from'; f.textContent = from;
    const b = document.createElement('div'); b.textContent = text;
    d.appendChild(f); d.appendChild(b); return d;
  };
  box.innerHTML = '';
  if (answer) box.appendChild(mkMsg('KI', String(answer)));

  if (Array.isArray(foodMatches) && foodMatches.length) {
    const d = document.createElement('div'); d.className = 'msg';
    const f = document.createElement('div'); f.className = 'from'; f.textContent = 'Gerichte'; d.appendChild(f);
    const ul = document.createElement('ul'); ul.className = 'items';
    for (const it of foodMatches.slice(0, 20)) {
      const li = document.createElement('li');
      const line = `${it?.name ? it.name : ''}${it?.type? ' ('+it.type+')':''}${Array.isArray(it?.tags)&&it.tags.length? ' – '+it.tags.join(', '):''}${it?.why? ' — '+it.why:''}`;
      li.textContent = line; ul.appendChild(li);
    }
    d.appendChild(ul); box.appendChild(d);
  }

  if (Array.isArray(planMatches) && planMatches.length) {
    const d = document.createElement('div'); d.className = 'msg';
    const f = document.createElement('div'); f.className = 'from'; f.textContent = 'Pläne'; d.appendChild(f);
    const ul = document.createElement('ul'); ul.className = 'items';
    for (const m of planMatches.slice(0, 20)) {
      const items = (m.items||[]).map(x=>x.name).filter(Boolean).join(', ');
      const line = `${m?.date||''} ${m?.mealName||''}: ${items}${m?.why? ' — '+m.why:''}`;
      const li = document.createElement('li'); li.textContent = line; ul.appendChild(li);
    }
    d.appendChild(ul); box.appendChild(d);
  }

  if (Array.isArray(commentInsights) && commentInsights.length) {
    const d = document.createElement('div'); d.className = 'msg';
    const f = document.createElement('div'); f.className = 'from'; f.textContent = 'Kommentare'; d.appendChild(f);
    const ul = document.createElement('ul'); ul.className = 'items';
    for (const c of commentInsights.slice(0, 20)) {
      const line = `${c?.date||''} ${c?.by||''}: ${c?.text||''}${c?.sentiment? ' ('+c.sentiment+')':''}${c?.why? ' — '+c.why:''}`;
      const li = document.createElement('li'); li.textContent = line; ul.appendChild(li);
    }
    d.appendChild(ul); box.appendChild(d);
  }

  if (!box.childNodes.length) {
    box.appendChild(mkMsg('KI', 'Keine Treffer.'));
  }
}

function offlineSearch(query) {
  const q = query.toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);
  const foodMatches = DB.foods.filter(f => {
    const hay = [f.name, f.type, ...(f.tags||[])].join(' ').toLowerCase();
    return tokens.every(t => hay.includes(t));
  }).map(f => ({ id: f.id, name: f.name, type: f.type, tags: f.tags||[], why: 'Keyword-Treffer' }));

  const planMatches = [];
  const planKeys = Object.keys(DB.plans).sort().reverse().slice(0, 12);
  for (const wk of planKeys) {
    const plan = DB.plans[wk]; if (!plan) continue;
    for (const d of plan.days||[]) {
      for (const m of d.meals||[]) {
        const text = [m.name, ...(m.items||[]).map(it=>it.name)].join(' ').toLowerCase();
        if (tokens.every(t => text.includes(t))) {
          planMatches.push({ weekStart: plan.weekStart||wk, date: d.date, mealName: m.name, items: m.items||[], why: 'Keyword-Treffer' });
        }
      }
    }
  }

  const commentInsights = [];
  for (const wk of planKeys) {
    const plan = DB.plans[wk]; const cms = plan?.comments||{};
    for (const key of Object.keys(cms)) {
      for (const c of cms[key]) {
        const t = (c.text||'').toLowerCase();
        if (tokens.every(x=>t.includes(x))) {
          const idx = key.split('_');
          const di = parseInt(idx[0],10); const mi = parseInt(idx[1],10);
          const day = plan.days?.[di]; const meal = day?.meals?.[mi];
          commentInsights.push({ date: day?.date, mealName: meal?.name, text: c.text, by: (DB.profiles.find(p=>p.id===c.profileId)?.name)||c.profileId, sentiment: 'neutral', why: 'Keyword-Treffer' });
        }
      }
    }
  }

  return { answer: '', foodMatches, planMatches, commentInsights };
}
function pushMsgSafe(text, from = 'KI') {
  const box = $('#aiMessages');
  if (!box) return;
  const div = document.createElement('div');
  div.className = 'msg';
  const fromEl = document.createElement('div');
  fromEl.className = 'from';
  fromEl.textContent = from;
  const bodyEl = document.createElement('div');
  bodyEl.textContent = text;
  div.appendChild(fromEl);
  div.appendChild(bodyEl);
  box.prepend(div);
}
function pushAiMessage(text, from = 'KI') {
  const box = $('#aiMessages');
  const div = document.createElement('div');
  div.className = 'msg';
  div.innerHTML = `<div class="from">${from}</div><div>${text}</div>`;
  box.prepend(div);
}

// --- Actions ---
function addProfile() {
  const name = prompt('Name des Profils?');
  if (!name) return;
  const color = `hsl(${Math.floor(Math.random()*360)} 60% 50%)`;
  DB.profiles.push({ id: uid(), name, color, isCook: false });
  persist.set('fe_profiles', DB.profiles);
  renderProfiles();
}

function toggleCook(profileId) {
  // Ensure exactly one cook
  DB.profiles = DB.profiles.map(p => ({ ...p, isCook: p.id === profileId }));
  persist.set('fe_profiles', DB.profiles);
  renderProfiles();
}

function switchProfile(profileId) {
  ACTIVE.profileId = profileId;
  renderProfiles();
  renderFoods();
}

function deleteProfile(profileId) {
  if (!confirm('Profil wirklich löschen?')) return;
  const ix = DB.profiles.findIndex(p => p.id === profileId);
  if (ix >= 0) DB.profiles.splice(ix, 1);
  if (DB.profiles.length === 0) {
    ensureDefaults();
    persist.set('fe_profiles', DB.profiles);
  }
  if (!DB.profiles.find(p => p.id === ACTIVE.profileId)) {
    ACTIVE.profileId = DB.profiles[0].id;
  }
  persist.set('fe_profiles', DB.profiles);
  renderProfiles();
}

function addFood() {
  const name = $('#foodName').value.trim();
  const type = $('#foodType').value;
  const tags = $('#foodTags').value.split(',').map(t => t.trim()).filter(Boolean);
  if (!name) return;
  DB.foods.push({ id: uid(), name, type, tags });
  persist.set('fe_foods', DB.foods);
  $('#foodName').value = '';
  $('#foodTags').value = '';
  renderFoods();
}

function removeFood(foodId) {
  if (!confirm('Gericht wirklich entfernen?')) return;
  DB.foods = DB.foods.filter(f => f.id !== foodId);
  persist.set('fe_foods', DB.foods);
  // Remove prefs entries
  for (const pid of Object.keys(DB.prefs)) {
    if (DB.prefs[pid] && DB.prefs[pid][foodId]) delete DB.prefs[pid][foodId];
  }
  persist.set('fe_prefs', DB.prefs);
  renderFoods();
}

function setPreference(foodId, value) {
  ensurePrefs(ACTIVE.profileId);
  const cur = DB.prefs[ACTIVE.profileId][foodId] || 'neutral';
  DB.prefs[ACTIVE.profileId][foodId] = cur === value ? 'neutral' : value; // toggle
  persist.set('fe_prefs', DB.prefs);
  renderFoods();
}

function addComment(di, mi, text) {
  const plan = getPlanForWeek(ACTIVE.currentWeekStart);
  if (!plan) return;
  if (!plan.comments) plan.comments = {};
  const key = `${di}_${mi}`;
  if (!plan.comments[key]) plan.comments[key] = [];
  // Snapshot der betroffenen Mahlzeit und Items mitschreiben, damit KI den Bezug zum Essen kennt
  const day = Array.isArray(plan.days) && plan.days[di] ? plan.days[di] : null;
  const meal = day && Array.isArray(day.meals) && day.meals[mi] ? day.meals[mi] : null;
  const items = (meal?.items || []).map(it => ({ name: it.name, type: it.type }));
  const payload = {
    profileId: ACTIVE.profileId,
    text,
    time: new Date().toISOString(),
    mealName: meal?.name || null,
    date: day?.date || null,
    items,
  };
  plan.comments[key].push(payload);
  setPlanForWeek(ACTIVE.currentWeekStart, plan);
  renderPlan();
}

// --- Planner (offline fallback) ---
function aggregateScores() {
  const scores = new Map();
  for (const f of DB.foods) {
    let score = 0;
    for (const pid of Object.keys(DB.prefs)) {
      const v = DB.prefs[pid]?.[f.id];
      if (v === 'like') score += 2; // reward likes
      if (v === 'dislike') score -= 3; // penalize dislikes
    }
    scores.set(f.id, score);
  }
  return scores;
}

function recentUsedNames(limitWeeks = 2) {
  // Collect names used in last N weeks to avoid repeats
  const keys = Object.keys(DB.plans).sort().reverse().slice(0, limitWeeks);
  const set = new Set();
  for (const wk of keys) {
    const plan = DB.plans[wk];
    if (!plan) continue;
    for (const day of plan.days) {
      for (const meal of day.meals) {
        for (const it of meal.items) set.add(it.name.toLowerCase());
      }
    }
  }
  return set;
}

function pickByType(type, excludeNames, count = 1, tagsHint = []) {
  const scores = aggregateScores();
  const pool = DB.foods.filter(f => f.type === type && !excludeNames.has(f.name.toLowerCase()));
  // Prefer foods that match at least one tag hint
  const scored = pool.map(f => {
    const tagBoost = f.tags.some(t => tagsHint.includes(t)) ? 1 : 0;
    return { f, s: (scores.get(f.id) || 0) + tagBoost };
  }).sort((a,b) => b.s - a.s);
  return scored.slice(0, Math.max(count, 0)).map(x => x.f);
}

function offlineGeneratePlan(startDate) {
  const used = recentUsedNames(2);
  const days = [];
  const themes = ['italienisch','asiatisch','hausmannskost','mexikanisch','leicht','komfort'];
  const themeFor = (i) => themes[i % themes.length];

  for (let i = 0; i < 7; i++) {
    const d = addDays(startDate, i);
    const theme = themeFor(i);
    // Candidates (prefer top few to increase variety)
    const mains = pickByType('Hauptgericht', used, 5, [theme]);
    const sides = pickByType('Beilage', used, 5, [theme]);
    const salads = pickByType('Salat', used, 5, [theme]);

    // Only lunch
    const lunchMain = mains[0] || null;
    const lunchSide = sides[0] || null;
    const lunchSalad = salads[0] || null;

    const meals = [];
    if (lunchMain) {
      meals.push({ name: 'Mittagessen', items: [lunchMain, lunchSide, lunchSalad].filter(Boolean).map(x => ({ name: x.name, type: x.type })) });
      used.add(lunchMain.name.toLowerCase());
      if (lunchSide) used.add(lunchSide.name.toLowerCase());
      if (lunchSalad) used.add(lunchSalad.name.toLowerCase());
    }

    // If we somehow could not find matches, add placeholders
    if (meals.length === 0) {
      meals.push({ name: 'Mittagessen', items: [{ name: 'Wunschgericht der Familie', type: 'Hauptgericht' }] });
    }

    days.push({ date: iso(d), theme, meals });
  }

  const msg = `Ich habe einen abwechslungsreichen Plan erstellt. Ich vermeide Wiederholungen der letzten Wochen und bevorzuge Gerichte mit vielen "Gefällt mir". Pro Tag gibt es genau ein Essen: das Mittagessen – mit passenden Beilagen/Salat, abgestimmt auf das Tages-Thema (z. B. ${themes.slice(0,3).join(', ')}).`;

  return { weekStart: iso(startDate), days, comments: {}, source: 'offline', aiMessage: msg };
}

// --- Gemini Integration (optional) ---
async function generateWithGemini(startDate) {
  const startIso = iso(startDate);
  const foods = DB.foods;
  const profiles = DB.profiles.map(p => ({ id: p.id, name: p.name }));
  const prefs = DB.prefs;
  const recently = Array.from(recentUsedNames(2));
  // Collect recent comments and minimal plan history
  const planKeys = Object.keys(DB.plans).sort();
  const lastKeys = planKeys.slice(-8);
  const comments = [];
  const history = [];
  for (const wk of lastKeys) {
    const plan = DB.plans[wk];
    if (!plan) continue;
    history.push({ weekStart: plan.weekStart || wk, days: plan.days?.map(d => ({ date: d.date, theme: d.theme, meals: d.meals?.map(m => ({ name: m.name, items: m.items?.map(it => ({ name: it.name, type: it.type })) })) })) });
    const cms = plan.comments || {};
    for (const key of Object.keys(cms)) {
      const parts = String(key).split('_');
      const di = parseInt(parts[0], 10);
      const mi = parseInt(parts[1], 10);
      const day = Array.isArray(plan.days) && plan.days[di] ? plan.days[di] : null;
      const meal = day && Array.isArray(day.meals) && day.meals[mi] ? day.meals[mi] : null;
      const date = day?.date || null;
      const mealName = meal?.name || null;
      for (const c of cms[key]) {
        const items = Array.isArray(c.items) && c.items.length
          ? c.items.map(it => ({ name: it.name, type: it.type }))
          : (meal?.items || []).map(it => ({ name: it.name, type: it.type }));
        const p = DB.profiles.find(x => x.id === c.profileId);
        comments.push({ when: c.time, by: p?.name || c.profileId, text: c.text, week: plan.weekStart || wk, date, mealName, items });
      }
    }
  }
  comments.sort((a,b) => String(a.when||'').localeCompare(String(b.when||'')));
  const recentComments = comments.slice(-120);

  const body = {
    startIso,
    foods,
    profiles,
    prefs,
    recently,
    comments: recentComments,
    history,
    customPrompt: DB.customPrompt || ''
  };

  try {
    renderAiStatus('Frage Backend …');
    const res = await fetch('/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const plan = await res.json();
    if (!plan?.days) throw new Error('Ungültige Antwort');
    return plan;
  } catch (e) {
    console.warn('Backend/Gemini Fehler:', e);
    renderAiStatus('Backend nicht erreichbar – nutze Offline-Plan');
    return null;
  }
}

async function handleGeneratePlan() {
  const ap = DB.profiles.find(p => p.id === ACTIVE.profileId);
  if (!ap?.isCook) {
    alert('Nur das Köchin-Profil kann den Plan generieren.');
    return;
  }
  const start = new Date(ACTIVE.currentWeekStart);
  let plan = null;
  pushMsgSafe('Ich erstelle einen Wochenplan basierend auf euren Vorlieben …');
  plan = await generateWithGemini(start);
  if (!plan) plan = offlineGeneratePlan(start);
  setPlanForWeek(start, plan);
  renderPlan();
  if (plan.aiMessage) pushMsgSafe(plan.aiMessage);
  else pushMsgSafe('Plan erstellt. Guten Appetit!');
  renderAiStatus('Bereit');
}

// --- Wire up ---
function setupEvents() {
  $('#prevWeekBtn').addEventListener('click', () => {
    ACTIVE.currentWeekStart = addDays(ACTIVE.currentWeekStart, -7);
    renderWeekLabel();
    renderPlan();
  });
  $('#nextWeekBtn').addEventListener('click', () => {
    ACTIVE.currentWeekStart = addDays(ACTIVE.currentWeekStart, 7);
    renderWeekLabel();
    renderPlan();
  });
  const curBtn = $('#currentWeekBtn');
  if (curBtn) {
    curBtn.addEventListener('click', () => {
      ACTIVE.currentWeekStart = weekStart(new Date());
      renderWeekLabel();
      renderPlan();
    });
  }
  $('#generateBtn').addEventListener('click', handleGeneratePlan);

  $('#addProfileBtn').addEventListener('click', addProfile);
  // Switch active profile on tap
  let suppressProfileClick = false;
  $('#profilesList').addEventListener('click', (e) => {
    const btn = e.target.closest('.profile-btn');
    if (!btn) return;
    if (suppressProfileClick) { e.preventDefault(); return; }
    const id = btn.dataset.id;
    switchProfile(id);
  });

  // Long-press avatar to change image
  let lpTimer = null; let lpTargetId = null; let lpTriggered = false;
  const profileList = $('#profilesList');
  const startLP = (id) => { lpTriggered = false; lpTargetId = id; lpTimer = setTimeout(() => { lpTriggered = true; suppressProfileClick = true; setTimeout(()=>suppressProfileClick=false, 700); openImagePickerFor(id); }, 600); };
  const clearLP = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };
  profileList.addEventListener('pointerdown', (e) => {
    const av = e.target.closest('.profile-avatar'); if (!av) return; startLP(av.dataset.id);
  });
  profileList.addEventListener('pointerup', clearLP);
  profileList.addEventListener('pointercancel', clearLP);

  $('#addFoodBtn').addEventListener('click', addFood);
  $('#foodsList').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.dataset.id;
    const act = btn.dataset.act;
    if (act === 'like') setPreference(id, 'like');
    if (act === 'dislike') setPreference(id, 'dislike');
    if (act === 'removeFood') removeFood(id);
  });

  $('#weekGrid').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act="addComment"]');
    if (!btn) return;
    const di = parseInt(btn.dataset.di, 10);
    const mi = parseInt(btn.dataset.mi, 10);
    const input = btn.parentElement.querySelector('input');
    const text = input.value.trim();
    if (!text) return;
    addComment(di, mi, text);
    input.value = '';
  });

  const savePromptBtn = $('#savePromptBtn');
  if (savePromptBtn) {
    savePromptBtn.addEventListener('click', () => {
      const v = $('#customPrompt')?.value?.trim() || '';
      DB.customPrompt = v;
      persist.set('fe_customPrompt', DB.customPrompt);
      renderAiStatus(v ? 'Prompt gespeichert' : 'Prompt geleert');
    });
  }

  // Suche
  const sBtn = $('#searchBtn');
  if (sBtn) sBtn.addEventListener('click', handleSearch);
  const sInput = $('#searchInput');
  if (sInput) {
    sInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleSearch();
    });
  }
}

function openImagePickerFor(profileId) {
  const input = $('#profileImageInput');
  input.value = '';
  input.onchange = async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const dataUrl = await resizeToDataURL(file, 256);
    const p = DB.profiles.find(p => p.id === profileId);
    if (p) {
      p.img = dataUrl;
      persist.set('fe_profiles', DB.profiles);
      renderProfiles();
    }
  };
  input.click();
}

function resizeToDataURL(file, size = 256) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const s = Math.min(img.width, img.height);
        const sx = (img.width - s) / 2;
        const sy = (img.height - s) / 2;
        canvas.width = size; canvas.height = size;
        ctx.drawImage(img, sx, sy, s, s, 0, 0, size, size);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = reject;
      img.src = fr.result;
    };
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

async function boot() {
  await loadInitialData();
  // Require unlock as früh wie möglich
  await ensurePatternLock();
  // Initialize active profile
  if (!ACTIVE.profileId) {
    const helen = DB.profiles.find(p => p.name.toLowerCase() === 'helen');
    ACTIVE.profileId = (helen?.id) || DB.profiles[0]?.id;
  }
  // Prefill custom prompt for cook UI if present
  const cp = $('#customPrompt'); if (cp && DB.customPrompt) cp.value = DB.customPrompt;
  // Ensure Helen is marked as Köchin if present (one-time migration)
  try {
    const migDone = await persist.get('fe_mig_helen_cook', false);
    const helen = DB.profiles.find(p => p.name.toLowerCase() === 'helen');
    if (!migDone && helen) {
      const someoneCook = DB.profiles.some(p => p.isCook);
      if (!someoneCook || !helen.isCook) {
        DB.profiles = DB.profiles.map(p => ({ ...p, isCook: p.id === helen.id }));
        persist.set('fe_profiles', DB.profiles);
      }
      persist.set('fe_mig_helen_cook', true);
    }
  } catch {}

  renderWeekLabel();
  renderProfiles();
  renderFoods();
  renderPlan();
  renderAiStatus('Bereit');
  setupEvents();
  // Service Worker nur in sicheren Kontexte (HTTPS/localhost)
  try {
    const isSecure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if ('serviceWorker' in navigator && isSecure) {
      navigator.serviceWorker.register('/sw.js?v=1').catch(()=>{});
    }
  } catch {}
}

document.addEventListener('DOMContentLoaded', () => { boot().catch(console.error); });
