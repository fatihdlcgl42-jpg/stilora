'use strict';
/* Stilora – iPhone için web sürümü (PWA)
   Veriler yalnızca bu cihazda (IndexedDB) saklanır. */

const VERSION = '0.1.0';

const CATEGORIES = ['Üst giyim', 'Alt giyim', 'Elbise / Tulum', 'Dış giyim', 'Ayakkabı', 'Çanta', 'Aksesuar', 'Spor', 'Ev / İç giyim'];
const SEASONS = ['Dört mevsim', 'İlkbahar / Sonbahar', 'Yaz', 'Kış'];
const FORMALITY = ['Günlük', 'Smart casual', 'Resmi', 'Spor'];
const THICKNESS = ['İnce', 'Orta', 'Kalın'];
const FITS = ['', 'Slim fit', 'Regular fit', 'Oversize', 'Relaxed', 'Skinny', 'Straight', 'Wide leg', 'Bol paça', 'Boru paça', 'İspanyol paça', 'Mom fit', 'Crop', 'Diğer'];
const OCCASIONS = ['Günlük', 'İş', 'Okul', 'Akşam yemeği', 'Düğün / Davet', 'Randevu', 'Spor', 'Seyahat'];
const DEFAULT_MODEL = 'gemini-2.5-flash';
const BULK_DELAY_MS = 60 * 1000;      // toplu analizde iki fotoğraf arası bekleme
const QUOTA_WAIT_MS = 2 * 60 * 1000;  // 429 alınca bekleme

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

/* ---------------- Veritabanı ---------------- */
let db;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('stilora', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('items')) d.createObjectStore('items', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function tx(store, mode, fn) {
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const out = fn(s);
    t.oncomplete = () => res(out && 'result' in out ? out.result : undefined);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('İşlem iptal edildi'));
  });
}
const putItem = (it) => tx('items', 'readwrite', (s) => s.put(it));
const delItem = (id) => tx('items', 'readwrite', (s) => s.delete(id));
const allItems = () => tx('items', 'readonly', (s) => s.getAll());
const getMeta = (k) => tx('meta', 'readonly', (s) => s.get(k));
const setMeta = (k, v) => tx('meta', 'readwrite', (s) => s.put(v, k));

/* ---------------- Durum ---------------- */
let items = [];
let profiles = [];
let activeProfile = null;
let filterCat = '';
let favOnly = false;
const urlCache = new Map();

function photoURL(it) {
  if (!it.photo) return '';
  const cached = urlCache.get(it.id);
  if (cached && cached.blob === it.photo) return cached.url;
  if (cached) URL.revokeObjectURL(cached.url);
  const url = URL.createObjectURL(it.photo);
  urlCache.set(it.id, { blob: it.photo, url });
  return url;
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}

/* ---------------- Ayarlar (anahtar) ---------------- */
function lsGet(k, d = '') { try { return localStorage.getItem(k) ?? d; } catch { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* yoksay */ } }
const apiKey = () => lsGet('stilora.key');
const apiModel = () => lsGet('stilora.model') || DEFAULT_MODEL;

/* ---------------- Fotoğraf işleme ---------------- */
async function loadImage(file) {
  if ('createImageBitmap' in window) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* aşağıdaki yola düş */ }
  }
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('Fotoğraf açılamadı'));
    img.src = URL.createObjectURL(file);
  });
}
async function shrink(file, max = 1000, q = 0.82) {
  const img = await loadImage(file);
  const w = img.width, h = img.height;
  const k = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * k); c.height = Math.round(h * k);
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(img, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob(res, 'image/jpeg', q));
}
function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}
function blobToDataURL(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}
async function dataURLToBlob(d) {
  return (await fetch(d)).blob();
}

/* ---------------- Gemini ---------------- */
class QuotaError extends Error {}

async function gemini(parts) {
  const key = apiKey();
  if (!key) throw new Error('API anahtarı yok');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(apiModel())}:generateContent?key=${encodeURIComponent(key)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.5 }
    })
  });
  if (r.status === 429) throw new QuotaError('Yapay zekâ kotası doldu (429)');
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error?.message || `Hata ${r.status}`);
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  const clean = text.replace(/^```(json)?/i, '').replace(/```$/, '').trim();
  return JSON.parse(clean);
}

function pick(val, list, fallback = '') {
  if (!val) return fallback;
  const v = String(val).toLowerCase();
  return list.find((x) => x.toLowerCase() === v) || list.find((x) => x && x.toLowerCase().includes(v)) || list.find((x) => x && v.includes(x.toLowerCase())) || fallback;
}

async function analyzeItem(it) {
  const b64 = await blobToBase64(it.photo);
  const prompt = `Bu fotoğraftaki tek bir kıyafeti/aksesuarı incele ve SADECE şu JSON'u döndür:
{"name": "kısa Türkçe ad (ör. Lacivert keten gömlek)",
 "category": "${CATEGORIES.join('" | "')}",
 "color": "ana renk(ler), Türkçe",
 "season": "${SEASONS.join('" | "')}",
 "formality": "${FORMALITY.join('" | "')}",
 "fabric": "tahmini kumaş, Türkçe",
 "thickness": "${THICKNESS.join('" | "')}"}`;
  const j = await gemini([{ text: prompt }, { inline_data: { mime_type: 'image/jpeg', data: b64 } }]);
  // Kullanıcının elle düzelttiği alanları ezme
  const edited = new Set(it.userEdited || []);
  const set = (k, v) => { if (!edited.has(k) && v) it[k] = v; };
  set('name', j.name);
  set('category', pick(j.category, CATEGORIES));
  set('color', j.color);
  set('season', pick(j.season, SEASONS));
  set('formality', pick(j.formality, FORMALITY));
  set('fabric', j.fabric);
  set('thickness', pick(j.thickness, THICKNESS));
  it.aiStatus = 'done';
  it.updatedAt = Date.now();
  await putItem(it);
}

/* ---------------- Arka plan analiz kuyruğu ---------------- */
let queueRunning = false;
let queueWakeAt = 0;

function pendingItems() {
  return items.filter((i) => i.aiStatus === 'pending').sort((a, b) => a.createdAt - b.createdAt);
}
function updateQueueInfo() {
  const n = pendingItems().length;
  const el = $('#queueInfo');
  if (!apiKey()) { el.textContent = n ? `${n} kıyafet analiz bekliyor. Analiz için Ayarlar'dan API anahtarı gir.` : ''; return; }
  if (!n) { el.textContent = ''; return; }
  const wait = Math.max(0, Math.round((queueWakeAt - Date.now()) / 1000));
  el.textContent = `${n} kıyafet analiz sırasında` + (wait ? ` · sıradaki ~${wait} sn sonra` : ' · analiz ediliyor…');
}
setInterval(updateQueueInfo, 1000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runQueue() {
  if (queueRunning) return;
  queueRunning = true;
  try {
    while (apiKey()) {
      const next = pendingItems()[0];
      if (!next) break;
      try {
        await analyzeItem(next);
        renderGrid();
        if (pendingItems().length) { queueWakeAt = Date.now() + BULK_DELAY_MS; await sleep(BULK_DELAY_MS); }
      } catch (e) {
        if (e instanceof QuotaError) {
          queueWakeAt = Date.now() + QUOTA_WAIT_MS;
          await sleep(QUOTA_WAIT_MS);
        } else {
          next.aiStatus = 'failed';
          next.aiError = String(e.message || e);
          await putItem(next);
          renderGrid();
        }
      }
    }
  } finally {
    queueRunning = false;
    queueWakeAt = 0;
    updateQueueInfo();
  }
}

/* ---------------- Profiller ---------------- */
async function loadProfiles() {
  profiles = (await getMeta('profiles')) || [];
  if (!profiles.length) {
    profiles = [{ id: 'p1', name: 'Ben' }];
    await setMeta('profiles', profiles);
  }
  activeProfile = (await getMeta('activeProfile')) || profiles[0].id;
  if (!profiles.some((p) => p.id === activeProfile)) activeProfile = profiles[0].id;
}
function renderProfiles() {
  const sel = $('#profileSelect');
  sel.innerHTML = '';
  for (const p of profiles) sel.add(new Option(p.name, p.id, false, p.id === activeProfile));
  const list = $('#profileList');
  list.innerHTML = '';
  for (const p of profiles) {
    const n = items.filter((i) => i.profileId === p.id).length;
    const row = document.createElement('div');
    row.className = 'profileRow';
    row.innerHTML = `<span></span><span class="muted"></span>`;
    row.children[0].textContent = p.name;
    row.children[1].textContent = `${n} parça`;
    const ren = document.createElement('button');
    ren.className = 'smallbtn'; ren.style.flex = '0 0 auto'; ren.textContent = 'Adını değiştir';
    ren.onclick = async () => {
      const name = prompt('Yeni ad', p.name);
      if (!name) return;
      p.name = name.trim();
      await setMeta('profiles', profiles);
      renderProfiles();
    };
    row.appendChild(ren);
    list.appendChild(row);
  }
}

/* ---------------- Gardırop görünümü ---------------- */
function profileItems() { return items.filter((i) => i.profileId === activeProfile); }

function renderCatChips() {
  const wrap = $('#catChips');
  wrap.innerHTML = '';
  const mk = (label, val) => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = label;
    b.setAttribute('aria-pressed', String(filterCat === val));
    b.onclick = () => { filterCat = val; renderCatChips(); renderGrid(); };
    wrap.appendChild(b);
  };
  mk('Tümü', '');
  for (const c of CATEGORIES) if (profileItems().some((i) => i.category === c)) mk(c, c);
}

function renderGrid() {
  const q = $('#search').value.trim().toLocaleLowerCase('tr');
  let list = profileItems();
  if (filterCat) list = list.filter((i) => i.category === filterCat);
  if (favOnly) list = list.filter((i) => i.favorite);
  if (q) list = list.filter((i) => [i.name, i.category, i.color, i.brand, i.fabric, i.season, i.formality, i.fit, i.note]
    .join(' ').toLocaleLowerCase('tr').includes(q));
  list.sort((a, b) => b.createdAt - a.createdAt);

  const grid = $('#grid');
  grid.innerHTML = '';
  $('#emptyWardrobe').classList.toggle('hidden', profileItems().length > 0);
  for (const it of list) {
    const b = document.createElement('button');
    b.className = 'item';
    const img = document.createElement('img');
    img.loading = 'lazy'; img.alt = it.name || ''; img.src = photoURL(it);
    const cap = document.createElement('div');
    cap.className = 'cap';
    cap.textContent = it.name || it.category || 'Adsız';
    b.append(img, cap);
    if (it.favorite) { const f = document.createElement('span'); f.className = 'fav'; f.textContent = '★'; b.appendChild(f); }
    if (it.aiStatus === 'pending') { const s = document.createElement('span'); s.className = 'badge'; s.textContent = '⏳'; b.appendChild(s); }
    if (it.aiStatus === 'failed') { const s = document.createElement('span'); s.className = 'badge'; s.textContent = '⚠️'; b.appendChild(s); }
    b.onclick = () => openEditor(it);
    grid.appendChild(b);
  }
  renderCatChips();
  updateQueueInfo();
}

/* ---------------- Düzenleme penceresi ---------------- */
function fillSelect(sel, list, emptyLabel) {
  sel.innerHTML = '';
  if (emptyLabel !== undefined) sel.add(new Option(emptyLabel, ''));
  for (const v of list) if (v) sel.add(new Option(v, v));
}
const FIELDS = ['name', 'category', 'color', 'season', 'formality', 'fabric', 'thickness', 'brand', 'size', 'fit', 'note'];
let editing = null;

function openEditor(it) {
  editing = it;
  const f = $('#editForm');
  $('#editPhoto').src = photoURL(it);
  for (const k of FIELDS) f.elements[k].value = it[k] || '';
  f.elements.favorite.checked = !!it.favorite;
  const note = $('#aiNote');
  note.textContent =
    it.aiStatus === 'pending' ? 'Yapay zekâ analizi sırada. Şimdi düzeltirsen, düzelttiğin alanlar korunur.' :
    it.aiStatus === 'failed' ? `Analiz başarısız: ${it.aiError || ''}` : '';
  $('#editDialog').showModal();
}

$('#editForm').addEventListener('submit', async (ev) => {
  const which = ev.submitter?.value;
  if (which !== 'save' || !editing) return;
  const f = $('#editForm');
  const edited = new Set(editing.userEdited || []);
  for (const k of FIELDS) {
    const v = f.elements[k].value.trim();
    if ((editing[k] || '') !== v) edited.add(k);
    editing[k] = v;
  }
  editing.favorite = f.elements.favorite.checked;
  editing.userEdited = [...edited];
  editing.updatedAt = Date.now();
  await putItem(editing);
  renderGrid();
  toast('Kaydedildi');
});

$('#deleteItem').onclick = async () => {
  if (!editing || !confirm('Bu kıyafet silinsin mi?')) return;
  await delItem(editing.id);
  items = items.filter((i) => i.id !== editing.id);
  $('#editDialog').close();
  renderGrid(); renderProfiles();
  toast('Silindi');
};

$('#reanalyze').onclick = async () => {
  if (!editing) return;
  if (!apiKey()) { toast("Önce Ayarlar'dan API anahtarı gir"); return; }
  const it = editing;
  $('#aiNote').textContent = 'Analiz ediliyor…';
  try {
    it.userEdited = [];
    await analyzeItem(it);
    openEditor(it);
    renderGrid();
  } catch (e) {
    $('#aiNote').textContent = 'Analiz başarısız: ' + (e.message || e);
  }
};

/* ---------------- Ekleme ---------------- */
async function addFiles(files, { analyzeNow }) {
  let added = [];
  for (const file of files) {
    try {
      const photo = await shrink(file);
      const it = {
        id: uid(), profileId: activeProfile, photo,
        name: '', category: '', color: '', season: '', formality: '', fabric: '', thickness: '',
        brand: '', size: '', fit: '', note: '', favorite: false,
        aiStatus: apiKey() ? 'pending' : 'none', userEdited: [],
        createdAt: Date.now() + added.length, updatedAt: Date.now()
      };
      await putItem(it);
      items.push(it);
      added.push(it);
    } catch (e) {
      toast('Bir fotoğraf eklenemedi: ' + (e.message || e));
    }
  }
  renderGrid(); renderProfiles();
  return added;
}

$('#singlePhoto').addEventListener('change', async (e) => {
  const files = [...e.target.files]; e.target.value = '';
  if (!files.length) return;
  const [it] = await addFiles(files, { analyzeNow: true });
  if (!it) return;
  showView('wardrobe');
  if (apiKey()) {
    openEditor(it);
    $('#aiNote').textContent = 'Yapay zekâ analiz ediyor…';
    try {
      await analyzeItem(it);
      if ($('#editDialog').open && editing === it) openEditor(it);
      renderGrid();
    } catch (err) {
      if (!(err instanceof QuotaError)) { it.aiStatus = 'failed'; it.aiError = err.message; await putItem(it); }
      if ($('#editDialog').open) $('#aiNote').textContent = (err instanceof QuotaError ? 'Kota doldu, analiz sıraya alındı.' : 'Analiz başarısız: ' + err.message);
      runQueue();
    }
  } else {
    openEditor(it);
    $('#aiNote').textContent = 'API anahtarı olmadığı için alanları elle doldur.';
  }
});

$('#bulkPhotos').addEventListener('change', async (e) => {
  const files = [...e.target.files]; e.target.value = '';
  if (!files.length) return;
  toast(`${files.length} fotoğraf ekleniyor…`, 4000);
  const added = await addFiles(files, { analyzeNow: false });
  toast(`${added.length} kıyafet eklendi` + (apiKey() ? ', analiz arka planda sürecek.' : '.'));
  runQueue();
});

/* ---------------- Kombin ---------------- */
let selectedOccasion = OCCASIONS[0];
function renderOccasions() {
  const w = $('#occasionChips');
  w.innerHTML = '';
  for (const o of OCCASIONS) {
    const b = document.createElement('button');
    b.className = 'chip'; b.textContent = o;
    b.setAttribute('aria-pressed', String(o === selectedOccasion && !$('#occasionText').value.trim()));
    b.onclick = () => { selectedOccasion = o; $('#occasionText').value = ''; renderOccasions(); };
    w.appendChild(b);
  }
}
$('#occasionText').addEventListener('input', renderOccasions);

function seasonOK(it, season) {
  if (!season || !it.season || it.season === 'Dört mevsim') return true;
  return it.season === season;
}

// Yapay zekâ olmadan basit kural tabanlı yedek motor
function fallbackOutfits(pool, occasion, season) {
  const formalFor = { 'İş': ['Resmi', 'Smart casual'], 'Düğün / Davet': ['Resmi', 'Smart casual'], 'Akşam yemeği': ['Smart casual', 'Resmi', 'Günlük'],
    'Randevu': ['Smart casual', 'Günlük'], 'Spor': ['Spor'], 'Okul': ['Günlük', 'Smart casual'], 'Seyahat': ['Günlük', 'Spor'], 'Günlük': ['Günlük', 'Smart casual'] };
  const ok = formalFor[occasion] || null;
  const fit = (i) => seasonOK(i, season) && (!ok || !i.formality || ok.includes(i.formality));
  const by = (c) => pool.filter((i) => i.category === c && fit(i));
  const shuffle = (a) => a.map((x) => [Math.random(), x]).sort((p, q) => p[0] - q[0]).map((p) => p[1]);
  const tops = shuffle(by('Üst giyim')), bottoms = shuffle(by('Alt giyim')), dresses = shuffle(by('Elbise / Tulum'));
  const shoes = shuffle(by('Ayakkabı')), outer = shuffle(by('Dış giyim')), bags = shuffle(by('Çanta'));
  const out = [];
  for (let k = 0; k < 3; k++) {
    const set = [];
    if (dresses.length && (k % 2 === 1 || !tops.length || !bottoms.length)) set.push(dresses[k % dresses.length]);
    else if (tops.length && bottoms.length) set.push(tops[k % tops.length], bottoms[k % bottoms.length]);
    else continue;
    if (shoes.length) set.push(shoes[k % shoes.length]);
    if (outer.length && (season === 'Kış' || season === 'İlkbahar / Sonbahar')) set.push(outer[k % outer.length]);
    if (bags.length && occasion !== 'Spor') set.push(bags[k % bags.length]);
    out.push({ title: `Öneri ${out.length + 1}`, ids: [...new Set(set.map((i) => i.id))], why: 'Tür, mevsim ve resmiyet uyumuna göre seçildi (yapay zekâsız öneri).' });
  }
  return out;
}

async function suggest() {
  const occasion = $('#occasionText').value.trim() || selectedOccasion;
  const season = $('#outfitSeason').value;
  const pool = profileItems().filter((i) => i.category);
  const status = $('#outfitStatus');
  const results = $('#outfitResults');
  results.innerHTML = '';
  if (pool.length < 2) { status.textContent = 'Kombin için en az birkaç türü belli kıyafet gerekiyor.'; return; }

  let outfits = null;
  if (apiKey()) {
    status.textContent = 'Yapay zekâ kombin hazırlıyor…';
    $('#suggestBtn').disabled = true;
    const lines = pool.map((i) => [i.id, i.category, i.name, i.color, i.season, i.formality, i.fabric, i.thickness, i.fit, i.favorite ? 'favori' : ''].join(' | '));
    const prompt = `Sen bir stil danışmanısın. Aşağıdaki gardıroptan "${occasion}" için${season ? ` ${season} mevsimine uygun` : ''} 3 farklı kombin öner.
Sadece listedeki parçaların id'lerini kullan. Her kombin giyilebilir bir bütün olsun (üst+alt veya elbise, mümkünse ayakkabı; gerekirse dış giyim/çanta/aksesuar).
SADECE şu JSON'u döndür: {"outfits":[{"title":"kısa başlık","ids":["id1","id2"],"why":"1-2 cümle Türkçe neden"}]}
Gardırop (id | tür | ad | renk | mevsim | resmiyet | kumaş | kalınlık | kalıp | favori):
${lines.join('\n')}`;
    try {
      const j = await gemini([{ text: prompt }]);
      const known = new Set(pool.map((i) => i.id));
      outfits = (j.outfits || []).map((o) => ({ ...o, ids: (o.ids || []).filter((id) => known.has(id)) })).filter((o) => o.ids.length);
      if (!outfits.length) throw new Error('Geçerli kombin dönmedi');
      status.textContent = '';
    } catch (e) {
      status.textContent = (e instanceof QuotaError ? 'Yapay zekâ kotası doldu' : 'Yapay zekâ yanıt vermedi') + ', yedek motorla öneriyorum.';
      outfits = null;
    } finally {
      $('#suggestBtn').disabled = false;
    }
  } else {
    status.textContent = 'API anahtarı olmadığı için basit yedek motorla öneriyorum.';
  }
  if (!outfits) outfits = fallbackOutfits(pool, occasion, season);
  if (!outfits.length) { status.textContent = 'Bu seçimlere uygun kombin bulamadım. Daha fazla kıyafet ekle ya da mevsimi "Farketmez" yap.'; return; }

  const byId = new Map(pool.map((i) => [i.id, i]));
  for (const o of outfits) {
    const card = document.createElement('div');
    card.className = 'outfit';
    const h = document.createElement('h3'); h.textContent = o.title || 'Kombin';
    const pieces = document.createElement('div'); pieces.className = 'pieces';
    for (const id of o.ids) {
      const it = byId.get(id); if (!it) continue;
      const d = document.createElement('div');
      const img = document.createElement('img'); img.src = photoURL(it); img.alt = it.name || '';
      img.onclick = () => openEditor(it);
      const cap = document.createElement('div'); cap.textContent = it.name || it.category;
      d.append(img, cap); pieces.appendChild(d);
    }
    const why = document.createElement('p'); why.className = 'muted'; why.textContent = o.why || '';
    card.append(h, pieces, why);
    results.appendChild(card);
  }
}
$('#suggestBtn').onclick = suggest;

/* ---------------- Yedekleme ---------------- */
async function exportBackup() {
  const st = $('#backupStatus');
  st.textContent = 'Yedek hazırlanıyor…';
  const out = [];
  for (const it of items) {
    const { photo, ...rest } = it;
    out.push({ ...rest, photo: photo ? await blobToDataURL(photo) : null });
  }
  const json = JSON.stringify({ app: 'stilora-web', format: 1, exportedAt: new Date().toISOString(), profiles, items: out });
  const name = `stilora-yedek-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([json], name, { type: 'application/json' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Stilora yedeği' });
      st.textContent = `Yedek hazır (${items.length} parça). "Dosyalara Kaydet" ile iCloud Drive'a kaydetmeyi unutma.`;
      return;
    }
  } catch (e) {
    if (e.name === 'AbortError') { st.textContent = 'Yedekleme iptal edildi.'; return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  st.textContent = `Yedek indirildi (${items.length} parça).`;
}
$('#exportBtn').onclick = exportBackup;

$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  const st = $('#backupStatus');
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'stilora-web' || !Array.isArray(data.items)) throw new Error('Bu dosya Stilora web yedeği değil');
    if (!confirm(`${data.items.length} parça geri yüklensin mi? Aynı parçalar güncellenir, diğerleri korunur.`)) return;
    st.textContent = 'Geri yükleniyor…';
    for (const p of data.profiles || []) if (!profiles.some((x) => x.id === p.id)) profiles.push(p);
    await setMeta('profiles', profiles);
    let n = 0;
    for (const raw of data.items) {
      const it = { ...raw, photo: raw.photo ? await dataURLToBlob(raw.photo) : null };
      if (!it.id) it.id = uid();
      if (!profiles.some((p) => p.id === it.profileId)) it.profileId = activeProfile;
      await putItem(it); n++;
    }
    items = await allItems();
    renderProfiles(); renderGrid();
    st.textContent = `${n} parça geri yüklendi.`;
  } catch (err) {
    st.textContent = 'Geri yükleme başarısız: ' + (err.message || err);
  }
});

/* ---------------- Ayarlar ---------------- */
$('#saveKey').onclick = () => {
  lsSet('stilora.key', $('#apiKey').value.trim());
  lsSet('stilora.model', $('#apiModel').value.trim() || DEFAULT_MODEL);
  $('#keyStatus').textContent = apiKey() ? 'Kaydedildi.' : 'Anahtar silindi.';
  if (apiKey()) {
    // Anahtar yokken eklenmiş parçaları sıraya al
    const waiting = items.filter((i) => i.aiStatus === 'none');
    Promise.all(waiting.map((i) => { i.aiStatus = 'pending'; return putItem(i); })).then(() => { renderGrid(); runQueue(); });
  }
};
$('#testKey').onclick = async () => {
  $('#saveKey').onclick();
  const st = $('#keyStatus');
  st.textContent = 'Deneniyor…';
  try {
    const j = await gemini([{ text: 'Sadece {"ok":true} döndür.' }]);
    st.textContent = j.ok ? '✅ Bağlantı çalışıyor.' : 'Yanıt geldi ama beklenen biçimde değil.';
  } catch (e) {
    st.textContent = '❌ ' + (e.message || e);
  }
};
$('#addProfile').onclick = async () => {
  const name = $('#newProfile').value.trim();
  if (!name) return;
  profiles.push({ id: 'p' + uid(), name });
  await setMeta('profiles', profiles);
  $('#newProfile').value = '';
  renderProfiles();
};
$('#profileSelect').onchange = async (e) => {
  activeProfile = e.target.value;
  await setMeta('activeProfile', activeProfile);
  filterCat = '';
  renderGrid();
};

async function showStorage() {
  const el = $('#storageInfo');
  try {
    let persisted = await navigator.storage?.persisted?.();
    if (!persisted && navigator.storage?.persist) persisted = await navigator.storage.persist();
    const est = await navigator.storage?.estimate?.();
    const mb = est ? (est.usage / 1048576).toFixed(1) : '?';
    el.textContent = `${items.length} parça · ${mb} MB kullanılıyor · ` + (persisted ? 'kalıcı depolama açık' : 'kalıcı depolama onaylanmadı, yedek almayı ihmal etme');
  } catch {
    el.textContent = `${items.length} parça`;
  }
}

/* ---------------- Gezinme ---------------- */
const TITLES = { wardrobe: 'Gardırop', add: 'Ekle', outfit: 'Kombin', settings: 'Ayarlar' };
function showView(v) {
  $$('.view').forEach((s) => s.classList.toggle('active', s.id === 'view-' + v));
  $$('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  $('#title').textContent = TITLES[v];
  if (v === 'settings') { renderProfiles(); showStorage(); }
  window.scrollTo(0, 0);
}
$$('.tabbar button').forEach((b) => (b.onclick = () => showView(b.dataset.view)));
$('#search').addEventListener('input', renderGrid);
$('#favFilter').onclick = (e) => { favOnly = !favOnly; e.currentTarget.setAttribute('aria-pressed', String(favOnly)); renderGrid(); };

/* ---------------- Başlat ---------------- */
(async function init() {
  $('#version').textContent = VERSION;
  const f = $('#editForm');
  fillSelect(f.elements.category, CATEGORIES, 'Seç');
  fillSelect(f.elements.season, SEASONS, 'Seç');
  fillSelect(f.elements.formality, FORMALITY, 'Seç');
  fillSelect(f.elements.thickness, THICKNESS, 'Seç');
  fillSelect(f.elements.fit, FITS, 'Seç');
  fillSelect($('#outfitSeason'), SEASONS.filter((s) => s !== 'Dört mevsim'), 'Farketmez');
  $('#apiKey').value = apiKey();
  $('#apiModel').value = apiModel();
  renderOccasions();
  try {
    db = await openDB();
    await loadProfiles();
    items = await allItems();
    // Uygulama kapalıyken yarım kalan analizler
    renderProfiles();
    renderGrid();
    runQueue();
  } catch (e) {
    toast('Veritabanı açılamadı: ' + (e.message || e), 8000);
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
