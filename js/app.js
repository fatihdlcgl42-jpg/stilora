// Stilora – iPhone için web sürümü (PWA). Veriler yalnızca bu cihazda saklanır.
import * as DB from './db.js';
import {
  YOK, CATEGORIES, SEASONS, FORMALITY, THICKNESS, FITS, LEGS, FIT_CATS, OCCASIONS, HARMONY, DIRTY_CATS,
  uid, newItem, migrate, toAndroid, fromAndroid
} from './model.js';
import {
  apiKey, apiModel, lsSet, keyLooksWrong, gemini, QuotaError, TempError, analyzePrompt, applyAnalysis,
  suggestOutfits, suggestCouple, fallbackOutfits, DEFAULT_MODEL, detectPrompt, parseDetections, tryOnImage
} from './ai.js';
import { getWeather, getPlace, setPlaceFromGPS, setPlaceFromCity, describeCode, weatherNote, seasonFromWeather } from './weather.js';
import { readZip, writeZip } from './zip.js';
import { avatarSVG, BODY_TYPES, bodyTypeName, bmi, bmiLabel, buildWord, skinFromFace } from './avatar.js';

const VERSION = '0.7.0';
const BULK_LIMIT = 60;

// Hız: normalde beklemeden ilerle; kota hatası (429) gelince yavaşla, başarı gelince yeniden hızlan
const FAST_DELAY_MS = 1500;
const MIN_QUOTA_WAIT_MS = 20 * 1000;
const MAX_QUOTA_WAIT_MS = 5 * 60 * 1000;
const AI_IMAGE_MAX = 640;

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dayKey = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const DAY = 86400000;

/* ================= Durum ================= */
let items = [];
let outfits = [];
let wear = [];
let profiles = [];
let activeProfile = null;
let settings = { dirtyOnWear: true, autoBg: true, sendBody: true };
let weather = null;

const closet = { cat: '', season: '', formality: '', state: '', sort: 'new', layout: 'grid', q: '' };
const style = { mode: 'single', occasion: OCCASIONS[0], pinned: null, results: [], avoid: [], busy: false };

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}

const urlCache = new Map();
function photoURL(it) {
  if (!it?.photo) return '';
  const c = urlCache.get(it.id);
  if (c && c.blob === it.photo) return c.url;
  if (c) URL.revokeObjectURL(c.url);
  const url = URL.createObjectURL(it.photo);
  urlCache.set(it.id, { blob: it.photo, url });
  return url;
}
function imgHTML(it, cls = '') {
  const u = photoURL(it);
  return u ? `<img loading="lazy" class="${cls}" src="${u}" alt="${esc(it.name)}">` : `<div class="ph ${cls}">👕</div>`;
}
const byId = (id) => items.find((i) => i.id === id);
const profileById = (id) => profiles.find((p) => p.id === id);
const hasAvatar = (p) => !!(p && (p.height || p.face));
const hasStyle = (p) => !!(p && (p.styles?.length || p.styleText || p.colors || p.avoid));
const STYLE_TAGS = ['Sade / minimal', 'Klasik', 'Şık', 'Rahat', 'Spor', 'Sokak modası', 'Bohem', 'Vintage', 'Renkli', 'İş / ofis'];
// Yapay zekâya giden tarz tarifi (fotoğraf, boy, kilo yok)
function styleNote(p) {
  if (!p) return '';
  const parts = [];
  if (p.styles?.length) parts.push(`sevdiği tarzlar: ${p.styles.join(', ')}`);
  if (p.styleText) parts.push(`kendi anlatımı: "${p.styleText}"`);
  if (p.colors) parts.push(`sevdiği renkler: ${p.colors}`);
  if (p.avoid) parts.push(`kaçındıkları: ${p.avoid}`);
  return parts.join('; ');
}
const faceCache = new Map();
function faceURL(p) {
  if (!p?.face) return '';
  const c = faceCache.get(p.id);
  if (c && c.blob === p.face) return c.url;
  if (c) URL.revokeObjectURL(c.url);
  const url = URL.createObjectURL(p.face);
  faceCache.set(p.id, { blob: p.face, url });
  return url;
}
const bodyNote = (p) => (settings.sendBody && p?.bodyType ? `${bodyTypeName(p.bodyType)} (${BODY_TYPES.find((b) => b[0] === p.bodyType)[2].toLocaleLowerCase('tr')})` : '');
const profileName = (id) => profiles.find((p) => p.id === id)?.name || 'Profil';
const mine = () => items.filter((i) => i.profileId === activeProfile);
const saveItem = (it) => { it.updatedAt = Date.now(); return DB.put('items', it); };
const saveSettings = () => DB.setMeta('settings', settings);

/* ================= Fotoğraf ================= */
async function loadImage(blob) {
  if ('createImageBitmap' in window) {
    try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch { /* aşağıya düş */ }
  }
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('Fotoğraf açılamadı'));
    img.src = URL.createObjectURL(blob);
  });
}
async function shrink(blob, max = 1200, q = 0.84) {
  const img = await loadImage(blob);
  const k = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(img, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob(res, 'image/jpeg', q));
}
const blobToDataURL = (b) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsDataURL(b); });
const dataURLToBlob = async (d) => (await fetch(d)).blob();

/* ================= Yapay zekâ analiz kuyruğu ================= */
async function analyzeItem(it) {
  const small = await shrink(it.photo, AI_IMAGE_MAX, 0.75);
  const b64 = (await blobToDataURL(small)).split(',')[1];
  const j = await gemini([{ text: analyzePrompt() }, { inline_data: { mime_type: 'image/jpeg', data: b64 } }]);
  applyAnalysis(it, j);
  await saveItem(it);
}

let aiRunning = false, aiWakeAt = 0, quotaWait = 0;
const aiPending = () => items.filter((i) => i.aiStatus === 'pending').sort((a, b) => a.createdAt - b.createdAt);

async function runAi() {
  if (aiRunning) return;
  aiRunning = true;
  try {
    while (apiKey()) {
      const next = aiPending()[0];
      if (!next) break;
      try {
        await analyzeItem(next);
        refreshAfterItemChange(next);
        quotaWait = quotaWait > MIN_QUOTA_WAIT_MS ? Math.round(quotaWait / 2) : 0;
        const pause = quotaWait ? Math.min(quotaWait, 10000) : FAST_DELAY_MS;
        if (aiPending().length) { aiWakeAt = Date.now() + pause; await sleep(pause); }
      } catch (e) {
        if (e instanceof QuotaError) {
          quotaWait = Math.min(MAX_QUOTA_WAIT_MS, quotaWait ? quotaWait * 2 : MIN_QUOTA_WAIT_MS);
          const wait = Math.max(quotaWait, e.retryMs || 0);
          aiWakeAt = Date.now() + wait;
          await sleep(wait);
        } else if (e instanceof TempError || /İnternete bağlanılamadı/.test(e.message)) {
          // Geçici sorun: parçayı başarısız sayma, biraz bekleyip yeniden dene
          aiWakeAt = Date.now() + 30000;
          await sleep(30000);
        } else {
          next.aiStatus = 'failed';
          next.aiError = String(e.message || e);
          await saveItem(next);
          refreshAfterItemChange(next);
          if (/anahtar|403|Model bulunamadı/i.test(next.aiError)) break; // her parçada aynı hatayı alma
        }
      }
    }
  } finally {
    aiRunning = false; aiWakeAt = 0;
  }
}

/* ================= Arka plan kaldırma kuyruğu ================= */
let bgRunning = false, bgMsg = '';
const bgPending = () => items.filter((i) => i.bgStatus === 'pending').sort((a, b) => a.createdAt - b.createdAt);

async function ensureBgConsent() {
  if (await DB.getMeta('bgConsent')) return true;
  const ok = confirm('Arka plan kaldırma telefonunda çalışır. Bunun için bir kez yaklaşık 75 MB indirilecek (Wi-Fi önerilir). Şimdi indirilsin mi?');
  if (ok) await DB.setMeta('bgConsent', true);
  return ok;
}

async function processBg(it, interactive = false) {
  const { removeBackground } = await import('./bg.js');
  await DB.setMeta('bgInProgress', it.id); // uygulama bellekten çökerse bir sonraki açılışta bu parçayı atlarız
  try {
    const out = await removeBackground(it.original || it.photo, (m) => { bgMsg = m; updateQueueInfo(); }, it.category);
    if (!it.original) it.original = it.photo;
    it.photo = out;
    it.bgStatus = 'done'; it.bgError = '';
  } catch (e) {
    it.bgStatus = 'failed';
    it.bgError = String(e.message || e);
    if (interactive) toast('Arka plan kaldırılamadı: ' + it.bgError, 5000);
    if (/import|fetch|Failed to|network|yükle/i.test(it.bgError)) throw e; // model inemedi: kuyruğu durdur
  } finally {
    await DB.setMeta('bgInProgress', null);
    await saveItem(it);
    refreshAfterItemChange(it);
  }
}

async function runBg() {
  if (bgRunning || !settings.autoBg || !bgPending().length) return;
  bgRunning = true;
  try {
    if (!(await ensureBgConsent())) { bgMsg = 'Arka plan kaldırma için model indirilmedi.'; return; }
    // Türü belli olsun diye önce yapay zekâ analizinin bitmesini bekle (en fazla 3 dk)
    const ready = (i) => !(apiKey() && (i.aiStatus === 'pending' || i.aiStatus === 'analyzing')) || Date.now() - i.createdAt > 180000;
    let next;
    while (settings.autoBg && bgPending().length) {
      next = bgPending().find(ready);
      if (!next) { await sleep(3000); continue; }
      try { await processBg(next); }
      catch (e) {
        next.bgStatus = 'pending'; await saveItem(next);
        bgMsg = 'Arka plan modeli yüklenemedi, internet gelince tekrar denenecek.';
        break;
      }
      await sleep(200);
    }
  } finally {
    bgRunning = false;
    if (!bgPending().length) bgMsg = '';
    updateQueueInfo();
  }
}

function updateQueueInfo() {
  const a = aiPending().filter((i) => i.profileId === activeProfile).length;
  const b = bgPending().filter((i) => i.profileId === activeProfile).length;
  const parts = [];
  if (b) parts.push(settings.autoBg ? `🪄 ${b} fotoğrafın arka planı temizlenecek` : `🪄 ${b} fotoğraf arka plan bekliyor (Profil'den açılabilir)`);
  if (a) {
    if (!apiKey()) parts.push(`🤖 ${a} parça analiz bekliyor (Profil'den API anahtarı gir)`);
    else {
      const wait = Math.max(0, Math.round((aiWakeAt - Date.now()) / 1000));
      const when = wait > 600 ? ` · günlük ücretsiz hak bitti, ${new Date(aiWakeAt).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })} civarında devam edecek`
        : wait > 90 ? ` · kota nedeniyle ~${Math.ceil(wait / 60)} dk bekleniyor` : wait > 3 ? ` · kota nedeniyle ~${wait} sn bekleniyor` : '';
      parts.push(`🤖 ${a} parça analiz sırasında` + when);
    }
  }
  if (bgMsg && b) parts.push(bgMsg);
  const txt = parts.join(' · ');
  $('#homeQueue').textContent = txt;
  const bar = $('#closetBar');
  if (bar && !bar.dataset.custom) bar.textContent = txt;
}
setInterval(updateQueueInfo, 1000);

/* ================= Profiller ve ayarlar ================= */
async function loadState() {
  profiles = (await DB.getMeta('profiles')) || [];
  if (!profiles.length) { profiles = [{ id: 'p1', name: 'Ben' }]; await DB.setMeta('profiles', profiles); }
  activeProfile = (await DB.getMeta('activeProfile')) || profiles[0].id;
  if (!profiles.some((p) => p.id === activeProfile)) activeProfile = profiles[0].id;
  settings = Object.assign(settings, (await DB.getMeta('settings')) || {});
  items = await DB.all('items');
  for (const it of items) if (migrate(it)) await DB.put('items', it);
  outfits = await DB.all('outfits');
  wear = await DB.all('wear');

  // Bir önceki açılışta arka plan kaldırırken çöktüysek o parçayı atla
  const crashed = await DB.getMeta('bgInProgress');
  if (crashed) {
    const it = byId(crashed);
    if (it) { it.bgStatus = 'failed'; it.bgError = 'Telefonun belleği yetmedi'; await DB.put('items', it); }
    await DB.setMeta('bgInProgress', null);
    const n = ((await DB.getMeta('bgCrashes')) || 0) + 1;
    await DB.setMeta('bgCrashes', n);
    if (n >= 2) {
      settings.autoBg = false; await saveSettings();
      setTimeout(() => toast('Arka plan kaldırma bu telefonda zorlandığı için otomatikten çıkarıldı. Parça detayından tek tek deneyebilirsin.', 7000), 800);
    }
  }
  // Eski model hatasıyla başarısız olanları ve yarım kalan analizleri yeniden sıraya al
  for (const it of items) {
    if (it.aiStatus === 'analyzing') { it.aiStatus = 'pending'; await DB.put('items', it); }
    if (apiKey() && it.aiStatus === 'failed' && /no longer available|not found|bulunamadı|Google|sunucu|geçici|okunamadı/i.test(it.aiError || '')) {
      it.aiStatus = 'pending'; it.aiError = ''; await DB.put('items', it);
    }
  }
}

function renderProfileSelect() {
  const sel = $('#profileSelect');
  sel.innerHTML = profiles.map((p) => `<option value="${p.id}" ${p.id === activeProfile ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
}

async function switchProfile(id) {
  activeProfile = id;
  await DB.setMeta('activeProfile', id);
  closet.cat = '';
  style.pinned = null; style.results = []; style.avoid = [];
  renderAll();
}

/* ================= Ortak parça kutusu ================= */
function tile(it, { list = false } = {}) {
  const badges = [];
  if (it.aiStatus === 'pending' || it.bgStatus === 'pending') badges.push('⏳');
  if (it.aiStatus === 'failed') badges.push('⚠️');
  if (it.check) badges.push('✓?');
  if (it.dirty) badges.push('🧺');
  if (it.stored) badges.push('📦');
  const sub = [it.category, it.color, it.brand].filter(Boolean).join(' · ');
  return `<button class="item ${it.dirty || it.stored ? 'dim' : ''}" data-id="${it.id}">
    ${imgHTML(it)}
    <div class="cap">${esc(it.name || it.category || 'Adsız')}${list ? `<small>${esc(sub)}${it.wearCount ? ` · ${it.wearCount} kez giyildi` : ''}</small>` : ''}</div>
    ${it.favorite ? '<span class="fav">★</span>' : ''}
    ${badges.length ? `<div class="badges">${badges.map((b) => `<span>${b}</span>`).join('')}</div>` : ''}
  </button>`;
}
function bindTiles(root) {
  root.querySelectorAll('.item[data-id]').forEach((b) => (b.onclick = () => openDetail(b.dataset.id)));
}

/* ================= Ana Sayfa ================= */
async function renderWeather(force = false) {
  const card = $('#weatherCard');
  const place = await getPlace();
  if (!place) {
    card.innerHTML = `<div class="wicon">🌤️</div><div class="wmain"><b>Hava durumu</b><div class="muted">Kombinlerin havaya uysun diye konum ekle.</div></div><button class="smallbtn grow0" id="wSet">Ekle</button>`;
    $('#wSet').onclick = () => { showView('profile'); $('#cityInput').focus(); };
    return;
  }
  try {
    weather = await getWeather(force);
    const d = describeCode(weather.code);
    card.innerHTML = `<div class="wicon">${d.icon}</div><div class="wmain"><div class="wtemp">${weather.now}°</div>
      <div class="muted">${esc(place.name)} · ${d.text} · ${weather.max}° / ${weather.min}°${weather.rain != null ? ` · yağış %${weather.rain}` : ''}</div></div>
      <button class="iconbtn" id="wRefresh" aria-label="Yenile">↻</button>`;
    $('#wRefresh').onclick = () => renderWeather(true);
  } catch {
    card.innerHTML = `<div class="wicon">🌡️</div><div class="wmain"><b>Hava durumu alınamadı</b><div class="muted">İnternet bağlantını kontrol et.</div></div><button class="iconbtn" id="wRefresh">↻</button>`;
    $('#wRefresh').onclick = () => renderWeather(true);
  }
  updateWeatherToggle();
}

function renderHome() {
  const me = profileById(activeProfile);
  const bn = $('#avatarBanner');
  if (!hasAvatar(me) || !hasStyle(me)) {
    const miss = [!hasAvatar(me) && 'avatarını', !hasStyle(me) && 'giyim tarzını'].filter(Boolean).join(' ve ');
    bn.classList.remove('hidden');
    bn.innerHTML = `<span class="bicon">${hasAvatar(me) ? '👗' : '🧍'}</span><div><b>Profilini tamamla</b><br>${miss[0].toLocaleUpperCase('tr') + miss.slice(1)} ekle; öneriler sana göre olsun.</div><button class="smallbtn grow0 primary" id="bnGo">Tamamla</button>`;
    $('#bnGo').onclick = () => openProfileEditor(me);
  } else bn.classList.add('hidden');
  const list = mine();
  const dirty = list.filter((i) => i.dirty);
  const lc = $('#laundryCard');
  lc.innerHTML = `<div class="row"><span><b>🧺 Kirli sepeti</b><br><span class="muted">${dirty.length ? `${dirty.length} parça yıkanmayı bekliyor` : 'Boş, her şey temiz'}</span></span>
    ${dirty.length ? '<button class="smallbtn grow0" id="lShow">Gör</button><button class="smallbtn grow0 primary" id="lWash">Hepsi yıkandı</button>' : ''}</div>`;
  if (dirty.length) {
    $('#lShow').onclick = () => { closet.state = 'dirty'; $('#fState').value = 'dirty'; showView('closet'); };
    $('#lWash').onclick = washAll;
  }
  const today = dayKey();
  const todayIds = new Set(wear.filter((w) => w.date === today && w.profileId === activeProfile).flatMap((w) => w.itemIds));
  const todayItems = [...todayIds].map(byId).filter(Boolean);
  $('#todayStrip').innerHTML = todayItems.map((i) => tile(i)).join('');
  const recent = list.filter((i) => i.lastWorn && !todayIds.has(i.id)).sort((a, b) => b.lastWorn - a.lastWorn).slice(0, 12);
  $('#recentStrip').innerHTML = recent.map((i) => tile(i)).join('');
  bindTiles($('#todayStrip')); bindTiles($('#recentStrip'));
  const ro = outfits.filter((o) => o.profileId === activeProfile || o.profiles?.includes(activeProfile)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 3);
  $('#recentOutfits').innerHTML = ro.length ? '' : '<p class="muted">Stil AI\'da beğendiğin kombini ♥ ile kaydet.</p>';
  for (const o of ro) $('#recentOutfits').appendChild(outfitCard(o, { saved: true, compact: true }));
  updateQueueInfo();
}

async function washAll() {
  const dirty = mine().filter((i) => i.dirty);
  for (const i of dirty) { i.dirty = false; await saveItem(i); }
  toast(`${dirty.length} parça temize çıktı`);
  renderAll();
}

/* ================= Dolabım ================= */
function fillSelect(sel, list, first) {
  sel.innerHTML = (first ? `<option value="">${esc(first)}</option>` : '') + list.map((v) => {
    const [val, label] = Array.isArray(v) ? v : [v, v];
    return `<option value="${esc(val)}">${esc(label)}</option>`;
  }).join('');
}

function renderCatChips() {
  const wrap = $('#catChips');
  const list = mine();
  const chips = [['', `Tümü (${list.length})`], ...CATEGORIES.filter((c) => list.some((i) => i.category === c)).map((c) => [c, `${c} (${list.filter((i) => i.category === c).length})`])];
  wrap.innerHTML = chips.map(([v, l]) => `<button class="chip" data-v="${esc(v)}" aria-pressed="${closet.cat === v}">${esc(l)}</button>`).join('');
  wrap.querySelectorAll('.chip').forEach((b) => (b.onclick = () => { closet.cat = b.dataset.v; renderCloset(); }));
}

function renderCloset() {
  renderCatChips();
  const q = closet.q.trim().toLocaleLowerCase('tr');
  let list = mine();
  if (closet.cat) list = list.filter((i) => i.category === closet.cat);
  if (closet.season) list = list.filter((i) => i.season === closet.season || (i.season === 'Dört mevsim' && closet.season !== 'Dört mevsim'));
  if (closet.formality) list = list.filter((i) => i.formality === closet.formality);
  const st = closet.state;
  if (st === 'clean') list = list.filter((i) => !i.dirty && !i.stored);
  else if (st === 'dirty') list = list.filter((i) => i.dirty);
  else if (st === 'stored') list = list.filter((i) => i.stored);
  else if (st === 'fav') list = list.filter((i) => i.favorite);
  else if (st === 'check') list = list.filter((i) => i.check || i.aiStatus === 'failed');
  else if (st === 'never') list = list.filter((i) => !i.wearCount);
  if (q) list = list.filter((i) => [i.name, i.category, i.color, i.brand, i.fabric, i.season, i.formality, i.model, i.fit, i.leg, i.note, i.size]
    .join(' ').toLocaleLowerCase('tr').includes(q));
  const sorters = {
    new: (a, b) => b.createdAt - a.createdAt,
    most: (a, b) => (b.wearCount || 0) - (a.wearCount || 0),
    least: (a, b) => (a.wearCount || 0) - (b.wearCount || 0),
    worn: (a, b) => (b.lastWorn || 0) - (a.lastWorn || 0),
    name: (a, b) => (a.name || '').localeCompare(b.name || '', 'tr')
  };
  list.sort(sorters[closet.sort] || sorters.new);

  const grid = $('#grid');
  grid.classList.toggle('list', closet.layout === 'list');
  $('#layoutBtn').textContent = closet.layout === 'list' ? '▦' : '☰';
  grid.innerHTML = list.map((i) => tile(i, { list: closet.layout === 'list' })).join('');
  bindTiles(grid);
  $('#emptyCloset').classList.toggle('hidden', mine().length > 0);

  const bar = $('#closetBar');
  if (st === 'dirty' && list.length) {
    bar.dataset.custom = '1';
    bar.innerHTML = `<span>${list.length} kirli parça</span><button id="washBtn">Hepsi yıkandı</button>`;
    $('#washBtn').onclick = washAll;
  } else if (st === 'check' && list.some((i) => i.check)) {
    bar.dataset.custom = '1';
    bar.innerHTML = `<span>Yapay zekâ tahminlerini kontrol et</span><button id="okAll">Hepsini onayla</button>`;
    $('#okAll').onclick = async () => { for (const i of list) if (i.check) { i.check = false; await saveItem(i); } renderCloset(); };
  } else {
    delete bar.dataset.custom;
    bar.textContent = '';
    if (list.length !== mine().length) bar.textContent = `${list.length} / ${mine().length} parça`;
    updateQueueInfo();
  }
}

/* ================= Detay ================= */
let detailId = null;
function openDetail(id) {
  const it = byId(id);
  if (!it) return;
  detailId = id;
  const dlg = $('#detailDialog');
  const info = [it.category, it.color, it.season, it.formality, it.fabric, it.thickness && `${it.thickness} kalınlık`, it.brand, it.size && `Beden ${it.size}`, it.model,
    it.fit && it.fit !== YOK && `Kalıp: ${it.fit}`, it.leg && it.leg !== YOK && `Paça: ${it.leg}`].filter(Boolean);
  const worn = it.wearCount ? `${it.wearCount} kez giyildi · son: ${new Date(it.lastWorn).toLocaleDateString('tr-TR')}` : 'Henüz giyilmedi';
  let status = '';
  if (it.aiStatus === 'pending') status = 'Yapay zekâ analizi sırada…';
  else if (it.aiStatus === 'failed') status = `Analiz başarısız: ${it.aiError}`;
  if (it.bgStatus === 'pending') status += (status ? ' · ' : '') + 'Arka plan temizlenecek…';
  else if (it.bgStatus === 'failed') status += (status ? ' · ' : '') + `Arka plan kaldırılamadı: ${it.bgError}`;
  $('#detailBody').innerHTML = `
    ${photoURL(it) ? `<img class="dphoto" src="${photoURL(it)}" alt="">` : '<div class="ph dphoto">👕</div>'}
    <h2 style="margin-top:10px">${esc(it.name || 'Adsız')} ${it.favorite ? '★' : ''}</h2>
    <div class="muted">${worn}${it.dirty ? ' · 🧺 kirli' : ''}${it.stored ? ' · 📦 depoda' : ''}</div>
    ${it.check ? '<div class="checkbox">🤖 Bilgiler yapay zekâ tahmini, kontrol et<button class="smallbtn grow0 primary" id="dOk">Doğru</button></div>' : ''}
    ${status ? `<p class="muted">${esc(status)}</p>` : ''}
    <div class="dinfo">${info.map((x) => `<span>${esc(x)}</span>`).join('')}</div>
    ${it.note ? `<p class="muted">📝 ${esc(it.note)}</p>` : ''}
    <div class="dgrid">
      <button class="smallbtn primary" id="dWear">👕 Bugün giydim</button>
      <button class="smallbtn" id="dCombo">✨ Bununla kombin</button>
      <button class="smallbtn ${it.favorite ? 'on' : ''}" id="dFav">${it.favorite ? '★ Favoride' : '☆ Favori'}</button>
      <button class="smallbtn ${it.dirty ? 'on' : ''}" id="dDirty">${it.dirty ? '🧺 Kirli → temiz' : '🧺 Kirli sepetine'}</button>
      <button class="smallbtn ${it.stored ? 'on' : ''}" id="dStore">${it.stored ? '📦 Depodan çıkar' : '📦 Depoya kaldır'}</button>
      <button class="smallbtn" id="dEdit">✏️ Düzenle</button>
      ${it.original ? '<button class="smallbtn" id="dOrig">↩️ Orijinal fotoğraf</button><button class="smallbtn" id="dBg">🪄 Yeniden temizle</button>' : '<button class="smallbtn" id="dBg">🪄 Arka planı kaldır</button>'}
      <button class="smallbtn" id="dAi">🤖 Yeniden analiz</button>
      <button class="smallbtn danger" id="dDel">🗑️ Sil</button>
      <button class="smallbtn" id="dClose">Kapat</button>
    </div>`;
  const upd = async (fn) => { fn(it); await saveItem(it); refreshAfterItemChange(it); openDetail(it.id); };
  $('#dOk') && ($('#dOk').onclick = () => upd((i) => { i.check = false; }));
  $('#dWear').onclick = async () => { await wearItems([it.id]); openDetail(it.id); };
  $('#dCombo').onclick = () => { dlg.close(); style.pinned = it.id; style.mode = 'single'; showView('style'); renderStyle(); };
  $('#dFav').onclick = () => upd((i) => { i.favorite = !i.favorite; });
  $('#dDirty').onclick = () => upd((i) => { i.dirty = !i.dirty; });
  $('#dStore').onclick = () => upd((i) => { i.stored = !i.stored; });
  $('#dEdit').onclick = () => { dlg.close(); openEditor(it); };
  $('#dDel').onclick = async () => {
    if (!confirm(`"${it.name || 'Bu parça'}" silinsin mi? Bu geri alınamaz.`)) return;
    await DB.del('items', it.id);
    items = items.filter((i) => i.id !== it.id);
    dlg.close(); renderAll(); toast('Silindi');
  };
  $('#dClose').onclick = () => dlg.close();
  $('#dOrig') && ($('#dOrig').onclick = () => upd((i) => { i.photo = i.original; i.original = null; i.bgStatus = 'none'; }));
  $('#dBg') && ($('#dBg').onclick = async () => {
    if (!(await ensureBgConsent())) return;
    $('#dBg').disabled = true; $('#dBg').textContent = '🪄 Temizleniyor…';
    try { await processBg(it, true); } catch { /* mesaj gösterildi */ }
    if ($('#detailDialog').open && detailId === it.id) openDetail(it.id);
  });
  $('#dAi').onclick = async () => {
    if (!apiKey()) { toast("Önce Profil'den API anahtarı gir"); return; }
    $('#dAi').disabled = true; $('#dAi').textContent = '🤖 Analiz ediliyor…';
    try { it.userEdited = []; await analyzeItem(it); toast('Bilgiler güncellendi, kontrol et'); }
    catch (e) { toast((e instanceof QuotaError ? (/Günlük/.test(e.message) ? e.message : 'Kota doldu, biraz sonra dene') : e.message), 5000); }
    refreshAfterItemChange(it);
    if ($('#detailDialog').open && detailId === it.id) openDetail(it.id);
  };
  if (!dlg.open) dlg.showModal();
}

async function wearItems(ids, { toastMsg = true } = {}) {
  const now = Date.now();
  const list = ids.map(byId).filter(Boolean);
  for (const it of list) {
    it.wearCount = (it.wearCount || 0) + 1;
    it.lastWorn = now;
    if (settings.dirtyOnWear && DIRTY_CATS.includes(it.category)) it.dirty = true;
    await saveItem(it);
  }
  const byProfile = {};
  for (const it of list) (byProfile[it.profileId] ||= []).push(it.id);
  for (const [pid, itemIds] of Object.entries(byProfile)) {
    const w = { id: uid(), date: dayKey(now), ts: now, profileId: pid, itemIds };
    wear.push(w); await DB.put('wear', w);
  }
  if (toastMsg) toast(list.length > 1 ? 'Kombin bugün giyildi olarak kaydedildi' : 'Bugün giyildi olarak kaydedildi');
  renderAll();
}

/* ================= Düzenleme ================= */
const FIELDS = ['name', 'category', 'color', 'season', 'formality', 'fabric', 'thickness', 'brand', 'size', 'model', 'fit', 'leg', 'note'];
let editing = null, formTouched = false;

function updateFitVisibility() {
  const f = $('#editForm');
  const cat = f.elements.category.value;
  $('#fitLabel').classList.toggle('hidden', !FIT_CATS.includes(cat));
  $('#legLabel').classList.toggle('hidden', cat !== 'Alt');
}

function fillEditor(it) {
  const f = $('#editForm');
  $('#editPhoto').src = photoURL(it);
  for (const k of FIELDS) f.elements[k].value = it[k] || (k === 'fit' || k === 'leg' ? YOK : '');
  updateFitVisibility();
  $('#aiNote').textContent =
    it.aiStatus === 'pending' ? '🤖 Yapay zekâ analiz ediyor. Şimdi düzelttiğin alanlar korunur.' :
    it.aiStatus === 'failed' ? `Analiz başarısız: ${it.aiError}` :
    it.check ? '🤖 Bilgiler yapay zekâ tahmini. Kontrol edip kaydet.' :
    !apiKey() ? 'API anahtarı olmadığı için alanları elle doldur.' : '';
}

function openEditor(it) {
  editing = it; formTouched = false;
  fillEditor(it);
  if (!$('#editDialog').open) $('#editDialog').showModal();
}

$('#editForm').addEventListener('input', () => { formTouched = true; });
$('#editForm').elements.category.addEventListener('change', updateFitVisibility);
$('#editForm').addEventListener('submit', async (ev) => {
  if (ev.submitter?.value !== 'save' || !editing) return;
  const f = $('#editForm');
  const edited = new Set(editing.userEdited || []);
  for (const k of FIELDS) {
    const v = f.elements[k].value.trim();
    if ((editing[k] || '') !== v) edited.add(k);
    editing[k] = v;
  }
  if (!FIT_CATS.includes(editing.category)) editing.fit = YOK;
  if (editing.category !== 'Alt') editing.leg = YOK;
  editing.userEdited = [...edited];
  editing.check = false; // kullanıcı kaydetti = onayladı
  await saveItem(editing);
  refreshAfterItemChange(editing);
  toast('Kaydedildi');
});

/* ================= Ekleme ================= */
async function addFiles(files) {
  const added = [];
  for (const file of files) {
    try {
      const photo = await shrink(file);
      const it = newItem(activeProfile, photo);
      it.createdAt += added.length;
      it.aiStatus = apiKey() ? 'pending' : 'none';
      it.bgStatus = settings.autoBg ? 'pending' : 'none';
      await DB.put('items', it);
      items.push(it); added.push(it);
    } catch (e) {
      toast('Bir fotoğraf eklenemedi: ' + (e.message || e));
    }
  }
  renderAll();
  return added;
}

async function addSingle(file) {
  const [it] = await addFiles([file]);
  if (!it) return;
  showView('closet');
  openEditor(it);
  // Bu parçayı sırayı beklemeden hemen analiz et
  if (apiKey()) {
    it.aiStatus = 'analyzing';
    try {
      await analyzeItem(it);
      if ($('#editDialog').open && editing === it && !formTouched) fillEditor(it);
      else if ($('#editDialog').open && editing === it) $('#aiNote').textContent = '🤖 Analiz bitti. Kaydettiğinde senin yazdıkların korunur.';
    } catch (err) {
      const later = err instanceof QuotaError || err instanceof TempError;
      it.aiStatus = later ? 'pending' : 'failed';
      it.aiError = later ? '' : err.message;
      await saveItem(it);
      if ($('#editDialog').open && editing === it) $('#aiNote').textContent = err instanceof QuotaError ? 'Kota doldu, analiz sıraya alındı.' : later ? 'Google şu an yanıt vermiyor; analiz sıraya alındı, kendiliğinden tekrar denenecek.' : 'Analiz başarısız: ' + err.message;
      runAi();
    }
    refreshAfterItemChange(it);
  }
  runBg();
}

async function addBulk(files) {
  if (files.length > BULK_LIMIT) { toast(`Tek seferde en fazla ${BULK_LIMIT} fotoğraf. İlk ${BULK_LIMIT} tanesi ekleniyor.`, 4000); files = files.slice(0, BULK_LIMIT); }
  toast(`${files.length} fotoğraf ekleniyor…`, 5000);
  const added = await addFiles(files);
  toast(`${added.length} kıyafet eklendi. Analiz ve temizlik arka planda sürecek (uygulama açıkken).`, 4500);
  showView('closet');
  runAi(); runBg();
}

$('#camInput').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) addSingle(f); });
$('#galInput').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) addSingle(f); });
$('#bulkInput').addEventListener('change', (e) => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) addBulk(fs); });
$$('#addDialog [data-pick]').forEach((b) => (b.onclick = () => {
  $('#addDialog').close();
  const k = b.dataset.pick;
  if (k === 'cam') $('#camInput').click();
  else if (k === 'gal') $('#galInput').click();
  else if (k === 'bulk') $('#bulkInput').click();
  else if (k === 'person') $('#personInput').click();
}));

/* ================= Üzerimdekini ekle: bir fotoğraftan birden çok parça ================= */
let split = null;

async function cropBox(blob, box, max = 1000) {
  const img = await loadImage(blob);
  const W = img.width, H = img.height;
  let [y0, x0, y1, x1] = box;
  y0 = (y0 / 1000) * H; y1 = (y1 / 1000) * H; x0 = (x0 / 1000) * W; x1 = (x1 / 1000) * W;
  const px = (x1 - x0) * 0.06, py = (y1 - y0) * 0.06;
  x0 = Math.max(0, x0 - px); x1 = Math.min(W, x1 + px); y0 = Math.max(0, y0 - py); y1 = Math.min(H, y1 + py);
  const w = x1 - x0, h = y1 - y0, side = Math.max(w, h);
  const k = Math.min(1, max / side);
  const c = document.createElement('canvas');
  c.width = c.height = Math.round(side * k);
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(img, x0, y0, w, h, Math.round(((side - w) / 2) * k), Math.round(((side - h) / 2) * k), Math.round(w * k), Math.round(h * k));
  return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.86));
}

function closeSplit() {
  for (const p of split?.parts || []) URL.revokeObjectURL(p.url);
  split = null;
  if ($('#splitDialog').open) $('#splitDialog').close();
}

function renderSplit() {
  const list = $('#splitList');
  list.innerHTML = split.parts.map((p, i) => `<label class="split ${p.on ? 'on' : ''}" data-i="${i}">
    <img src="${p.url}" alt=""><input type="checkbox" ${p.on ? 'checked' : ''}>
    <div class="cap">${esc(p.fields.ad || p.fields.tur || 'Parça')}<small>${esc([p.fields.tur, p.fields.renk].filter(Boolean).join(' · '))}</small></div></label>`).join('');
  list.querySelectorAll('.split').forEach((el) => {
    el.querySelector('input').onchange = (e) => { split.parts[+el.dataset.i].on = e.target.checked; renderSplit(); };
  });
  const n = split.parts.filter((p) => p.on).length;
  $('#splitAdd').disabled = !n;
  $('#splitAdd').textContent = n ? `${n} parçayı ekle` : 'Seçilenleri ekle';
}

async function addFromPerson(file) {
  if (!apiKey()) { toast("Bu özellik yapay zekâ ister. Önce Profil'den API anahtarı gir.", 4500); return; }
  const st = $('#splitStatus');
  $('#splitList').innerHTML = '';
  $('#splitAdd').disabled = true; $('#splitAdd').textContent = 'Seçilenleri ekle';
  st.textContent = '🔎 Yapay zekâ fotoğraftaki parçaları arıyor…';
  $('#splitDialog').showModal();
  split = { parts: [] };
  try {
    const src = await shrink(file, 1800, 0.9);
    const small = await shrink(src, 1024, 0.8);
    const b64 = (await blobToDataURL(small)).split(',')[1];
    const j = await withRetry(() => gemini([{ text: detectPrompt() }, { inline_data: { mime_type: 'image/jpeg', data: b64 } }]), st);
    const found = parseDetections(j);
    if (!split) return; // kullanıcı vazgeçti
    if (!found.length) { st.textContent = 'Fotoğrafta ayrı kıyafet bulamadım. Tek parça eklemek için "Galeriden seç"i kullan.'; return; }
    for (const f of found) {
      const crop = await cropBox(src, f.box);
      split.parts.push({ ...f, crop, url: URL.createObjectURL(crop), on: true });
    }
    st.textContent = `${found.length} parça buldum. Eklemek istemediklerinin işaretini kaldır. Bilgileri sonra düzeltebilirsin.`;
    renderSplit();
  } catch (e) {
    if (split) st.textContent = reason(e).replace(/\.$/, '') + '. Biraz sonra tekrar dene.';
  }
}

$('#personInput').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) addFromPerson(f); });
$('#splitCancel').onclick = closeSplit;
$('#splitAdd').onclick = async () => {
  const chosen = split.parts.filter((p) => p.on);
  for (const [k, p] of chosen.entries()) {
    const it = newItem(activeProfile, p.crop);
    it.createdAt += k;
    applyAnalysis(it, p.fields);
    it.note = 'Üzerimdekinden eklendi';
    it.bgStatus = settings.autoBg ? 'pending' : 'none';
    await DB.put('items', it);
    items.push(it);
  }
  closeSplit();
  toast(`${chosen.length} parça ayrı kayıt olarak eklendi. Bilgileri kontrol et.`, 4000);
  closet.state = 'check'; $('#fState').value = 'check';
  showView('closet');
  runBg();
};
const openAdd = () => $('#addDialog').showModal();

/* ================= Stil AI ================= */
function updateWeatherToggle() {
  $('#weatherUseText').textContent = weather ? `Havayı dikkate al (${weather.max}° / ${weather.min}°, ${describeCode(weather.code).text.toLocaleLowerCase('tr')})` : 'Havayı dikkate al (konum eklenmedi)';
  $('#useWeather').disabled = !weather;
}

function renderStyle() {
  $$('#styleSeg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === style.mode));
  $('#coupleBox').classList.toggle('hidden', style.mode !== 'couple');
  $('#occasionChips').innerHTML = OCCASIONS.map((o) => `<button class="chip" data-o="${esc(o)}" aria-pressed="${o === style.occasion}">${esc(o)}</button>`).join('');
  $$('#occasionChips .chip').forEach((b) => (b.onclick = () => { style.occasion = b.dataset.o; renderStyle(); }));
  if (style.mode === 'couple') {
    const opts = profiles.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    const a = $('#coupleA').value || activeProfile, b = $('#coupleB').value || profiles.find((p) => p.id !== activeProfile)?.id || '';
    $('#coupleA').innerHTML = opts; $('#coupleB').innerHTML = opts;
    $('#coupleA').value = a; $('#coupleB').value = b;
  }
  const pin = style.mode === 'single' && style.pinned ? byId(style.pinned) : null;
  const pb = $('#pinnedBox');
  pb.classList.toggle('hidden', !pin);
  if (pin) {
    pb.innerHTML = `${imgHTML(pin)}<span>Her kombinde: <b>${esc(pin.name || pin.category)}</b></span><button aria-label="Kaldır">✕</button>`;
    pb.querySelector('button').onclick = () => { style.pinned = null; renderStyle(); };
  }
  $('#suggestBtn').textContent = style.mode === 'couple' ? '💑 Çift kombini öner' : '✨ Kombin öner';
  updateWeatherToggle();
  renderResults();
}

function renderResults() {
  const box = $('#outfitResults');
  box.innerHTML = '';
  for (const o of style.results) box.appendChild(outfitCard(o, { saved: false }));
  $('#moreBtn').classList.toggle('hidden', !style.results.length || style.busy);
}

function piecesHTML(ids) {
  return `<div class="pieces">${ids.map(byId).filter(Boolean).map((it) => `<div data-id="${it.id}">${imgHTML(it)}<div>${esc(it.name || it.category)}</div></div>`).join('')}</div>`;
}

function outfitCard(o, { saved, compact = false }) {
  const el = document.createElement('div');
  el.className = 'outfit';
  const couple = o.kind === 'couple' || o.a;
  const body = couple
    ? `<div class="who">${esc(profileName(o.profiles?.[0] || style.coupleA))}</div>${piecesHTML(o.a)}<div class="who">${esc(profileName(o.profiles?.[1] || style.coupleB))}</div>${piecesHTML(o.b)}`
    : piecesHTML(o.ids);
  const allIds = couple ? [...o.a, ...o.b] : o.ids;
  const missing = allIds.filter((id) => !byId(id)).length;
  const who = outfitPeople(o);
  el.innerHTML = `<h3>${esc(o.title)}</h3>
    ${saved ? `<div class="meta">${esc(o.occasion || '')}${o.createdAt ? ' · ' + new Date(o.createdAt).toLocaleDateString('tr-TR') : ''}${missing ? ` · ${missing} parça silinmiş` : ''}</div>` : ''}
    <div class="ofrow"><div class="${couple ? 'avthumbs' : ''}">${who.map((_, k) => `<button class="avthumb" data-k="${k}" aria-label="Avatarda tam ekran göster"><span class="zoom">⤢</span></button>`).join('')}</div>
    <div style="flex:1;min-width:0">${body}</div></div>
    ${!compact && o.why ? `<p class="muted">${esc(o.why)}</p>` : ''}
    <div class="acts">
      ${saved ? '' : '<button class="smallbtn" data-a="save">♥ Kaydet</button>'}
      <button class="smallbtn" data-a="wear">👕 Bugün giydim</button>
      ${saved && !compact ? '<button class="smallbtn danger grow0" data-a="del">🗑️</button>' : ''}
    </div>`;
  el.querySelectorAll('.pieces [data-id]').forEach((d) => (d.onclick = () => openDetail(d.dataset.id)));
  el.querySelectorAll('.avthumb').forEach((b) => {
    const w = who[+b.dataset.k];
    avatarSVG(w.p, w.items, faceURL(w.p)).then((svg) => b.insertAdjacentHTML('afterbegin', svg));
    b.onclick = () => openAvatar(o);
  });
  const act = (a) => el.querySelector(`[data-a="${a}"]`);
  if (act('save')) act('save').onclick = async () => {
    const rec = couple
      ? { id: uid(), kind: 'couple', profiles: [style.coupleA, style.coupleB], profileId: style.coupleA, title: o.title, why: o.why, a: o.a, b: o.b, occasion: style.occasion, createdAt: Date.now() }
      : { id: uid(), kind: 'single', profileId: activeProfile, title: o.title, why: o.why, ids: o.ids, occasion: style.occasion, createdAt: Date.now() };
    outfits.push(rec); await DB.put('outfits', rec);
    act('save').textContent = '♥ Kaydedildi'; act('save').disabled = true;
    toast('Favorilere kaydedildi');
  };
  act('wear').onclick = async () => { await wearItems(allIds.filter((id) => byId(id))); };
  if (act('del')) act('del').onclick = async () => {
    if (!confirm('Bu kombin favorilerden silinsin mi?')) return;
    await DB.del('outfits', o.id);
    outfits = outfits.filter((x) => x.id !== o.id);
    renderFavs(); renderHome();
  };
  return el;
}

function availablePool(profileId) {
  return items.filter((i) => i.profileId === profileId && i.category && !i.dirty && !i.stored);
}

function recentIds(profileId) {
  const since = Date.now() - 3 * DAY;
  return items.filter((i) => i.profileId === profileId && i.lastWorn > since).map((i) => i.id);
}

async function suggest(more = false) {
  if (style.busy) return;
  const status = $('#outfitStatus');
  const occasion = style.occasion;
  const note = $('#occasionNote').value.trim();
  const w = $('#useWeather').checked && weather ? weatherNote(weather) : '';
  const season = $('#useWeather').checked && weather ? seasonFromWeather(weather) : '';
  if (!more) style.avoid = [];
  else style.avoid.push(...style.results.map((o) => (o.a ? [...o.a, ...o.b] : o.ids)));

  style.busy = true;
  $('#suggestBtn').disabled = true; $('#moreBtn').classList.add('hidden');
  try {
    if (style.mode === 'couple') {
      const A = $('#coupleA').value, B = $('#coupleB').value;
      if (!A || !B || A === B) { status.textContent = profiles.length < 2 ? 'Çift kombini için Profil sekmesinden ikinci bir profil ekle.' : 'İki farklı kişi seç.'; return; }
      style.coupleA = A; style.coupleB = B;
      const poolA = availablePool(A), poolB = availablePool(B);
      if (poolA.length < 2 || poolB.length < 2) { status.textContent = 'Her iki profilde de türü belli, temiz en az birkaç parça olmalı.'; return; }
      let res = null;
      if (apiKey()) {
        status.textContent = '💑 Yapay zekâ çift kombini hazırlıyor…';
        try {
          res = await withRetry(() => suggestCouple({ poolA, poolB, nameA: profileName(A), nameB: profileName(B), occasion, harmony: $('#harmony').value, note, weather: w, bodyA: bodyNote(profileById(A)), bodyB: bodyNote(profileById(B)), styleA: styleNote(profileById(A)), styleB: styleNote(profileById(B)) }), status);
          status.textContent = res.length ? '' : 'Yapay zekâ uygun çift kombini bulamadı, yedek motorla öneriyorum.';
        } catch (e) { status.textContent = reason(e) + ' Yedek motorla öneriyorum.'; }
      } else status.textContent = 'API anahtarı yok, yedek motorla öneriyorum.';
      if (!res?.length) {
        const fa = fallbackOutfits(poolA, occasion, season), fb = fallbackOutfits(poolB, occasion, season);
        res = fa.slice(0, Math.min(fa.length, fb.length)).map((o, k) => ({ title: `Çift önerisi ${k + 1}`, a: o.ids, b: fb[k].ids, why: 'Tür, mevsim ve resmiyete göre eşleştirildi (yapay zekâsız öneri).' }));
      }
      style.results = res.map((o) => ({ ...o, kind: 'couple', profiles: [A, B] }));
    } else {
      const pool = availablePool(activeProfile);
      const pinned = style.pinned && byId(style.pinned);
      if (pinned && !pool.includes(pinned)) pool.push(pinned);
      if (pool.length < 2) { status.textContent = 'Kombin için türü belli, temiz en az birkaç parça gerekiyor.'; return; }
      let res = null;
      if (apiKey()) {
        status.textContent = '✨ Yapay zekâ kombin hazırlıyor…';
        try {
          res = await withRetry(() => suggestOutfits({ pool, occasion, note, weather: w, recent: recentIds(activeProfile), avoid: style.avoid, pinned: pinned?.id, body: bodyNote(profileById(activeProfile)), styleInfo: styleNote(profileById(activeProfile)) }), status);
          if (pinned) res = res.filter((o) => o.ids.includes(pinned.id));
          status.textContent = res.length ? '' : 'Yapay zekâ uygun kombin bulamadı, yedek motorla öneriyorum.';
        } catch (e) { status.textContent = reason(e) + ' Yedek motorla öneriyorum.'; }
      } else status.textContent = 'API anahtarı yok, yedek motorla öneriyorum.';
      if (!res?.length) res = fallbackOutfits(pool, occasion, season, pinned?.id);
      style.results = res;
    }
    if (!style.results.length) status.textContent = 'Bu seçimlere uygun kombin bulamadım. Daha fazla kıyafet ekle ya da kirli sepetini boşalt.';
  } finally {
    style.busy = false;
    $('#suggestBtn').disabled = false;
    renderResults();
  }
}

async function withRetry(fn, status) {
  try { return await fn(); }
  catch (e) {
    if (e instanceof TempError) {
      status.textContent = 'Google şu an yanıt vermiyor, 10 sn sonra tekrar deniyorum…';
      await sleep(10000);
      return fn();
    }
    if (e instanceof QuotaError && (e.retryMs || 0) <= 15000) {
      const s = Math.ceil((e.retryMs || 5000) / 1000);
      status.textContent = `Kota doldu, ${s} sn sonra tekrar deniyorum…`;
      await sleep(s * 1000);
      return fn();
    }
    throw e;
  }
}
const reason = (e) => (e instanceof QuotaError ? (/Günlük/.test(e.message) ? e.message : 'Yapay zekâ kotası doldu.') : e instanceof TempError ? 'Google şu an yanıt vermiyor.' : `Yapay zekâ yanıt vermedi (${e.message}).`);

$('#suggestBtn').onclick = () => suggest(false);
$('#moreBtn').onclick = () => suggest(true);
$$('#styleSeg button').forEach((b) => (b.onclick = () => { style.mode = b.dataset.mode; style.results = []; renderStyle(); $('#outfitStatus').textContent = ''; }));

async function dailyOutfit() {
  style.mode = 'single'; style.occasion = 'Günlük'; style.pinned = null;
  $('#occasionNote').value = '';
  if (weather) $('#useWeather').checked = true;
  showView('style');
  renderStyle();
  await suggest(false);
}

/* ================= Favoriler ================= */
let favMode = 'outfits';
function renderFavs() {
  $$('#favSeg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === favMode));
  const fo = $('#favOutfits'), fi = $('#favItems'), empty = $('#favEmpty');
  fo.classList.toggle('hidden', favMode !== 'outfits');
  fi.classList.toggle('hidden', favMode !== 'items');
  if (favMode === 'outfits') {
    const list = outfits.filter((o) => o.profileId === activeProfile || o.profiles?.includes(activeProfile)).sort((a, b) => b.createdAt - a.createdAt);
    fo.innerHTML = '';
    for (const o of list) fo.appendChild(outfitCard(o, { saved: true }));
    empty.textContent = 'Kaydedilmiş kombin yok. Stil AI\'da beğendiğin kombine ♥ Kaydet de.';
    empty.classList.toggle('hidden', list.length > 0);
  } else {
    const list = mine().filter((i) => i.favorite);
    fi.innerHTML = list.map((i) => tile(i)).join('');
    bindTiles(fi);
    empty.textContent = 'Favori kıyafet yok. Bir parçanın detayından ☆ Favori de.';
    empty.classList.toggle('hidden', list.length > 0);
  }
}
$$('#favSeg button').forEach((b) => (b.onclick = () => { favMode = b.dataset.mode; renderFavs(); }));

/* ================= Profil ================= */
async function renderProfile() {
  const list = $('#profileList');
  list.innerHTML = '';
  for (const p of profiles) {
    const n = items.filter((i) => i.profileId === p.id).length;
    const row = document.createElement('div');
    row.className = 'profileRow';
    const info = [p.height && `${p.height} cm`, p.bodyType && bodyTypeName(p.bodyType)].filter(Boolean).join(' · ');
    row.innerHTML = `<span class="pname">${p.id === activeProfile ? '● ' : ''}${esc(p.name)} <small class="muted">${n} parça${info ? ' · ' + esc(info) : ''}</small></span>
      <button class="smallbtn grow0" data-a="ren">${hasAvatar(p) && hasStyle(p) ? 'Düzenle' : 'Tamamla'}</button>${profiles.length > 1 ? '<button class="smallbtn grow0 danger" data-a="del">Sil</button>' : ''}`;
    row.querySelector('[data-a=ren]').onclick = () => openProfileEditor(p);
    const d = row.querySelector('[data-a=del]');
    if (d) d.onclick = async () => {
      if (!confirm(`"${p.name}" profili ve içindeki ${n} parça silinsin mi? Önce yedek almanı öneririm.`)) return;
      for (const it of items.filter((i) => i.profileId === p.id)) await DB.del('items', it.id);
      items = items.filter((i) => i.profileId !== p.id);
      profiles = profiles.filter((x) => x.id !== p.id);
      await DB.setMeta('profiles', profiles);
      if (activeProfile === p.id) await switchProfile(profiles[0].id); else renderAll();
    };
    list.appendChild(row);
  }
  $('#optDirty').checked = settings.dirtyOnWear;
  $('#optBg').checked = settings.autoBg;
  $('#optBody').checked = settings.sendBody;
  const place = await getPlace();
  $('#placeInfo').textContent = place ? `Şu an: ${place.name}. Konum yalnızca bu telefonda kalır, yapay zekâya gönderilmez.` : 'Henüz konum yok.';
  $('#apiKey').value = apiKey();
  $('#apiModel').value = apiModel();
  $('#keyWarn').textContent = keyLooksWrong(apiKey());
  showStorage();
}

$('#addProfile').onclick = () => {
  openProfileEditor(null, $('#newProfile').value.trim());
  $('#newProfile').value = '';
};
$('#optBody').onchange = async (e) => { settings.sendBody = e.target.checked; await saveSettings(); };

/* ================= Profil düzenleyici (avatar) ================= */
let pd = null;

function openProfileEditor(p, name = '', { welcome = false } = {}) {
  pd = {
    welcome, styles: [...(p?.styles || [])],
    id: p?.id || 'p' + uid(), isNew: !p, sex: p?.sex || 'kadin', bodyType: p?.bodyType || 'dikdortgen',
    photo: p?.photo || null, crop: { zoom: 1, ox: 0, oy: 0, ...(p?.crop || {}) }, skin: p?.skin || '', url: '', geom: null
  };
  const f = $('#profileForm');
  f.elements.name.value = p?.name || name;
  f.elements.height.value = p?.height || '';
  f.elements.weight.value = p?.weight || '';
  f.elements.styleText.value = p?.styleText || '';
  f.elements.colors.value = p?.colors || '';
  f.elements.avoid.value = p?.avoid || '';
  $('#pdTitle').textContent = welcome ? 'Hoş geldin! Profilini oluştur' : p ? 'Profili düzenle' : 'Yeni profil';
  $('#pdIntro').classList.toggle('hidden', !welcome);
  $('#pdCancel').textContent = welcome ? 'Sonra tamamla' : 'Vazgeç';
  renderPdStyles();
  $('#profileDialog').returnValue = '';
  $('#cropZoom').value = pd.crop.zoom;
  setCropPhoto(pd.photo);
  renderPdSex();
  updatePd();
  $('#profileDialog').showModal();
}

function setCropPhoto(blob) {
  const img = $('#cropImg');
  if (pd.url) URL.revokeObjectURL(pd.url);
  pd.url = ''; pd.geom = null;
  $('#cropEmpty').classList.toggle('hidden', !!blob);
  if (!blob) { img.removeAttribute('src'); img.style.display = 'none'; return; }
  img.style.display = '';
  pd.url = URL.createObjectURL(blob);
  img.onload = () => { layoutCrop(); updatePd(); };
  img.src = pd.url;
}

function layoutCrop() {
  const img = $('#cropImg');
  if (!pd?.photo || !img.naturalWidth) return;
  const B = $('#cropBox').clientWidth || 200;
  const iw = img.naturalWidth, ih = img.naturalHeight;
  const sc = Math.max(B / iw, B / ih) * pd.crop.zoom;
  const w = iw * sc, h = ih * sc;
  let left = (B - w) / 2 + pd.crop.ox * B, top = (B - h) / 2 + pd.crop.oy * B;
  left = Math.min(0, Math.max(B - w, left)); top = Math.min(0, Math.max(B - h, top));
  pd.crop.ox = (left - (B - w) / 2) / B; pd.crop.oy = (top - (B - h) / 2) / B;
  Object.assign(img.style, { width: w + 'px', height: h + 'px', left: left + 'px', top: top + 'px' });
  pd.geom = { B, sc, left, top };
}

function cropCanvas(size = 256) {
  if (!pd?.geom) return null;
  const { B, sc, left, top } = pd.geom;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  c.getContext('2d').drawImage($('#cropImg'), -left / sc, -top / sc, B / sc, B / sc, 0, 0, size, size);
  return c;
}

let pdT = 0;
function updatePd() {
  clearTimeout(pdT);
  pdT = setTimeout(async () => {
    if (!pd) return;
    const f = $('#profileForm');
    const tmp = { sex: pd.sex, height: +f.elements.height.value || 0, weight: +f.elements.weight.value || 0, bodyType: pd.bodyType, skin: pd.skin };
    const v = bmi(tmp);
    $('#pdBmi').textContent = v ? `Vücut kitle endeksi: ${v.toFixed(1)} (${bmiLabel(v)})` : 'Boy ve kilo girince vücut kitle endeksi hesaplanır.';
    const c = cropCanvas(128);
    $('#pdAvatar').innerHTML = await avatarSVG(tmp, [], c ? c.toDataURL('image/jpeg', 0.8) : '');
    const btns = await Promise.all(BODY_TYPES.map(async ([k, label, desc]) =>
      `<button type="button" data-k="${k}" class="${pd.bodyType === k ? 'on' : ''}" title="${esc(desc)}"><div class="bt">${await avatarSVG({ ...tmp, bodyType: k }, [])}</div>${esc(label)}</button>`));
    $('#pdBody').innerHTML = btns.join('');
    $$('#pdBody button').forEach((b) => (b.onclick = () => { pd.bodyType = b.dataset.k; updatePd(); toast(BODY_TYPES.find((x) => x[0] === b.dataset.k)[2], 2000); }));
  }, 120);
}

function renderPdStyles() {
  $('#pdStyles').innerHTML = STYLE_TAGS.map((t) => `<button type="button" class="chip" aria-pressed="${pd.styles.includes(t)}">${esc(t)}</button>`).join('');
  $$('#pdStyles .chip').forEach((b) => (b.onclick = () => {
    const t = b.textContent;
    pd.styles = pd.styles.includes(t) ? pd.styles.filter((x) => x !== t) : [...pd.styles, t];
    renderPdStyles();
  }));
}

function renderPdSex() {
  $$('#pdSex button').forEach((b) => b.classList.toggle('on', b.dataset.v === pd.sex));
}
$$('#pdSex button').forEach((b) => (b.onclick = () => { pd.sex = b.dataset.v; renderPdSex(); updatePd(); }));
$('#profileForm').elements.height.addEventListener('input', updatePd);
$('#profileForm').elements.weight.addEventListener('input', updatePd);
$('#cropZoom').addEventListener('input', (e) => { if (!pd) return; pd.crop.zoom = +e.target.value; layoutCrop(); updatePd(); });
$('#faceInput').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f || !pd) return;
  pd.photo = await shrink(f, 1400, 0.9);
  pd.crop = { zoom: 1, ox: 0, oy: 0 }; pd.skin = '';
  $('#cropZoom').value = 1;
  setCropPhoto(pd.photo);
});
(() => {
  const box = $('#cropBox');
  let drag = null;
  box.addEventListener('pointerdown', (e) => { if (!pd?.geom) return; drag = { x: e.clientX, y: e.clientY, ox: pd.crop.ox, oy: pd.crop.oy }; box.setPointerCapture(e.pointerId); });
  box.addEventListener('pointermove', (e) => {
    if (!drag || !pd?.geom) return;
    pd.crop.ox = drag.ox + (e.clientX - drag.x) / pd.geom.B;
    pd.crop.oy = drag.oy + (e.clientY - drag.y) / pd.geom.B;
    layoutCrop();
  });
  const end = () => { if (drag) { drag = null; updatePd(); } };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
})();

function closePd() {
  if (pd?.url) URL.revokeObjectURL(pd.url);
  pd = null;
}
$('#profileDialog').addEventListener('close', async () => {
  if (pd?.welcome && $('#profileDialog').returnValue !== 'save') {
    await DB.setMeta('onboarded', true);
    toast('İstediğin zaman Ana Sayfa\'daki karttan ya da Profil sekmesinden tamamlayabilirsin.', 4000);
  }
  closePd();
});
$('#profileForm').addEventListener('submit', async (ev) => {
  if (ev.submitter?.value !== 'save' || !pd) return;
  const f = $('#profileForm');
  const cur = pd;
  let face = null, skin = cur.skin;
  const c = cropCanvas(256);
  if (cur.photo && c) {
    face = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.9));
    skin = (await skinFromFace(face)) || skin;
  }
  const h = +f.elements.height.value || null, w = +f.elements.weight.value || null;
  const existing = profileById(cur.id);
  const rec = Object.assign(existing || { id: cur.id }, {
    name: f.elements.name.value.trim() || 'Profil', sex: cur.sex, bodyType: cur.bodyType,
    height: h && h >= 100 && h <= 230 ? h : null, weight: w && w >= 25 && w <= 300 ? w : null,
    photo: cur.photo, crop: cur.crop, face, skin,
    styles: cur.styles, styleText: f.elements.styleText.value.trim(), colors: f.elements.colors.value.trim(), avoid: f.elements.avoid.value.trim()
  });
  if (!existing) profiles.push(rec);
  await DB.setMeta('profiles', profiles);
  await DB.setMeta('onboarded', true);
  if (cur.welcome) toast(hasAvatar(rec) && hasStyle(rec) ? 'Profilin hazır 🎉' : 'Kaydedildi. Eksikleri Ana Sayfa\'daki karttan tamamlayabilirsin.', 3500);
  else if (cur.isNew) toast(`"${rec.name}" eklendi. Üstteki seçiciden geçebilirsin.`); else toast('Profil kaydedildi');
  renderAll();
});

/* ================= Tam ekran avatar ve gerçekçi önizleme ================= */
function outfitPeople(o) {
  const couple = o.kind === 'couple' || o.a;
  if (couple) {
    const A = o.profiles?.[0] || style.coupleA, B = o.profiles?.[1] || style.coupleB;
    return [{ p: profileById(A) || {}, items: o.a.map(byId).filter(Boolean) }, { p: profileById(B) || {}, items: o.b.map(byId).filter(Boolean) }];
  }
  return [{ p: profileById(o.profileId || activeProfile) || {}, items: o.ids.map(byId).filter(Boolean) }];
}

let avCurrent = null;
async function openAvatar(o) {
  avCurrent = o;
  const who = outfitPeople(o);
  $('#avTitle').textContent = o.title || 'Kombin';
  const stage = $('#avStage');
  stage.innerHTML = '';
  for (const w of who) {
    const d = document.createElement('div');
    d.innerHTML = await avatarSVG(w.p, w.items, faceURL(w.p));
    stage.appendChild(d);
  }
  const noAv = who.filter((w) => !hasAvatar(w.p)).map((w) => w.p.name).filter(Boolean);
  $('#avNote').textContent = noAv.length
    ? `${noAv.join(', ')} için avatar bilgisi yok; Profil'den eklersen silüet ona benzer.`
    : 'Kıyafet fotoğrafları kesilip silüete yerleştirildi (kâğıt bebek görünümü).';
  $('#avReal').disabled = false;
  $('#avReal').textContent = '✨ Gerçekçi önizleme (ücretli)';
  $('#avatarDialog').showModal();
}
$('#avClose').onclick = () => $('#avatarDialog').close();

$('#avReal').onclick = async () => {
  const o = avCurrent;
  if (!o) return;
  if (!apiKey()) { toast("Önce Profil'den API anahtarı gir"); return; }
  const who = outfitPeople(o);
  const noPhoto = who.filter((w) => !w.p.photo).map((w) => w.p.name || 'Profil');
  if (noPhoto.length) { toast(`Gerçekçi önizleme için ${noPhoto.join(' ve ')} profiline fotoğraf ekle.`, 4500); return; }
  if (!confirm('Gerçekçi önizleme için profil fotoğrafın, boyun, genel vücut yapın (kilonun kendisi değil) ve kombindeki kıyafet fotoğrafları Google Gemini\'ye gönderilecek.\n\nBu özellik ücretli: Google AI Studio\'da faturalandırma açık olmalı, görüntü başına yaklaşık 4-7 sent tutar.\n\nDevam edilsin mi?')) return;
  const btn = $('#avReal');
  btn.disabled = true; btn.textContent = '⏳ Oluşturuluyor (20-60 sn)…';
  $('#avNote').textContent = 'Yapay zekâ görseli hazırlıyor, uygulamayı kapatma.';
  try {
    const b64 = async (blob, max) => (await blobToDataURL(await shrink(blob, max, 0.85))).split(',')[1];
    const persons = [];
    for (const w of who) {
      const desc = [w.p.sex === 'erkek' ? 'erkek' : 'kadın', w.p.height && `yaklaşık ${w.p.height} cm boyunda`, buildWord(w.p), w.p.bodyType && `vücut tipi ${bodyTypeName(w.p.bodyType).toLocaleLowerCase('tr')}`].filter(Boolean).join(', ');
      const its = [];
      for (const it of w.items) its.push({ label: `${it.category}: ${it.name || ''} ${it.color || ''}`.trim(), data: await b64(it.photo, 768) });
      persons.push({ desc, face: await b64(w.p.photo, 1024), items: its });
    }
    const img = await tryOnImage(persons);
    const url = URL.createObjectURL(img);
    $('#avStage').innerHTML = `<img class="real" src="${url}" alt="Gerçekçi önizleme">`;
    $('#avNote').textContent = 'Yapay zekâ ile üretildi; yüz ve kıyafet ayrıntıları birebir olmayabilir. Kaydetmek için görsele basılı tut.';
    btn.textContent = '🔁 Yeniden oluştur (ücretli)';
  } catch (e) {
    $('#avNote').textContent = '❌ ' + (e.message || e);
    btn.textContent = '✨ Gerçekçi önizleme (ücretli)';
  } finally {
    btn.disabled = false;
  }
};
$('#optDirty').onchange = async (e) => { settings.dirtyOnWear = e.target.checked; await saveSettings(); };
$('#redoBg').onclick = async () => {
  const list = mine().filter((i) => i.photo && i.bgStatus !== 'pending');
  if (!list.length) return;
  if (!confirm(`${list.length} fotoğrafın arka planı yeni yöntemle yeniden temizlensin mi? Mankenli ve üzerindeyken çekilmiş fotoğraflarda insan da silinir. Orijinaller korunur.`)) return;
  for (const it of list) { it.bgStatus = 'pending'; await DB.put('items', it); }
  if (!settings.autoBg) { settings.autoBg = true; $('#optBg').checked = true; await saveSettings(); }
  await DB.setMeta('bgCrashes', 0);
  toast('Sıraya alındı, uygulama açıkken arka planda ilerleyecek.', 4000);
  runBg();
};
$('#optBg').onchange = async (e) => {
  settings.autoBg = e.target.checked;
  if (settings.autoBg) {
    await DB.setMeta('bgCrashes', 0);
    // Daha önce kuyruğa girmemiş parçaları da temizle
    for (const it of items) if (it.bgStatus === 'none' && !it.original) { it.bgStatus = 'pending'; await DB.put('items', it); }
    runBg();
  }
  await saveSettings(); updateQueueInfo();
};
$('#gpsBtn').onclick = async () => {
  try { await setPlaceFromGPS(); toast('Konum kaydedildi'); await renderWeather(true); renderProfile(); }
  catch (e) { toast(e.message, 4000); }
};
$('#cityBtn').onclick = async () => {
  const c = $('#cityInput').value.trim();
  if (!c) return;
  try { const p = await setPlaceFromCity(c); $('#cityInput').value = ''; toast(`${p.name} kaydedildi`); await renderWeather(true); renderProfile(); }
  catch (e) { toast(e.message, 4000); }
};
$('#apiKey').addEventListener('input', (e) => { $('#keyWarn').textContent = keyLooksWrong(e.target.value.trim()); });
$('#saveKey').onclick = async () => {
  lsSet('stilora.key', $('#apiKey').value.trim());
  lsSet('stilora.model', $('#apiModel').value.trim() || DEFAULT_MODEL);
  $('#keyStatus').textContent = apiKey() ? 'Kaydedildi.' : 'Anahtar silindi.';
  if (apiKey()) {
    for (const i of items) if (i.aiStatus === 'none' || i.aiStatus === 'failed') { i.aiStatus = 'pending'; i.aiError = ''; await DB.put('items', i); }
    renderAll(); runAi();
  }
};
$('#testKey').onclick = async () => {
  await $('#saveKey').onclick();
  const st = $('#keyStatus');
  if (!apiKey()) { st.textContent = 'Önce anahtarı yaz.'; return; }
  st.textContent = 'Deneniyor…';
  try {
    const j = await gemini([{ text: 'Sadece {"ok":true} döndür.' }]);
    st.textContent = j.ok ? '✅ Bağlantı çalışıyor.' : 'Yanıt geldi ama beklenen biçimde değil.';
  } catch (e) {
    st.textContent = '❌ ' + (e instanceof QuotaError ? 'Anahtar çalışıyor ama kota şu an dolu.' : e.message);
  }
};

async function showStorage() {
  const el = $('#storageInfo');
  try {
    let persisted = await navigator.storage?.persisted?.();
    if (!persisted && navigator.storage?.persist) persisted = await navigator.storage.persist();
    const est = await navigator.storage?.estimate?.();
    const mb = est ? (est.usage / 1048576).toFixed(1) : '?';
    const last = await DB.getMeta('lastBackup');
    el.textContent = `${items.length} parça · ${outfits.length} kombin · ${mb} MB · ` + (persisted ? 'kalıcı depolama açık' : 'kalıcı depolama onaylanmadı') +
      ` · son yedek: ${last ? new Date(last).toLocaleDateString('tr-TR') : 'hiç alınmadı'}`;
  } catch { el.textContent = `${items.length} parça`; }
}

/* ================= Yedekleme / aktarma ================= */
async function shareOrDownload(file, st, doneMsg) {
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: file.name });
      st.textContent = doneMsg + ' "Dosyalara Kaydet" ile iCloud Drive\'a kaydetmeyi unutma.';
      return true;
    }
  } catch (e) {
    if (e.name === 'AbortError') { st.textContent = 'İptal edildi.'; return false; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = file.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 20000);
  st.textContent = doneMsg;
  return true;
}

$('#exportBtn').onclick = async () => {
  const st = $('#backupStatus');
  st.textContent = 'Yedek hazırlanıyor…';
  const out = [];
  for (const it of items) {
    const { photo, original, ...rest } = it;
    out.push({ ...rest, photo: photo ? await blobToDataURL(photo) : null, original: original ? await blobToDataURL(original) : null });
  }
  const profOut = [];
  for (const p of profiles) profOut.push({ ...p, photo: p.photo ? await blobToDataURL(p.photo) : null, face: p.face ? await blobToDataURL(p.face) : null });
  const json = JSON.stringify({ app: 'stilora-web', format: 2, version: VERSION, exportedAt: new Date().toISOString(), profiles: profOut, settings, items: out, outfits, wear });
  const file = new File([json], `stilora-yedek-${dayKey()}.json`, { type: 'application/json' });
  if (await shareOrDownload(file, st, `Yedek hazır (${items.length} parça, ${outfits.length} kombin).`)) await DB.setMeta('lastBackup', Date.now());
};

$('#exportZipBtn').onclick = async () => {
  const st = $('#backupStatus');
  st.textContent = 'Android dosyası hazırlanıyor…';
  const list = mine();
  const entries = [], arr = [];
  for (const it of list) {
    let foto = '';
    if (it.photo) {
      foto = `fotolar/${it.id}.jpg`;
      entries.push({ name: foto, data: new Uint8Array(await it.photo.arrayBuffer()) });
    }
    arr.push(toAndroid(it, foto));
  }
  const root = { uygulama: 'Stilora', surum: 1, profilAdi: profileName(activeProfile), kiyafetler: arr };
  entries.push({ name: 'kiyafetler.json', data: new TextEncoder().encode(JSON.stringify(root)) });
  const file = new File([writeZip(entries)], `stilora_${profileName(activeProfile).replace(/[^\p{L}\p{N}_-]+/gu, '_')}.zip`, { type: 'application/zip' });
  await shareOrDownload(file, st, `${list.length} parça hazır. Android'de Profil → içe aktar ile aç.`);
};

$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  const st = $('#backupStatus');
  try {
    const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
    if (head[0] === 0x50 && head[1] === 0x4b) await importAndroidZip(file, st);
    else await importWebBackup(JSON.parse(await file.text()), st);
    renderAll(); runAi(); runBg();
  } catch (err) {
    st.textContent = 'Yükleme başarısız: ' + (err.message || err);
  }
});

async function importAndroidZip(file, st) {
  st.textContent = 'Android dosyası açılıyor…';
  const zip = await readZip(file);
  const txt = await zip.text('kiyafetler.json');
  if (!txt) throw new Error('Bu dosya bir Stilora yedeği değil (kiyafetler.json yok)');
  const root = JSON.parse(txt);
  const arr = Array.isArray(root) ? root : root.kiyafetler;
  if (!Array.isArray(arr)) throw new Error('Kıyafet listesi bulunamadı');
  if (!confirm(`${root.profilAdi ? `"${root.profilAdi}" yedeğindeki ` : ''}${arr.length} parça "${profileName(activeProfile)}" profiline eklensin mi? Aynı parçalar güncellenir.`)) { st.textContent = 'İptal edildi.'; return; }
  let n = 0;
  for (const o of arr) {
    const path = o.foto && zip.names.includes(o.foto) ? o.foto : null;
    const photo = path ? await zip.get(path, path.endsWith('.png') ? 'image/png' : 'image/jpeg') : null;
    const it = fromAndroid(o, activeProfile, photo);
    const old = byId(it.id);
    if (old) { it.createdAt = old.createdAt; it.wearCount = Math.max(it.wearCount, old.wearCount || 0); items = items.filter((x) => x !== old); }
    await DB.put('items', it); items.push(it); n++;
    if (n % 10 === 0) st.textContent = `${n} / ${arr.length} parça aktarıldı…`;
  }
  st.textContent = `${n} parça Android'den aktarıldı.`;
}

async function importWebBackup(data, st) {
  if (data.app !== 'stilora-web' || !Array.isArray(data.items)) throw new Error('Bu dosya bir Stilora yedeği değil');
  if (!confirm(`${data.items.length} parça${data.outfits ? ` ve ${data.outfits.length} kombin` : ''} geri yüklensin mi? Aynı kayıtlar güncellenir, diğerleri korunur.`)) { st.textContent = 'İptal edildi.'; return; }
  st.textContent = 'Geri yükleniyor…';
  for (const raw of data.profiles || []) {
    const p = { ...raw, photo: typeof raw.photo === 'string' ? await dataURLToBlob(raw.photo) : null, face: typeof raw.face === 'string' ? await dataURLToBlob(raw.face) : null };
    const i = profiles.findIndex((x) => x.id === p.id);
    if (i < 0) profiles.push(p);
    else if (!hasAvatar(profiles[i]) && hasAvatar(p)) profiles[i] = { ...p, name: profiles[i].name };
  }
  await DB.setMeta('profiles', profiles);
  let n = 0;
  for (const raw of data.items) {
    const it = { ...raw, photo: raw.photo ? await dataURLToBlob(raw.photo) : null, original: raw.original ? await dataURLToBlob(raw.original) : null };
    if (!it.id) it.id = uid();
    if (!profiles.some((p) => p.id === it.profileId)) it.profileId = activeProfile;
    migrate(it);
    if (it.aiStatus === 'analyzing') it.aiStatus = 'pending';
    await DB.put('items', it); n++;
  }
  for (const o of data.outfits || []) await DB.put('outfits', o);
  for (const w of data.wear || []) await DB.put('wear', w);
  items = await DB.all('items'); outfits = await DB.all('outfits'); wear = await DB.all('wear');
  st.textContent = `${n} parça geri yüklendi.`;
}

/* ================= Gezinme ================= */
const TITLES = { home: 'Stilora', closet: 'Dolabım', style: 'Stil AI', favs: 'Favoriler', profile: 'Profil' };
let currentView = 'home';
function showView(v) {
  currentView = v;
  $$('.view').forEach((s) => s.classList.toggle('active', s.id === 'view-' + v));
  $$('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  $('#title').textContent = TITLES[v];
  renderView(v);
  window.scrollTo(0, 0);
}
function renderView(v) {
  if (v === 'home') renderHome();
  else if (v === 'closet') renderCloset();
  else if (v === 'style') renderStyle();
  else if (v === 'favs') renderFavs();
  else if (v === 'profile') renderProfile();
}
function renderAll() {
  renderProfileSelect();
  renderView(currentView);
}
// Bir parça değişince yalnız görünen ekranı yenile (arka plan kuyruğu sık çağırır)
let refreshT = 0;
function refreshAfterItemChange() {
  clearTimeout(refreshT);
  refreshT = setTimeout(() => {
    if (currentView === 'style') { renderResults(); return; } // kullanıcının yazdığı notu bozma
    if (currentView !== 'profile') renderView(currentView);
  }, 250);
}

$$('.tabbar button').forEach((b) => (b.onclick = () => showView(b.dataset.view)));
$$('.quick button').forEach((b) => (b.onclick = () => {
  const a = b.dataset.act;
  if (a === 'add') openAdd();
  else if (a === 'bulk') $('#bulkInput').click();
  else if (a === 'outfit') { style.mode = 'single'; showView('style'); }
  else if (a === 'daily') dailyOutfit();
}));
$('#fab').onclick = openAdd;
$('#profileSelect').onchange = (e) => switchProfile(e.target.value);
$('#search').addEventListener('input', (e) => { closet.q = e.target.value; renderCloset(); });
$('#layoutBtn').onclick = async () => { closet.layout = closet.layout === 'grid' ? 'list' : 'grid'; await DB.setMeta('layout', closet.layout); renderCloset(); };
for (const [id, key] of [['#fSeason', 'season'], ['#fFormality', 'formality'], ['#fState', 'state'], ['#fSort', 'sort']]) {
  $(id).onchange = (e) => { closet[key] = e.target.value; renderCloset(); };
}

/* ================= Başlat ================= */
(async function init() {
  $('#version').textContent = VERSION;
  const f = $('#editForm');
  fillSelect(f.elements.category, CATEGORIES, 'Seç');
  fillSelect(f.elements.season, SEASONS, 'Seç');
  fillSelect(f.elements.formality, FORMALITY, 'Seç');
  fillSelect(f.elements.thickness, THICKNESS, 'Seç');
  fillSelect(f.elements.fit, FITS);
  fillSelect(f.elements.leg, LEGS);
  fillSelect($('#fSeason'), SEASONS, 'Tüm mevsimler');
  fillSelect($('#fFormality'), FORMALITY, 'Tüm resmiyetler');
  fillSelect($('#fState'), [['clean', 'Temiz, dolapta'], ['dirty', '🧺 Kirli'], ['stored', '📦 Depoda'], ['fav', '★ Favori'], ['never', 'Hiç giyilmeyen'], ['check', '🤖 Kontrol bekleyen']], 'Tüm durumlar');
  fillSelect($('#fSort'), [['new', 'Yeni eklenen'], ['most', 'En çok giyilen'], ['least', 'En az giyilen'], ['worn', 'Son giyilen'], ['name', 'Ada göre']]);
  fillSelect($('#harmony'), HARMONY);
  try {
    await DB.openDB();
    await loadState();
    closet.layout = (await DB.getMeta('layout')) || 'grid';
    renderAll();
    renderWeather();
    // İlk açılış: profil oluşturma
    const me = profileById(activeProfile);
    if (!(await DB.getMeta('onboarded')) && !(hasAvatar(me) && hasStyle(me))) setTimeout(() => openProfileEditor(me, '', { welcome: true }), 400);
    runAi();
    setTimeout(runBg, 1500);
  } catch (e) {
    toast('Veritabanı açılamadı: ' + (e.message || e), 8000);
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
