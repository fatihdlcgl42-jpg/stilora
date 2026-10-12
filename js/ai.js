// Gemini bağlantısı: kota hatasında yavaşlar, başka hatalarda anlaşılır mesaj verir
import { CATEGORIES, SEASONS, FORMALITY, THICKNESS, FITS, LEGS, FIT_CATS, YOK, pick } from './model.js';

// Flash-Lite: ücretsiz katmanda günde ~500 istek (Flash'ta ~20). Kotalar model başına ayrı tutulur,
// bu yüzden biri dolunca sıradaki modele geçilir.
export const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const BACKUP_MODELS = ['gemini-3.1-flash-lite', 'gemini-3.8-flash'];
const RETIRED_MODELS = ['gemini-2.5-flash'];

function lsGet(k, d = '') { try { return localStorage.getItem(k) ?? d; } catch { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* yoksay */ } }
export { lsGet, lsSet };

if (RETIRED_MODELS.includes(lsGet('stilora.model'))) lsSet('stilora.model', DEFAULT_MODEL);
// 0.5.0: daha önce kaydedilen gemini-3.8-flash'ı (günde ~20 istek) Flash-Lite'a çevir
if (!lsGet('stilora.modelMigrated')) {
  if (lsGet('stilora.model') === 'gemini-3.8-flash') lsSet('stilora.model', DEFAULT_MODEL);
  lsSet('stilora.modelMigrated', '1');
}

export const apiKey = () => lsGet('stilora.key');
export const apiModel = () => lsGet('stilora.model') || DEFAULT_MODEL;
export function keyLooksWrong(k) {
  if (!k) return '';
  if (/\s/.test(k)) return 'Anahtarda boşluk var; kopyalarken fazladan karakter gelmiş olabilir.';
  if (!/^AIza[0-9A-Za-z_-]{30,}$/.test(k)) return 'Anahtar genelde "AIza" ile başlar ve 39 karakterdir. Doğru kopyaladığından emin ol.';
  return '';
}

export class QuotaError extends Error {
  constructor(msg, retryMs) { super(msg); this.retryMs = retryMs || 0; }
}

let lowThinking = lsGet('stilora.lowThinking') !== 'off';

function retryDelayMs(data) {
  const d = (data?.error?.details || []).find((x) => x.retryDelay);
  const m = d && /([\d.]+)s/.exec(d.retryDelay);
  return m ? Math.ceil(parseFloat(m[1]) * 1000) : 0;
}

export class TempError extends Error {}

function friendly(status, msg) {
  if (status === 400 && /API key|API_KEY/i.test(msg)) return 'API anahtarı geçersiz. Profil → Ayarlar\'dan kontrol et.';
  if (status === 403) return 'Bu anahtarın Gemini\'ye erişim izni yok (403).';
  if (status === 404) return `Model bulunamadı: ${apiModel()}. Ayarlardan model adını kontrol et.`;
  if (status >= 500) return `Google sunucusu şu an yanıt vermiyor (${status}). Uygulama kendisi tekrar deneyecek.`;
  return msg || `Hata ${status}`;
}

function parseJSON(text) {
  const clean = String(text || '').replace(/^\s*```(json)?/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(clean); }
  catch {
    const m = clean.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch { /* aşağıda hata */ } }
    throw new Error('Yapay zekâ yanıtı okunamadı, tekrar dene.');
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = 'https://generativelanguage.googleapis.com/v1beta';

// 1. yol: generateContent
async function viaGenerate(parts, key, model) {
  const url = `${BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  const send = (fast) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: {
        responseMimeType: 'application/json', temperature: 0.6,
        ...(fast ? { thinkingConfig: { thinkingLevel: 'low' } } : {})
      }
    })
  });
  let r = await send(lowThinking);
  let data = await r.json().catch(() => ({}));
  if (r.status === 400 && lowThinking && /thinking/i.test(data?.error?.message || '')) {
    lowThinking = false; lsSet('stilora.lowThinking', 'off');
    r = await send(false);
    data = await r.json().catch(() => ({}));
  }
  return { status: r.status, ok: r.ok, data, text: () => (data.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('') };
}

// 2. yol: Interactions API (Android sürümünün kullandığı yol)
async function viaInteractions(parts, key, model) {
  const input = parts.map((p) => (p.inline_data
    ? { type: 'image', data: p.inline_data.data, mime_type: p.inline_data.mime_type }
    : { type: 'text', text: p.text }));
  const r = await fetch(`${BASE}/interactions?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input, generation_config: { thinking_level: 'low' } })
  });
  const data = await r.json().catch(() => ({}));
  const text = () => {
    const steps = data.steps || [];
    const stepText = (st) => (typeof st.content === 'string' ? st.content : (st.content || []).map((c) => c.text || '').join(''));
    let t = steps.filter((st) => st.type === 'model_output').map(stepText).join('');
    if (!t) t = steps.filter((st) => st.type !== 'user_input' && st.type !== 'thought').map(stepText).join('');
    if (!t && data.outputs) t = (data.outputs || []).map((o) => o.text || '').join('');
    return t;
  };
  return { status: r.status, ok: r.ok, data, text };
}

class ModelMissing extends Error {}

async function callModel(parts, key, model) {
  let route = lsGet('stilora.route') || 'generate';
  let last = null;
  // Sunucu hatalarında (5xx) bekleyip yeniden dene, sonra diğer yolu dene
  const plan = [[route, 0], [route, 2000], [route === 'generate' ? 'interactions' : 'generate', 0], [route, 6000]];
  for (const [way, wait] of plan) {
    if (wait) await sleep(wait);
    let res;
    try { res = await (way === 'generate' ? viaGenerate(parts, key, model) : viaInteractions(parts, key, model)); }
    catch { if (way === route) throw new Error('İnternete bağlanılamadı.'); continue; } // diğer yol tarayıcıdan erişilemiyorsa geç
    if (res.status === 429) throw new QuotaError('Yapay zekâ kotası doldu (429)', retryDelayMs(res.data));
    if (res.status === 404 && way === route) throw new ModelMissing(model);
    if (res.ok) {
      const text = res.text();
      if (!text) { last = res; continue; }
      if (way !== route) { lsSet('stilora.route', way); route = way; } // çalışan yolu hatırla
      return parseJSON(text);
    }
    last = res;
    if (res.status < 500 && way === route) break; // anahtar hatası: tekrar denemek işe yaramaz
  }
  const st = last?.status || 0;
  const msg = friendly(st, last?.data?.error?.message);
  if (st >= 500 || !st) throw new TempError(msg);
  throw new Error(msg);
}

// Kotası dolan modeller ve ne zaman yeniden açılacakları
function exhausted() { try { return JSON.parse(lsGet('stilora.exhausted') || '{}'); } catch { return {}; } }
function markExhausted(model, ms) { const e = exhausted(); e[model] = Date.now() + ms; lsSet('stilora.exhausted', JSON.stringify(e)); }

export function modelChain() {
  return [...new Set([apiModel(), DEFAULT_MODEL, ...BACKUP_MODELS])];
}

export async function gemini(parts) {
  const key = apiKey();
  if (!key) throw new Error('API anahtarı yok');
  const ex = exhausted();
  const now = Date.now();
  const chain = modelChain();
  let tried = 0;
  for (const model of chain) {
    if (ex[model] && ex[model] > now) continue;
    tried++;
    try { return await callModel(parts, key, model); }
    catch (e) {
      if (e instanceof QuotaError) { markExhausted(model, Math.max(e.retryMs || 0, 30000)); continue; }
      if (e instanceof ModelMissing) { markExhausted(model, 7 * 86400000); continue; }
      throw e;
    }
  }
  // Hepsi dolu: en erken açılacak olanı bildir
  const e2 = exhausted();
  const soonest = Math.min(...chain.map((m) => e2[m] || Infinity));
  if (!tried && soonest === Infinity) throw new Error(`Model bulunamadı: ${apiModel()}. Ayarlardan model adını kontrol et.`);
  const wait = Math.max(5000, (soonest === Infinity ? 60000 : soonest - Date.now()));
  const msg = wait > 10 * 60000
    ? `Günlük ücretsiz yapay zekâ hakkı bitti. Yaklaşık ${new Date(Date.now() + wait).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })} civarında yeniden açılır.`
    : 'Yapay zekâ kotası doldu (429)';
  throw new QuotaError(msg, wait);
}

export function analyzePrompt() {
  return `Bu fotoğraftaki tek bir kıyafeti/aksesuarı incele. SADECE şu JSON'u döndür:
{"ad":"kısa Türkçe ad, ör. Lacivert kapüşonlu sweatshirt",
 "tur":"${CATEGORIES.join('" | "')}",
 "renk":"ana renk(ler), Türkçe",
 "mevsim":"${SEASONS.join('" | "')}",
 "resmiyet":"${FORMALITY.join('" | "')}",
 "kumas":"tahmini kumaş, Türkçe",
 "kalinlik":"${THICKNESS.join('" | "')}",
 "kalip":"${FITS.join('" | "')}",
 "paca":"${LEGS.join('" | "')}"}
Tek parça = elbise, tulum gibi. Kalıp yalnızca üst, alt ve dış giyim için; paça yalnızca alt için, emin değilsen "${YOK}" yaz.`;
}

// Yapay zekâ tahminini kıyafete uygular; kullanıcının düzelttiği alanlara dokunmaz
export function applyAnalysis(it, j) {
  const edited = new Set(it.userEdited || []);
  const set = (k, v) => { if (!edited.has(k) && v) it[k] = v; };
  set('name', j.ad);
  set('category', pick(j.tur, CATEGORIES));
  set('color', j.renk);
  set('season', pick(j.mevsim, SEASONS));
  set('formality', pick(j.resmiyet, FORMALITY));
  set('fabric', j.kumas);
  set('thickness', pick(j.kalinlik, THICKNESS));
  if (FIT_CATS.includes(it.category)) set('fit', pick(j.kalip, FITS, ''));
  if (it.category === 'Alt') set('leg', pick(j.paca, LEGS, ''));
  it.check = true;
  it.aiStatus = 'done';
  it.aiError = '';
  it.updatedAt = Date.now();
}

function describe(i, n) {
  const extra = [
    i.fabric && `kumaş: ${i.fabric}`,
    i.thickness && `kalınlık: ${i.thickness}`,
    i.fit && i.fit !== YOK && `kalıp: ${i.fit}`,
    i.leg && i.leg !== YOK && `paça: ${i.leg}`,
    i.favorite && 'favori'
  ].filter(Boolean).join(', ');
  return `${n}. ${i.name || i.category} (tür: ${i.category}, renk: ${i.color || '?'}, mevsim: ${i.season || '?'}, resmiyet: ${i.formality || '?'}${extra ? ', ' + extra : ''})`;
}

const OUTFIT_RULES = `Yalnızca listedeki kıyafetleri kullan, uydurma. Tek parça (elbise, tulum) üst ve alt yerine geçer. Her kombin giyilebilir bir bütün olsun (üst+alt veya tek parça, mümkünse ayakkabı; gerekirse dış giyim ve aksesuar). Mevsim, resmiyet, renk uyumu ve kalıp/siluet dengesini (ör. bol üst + daha dar alt) dikkate al. Hava bilgisi verildiyse kalınlığa ve dış giyime dikkat et. Uygun kombin çıkmıyorsa açıklamada dürüstçe söyle.`;

// Tek kişilik kombin isteği. Dönüş: [{title, ids, why}]
export async function suggestOutfits({ pool, occasion, note, weather, recent, avoid, pinned, body }) {
  const lines = pool.map((i, n) => describe(i, n + 1));
  const idx = new Map(pool.map((i, n) => [i.id, n + 1]));
  let p = `Sen Türkçe konuşan bir stil danışmanısın. "${occasion}" için 3 farklı kombin öner.\n${OUTFIT_RULES}\n`;
  if (note) p += `Kullanıcının notu: ${note}\n`;
  if (weather) p += `Bugünün havası: ${weather}\n`;
  if (body) p += `Kullanıcının vücut tipi: ${body}. Kesim ve siluet seçerken bunu gözet.\n`;
  if (pinned) p += `Her kombinde ${idx.get(pinned)} numaralı parça MUTLAKA yer alsın.\n`;
  if (recent?.length) p += `Son günlerde giyilenler (mümkünse tekrar etme): ${recent.map((id) => idx.get(id)).filter(Boolean).join(', ')}\n`;
  if (avoid?.length) p += `Daha önce önerilen şu kombinleri tekrar etme: ${avoid.map((ids) => '[' + ids.map((id) => idx.get(id)).filter(Boolean).join(',') + ']').join(' ')}\n`;
  p += `SADECE şu JSON'u döndür: {"kombinler":[{"baslik":"kısa ad","kiyafetler":[1,3,5],"aciklama":"1-2 cümle"}]}\nGardırop:\n${lines.join('\n')}`;
  const j = await gemini([{ text: p }]);
  return (j.kombinler || []).map((o) => ({
    title: o.baslik || 'Kombin',
    why: o.aciklama || '',
    ids: [...new Set((o.kiyafetler || []).map((n) => pool[Number(n) - 1]?.id).filter(Boolean))]
  })).filter((o) => o.ids.length);
}

// Çift kombini. Dönüş: [{title, a:[ids], b:[ids], why}]
export async function suggestCouple({ poolA, poolB, nameA, nameB, occasion, harmony, note, weather, bodyA, bodyB }) {
  const all = [...poolA.map((i) => ['A', i]), ...poolB.map((i) => ['B', i])];
  const linesA = poolA.map((i, n) => describe(i, n + 1));
  const linesB = poolB.map((i, n) => describe(i, poolA.length + n + 1));
  let p = `Sen Türkçe konuşan bir stil danışmanısın. İki kişi birlikte "${occasion}" için çıkacak. Her biri için kendi gardırobundan, birbiriyle uyumlu 3 çift kombini öner. Uyum tarzı: ${harmony} (Renk uyumlu: ortak renk paleti; Tamamlayıcı: birbirini tamamlayan zıt ama uyumlu renkler; Resmiyet dengeli: aynı resmiyet seviyesi, renkler serbest).\n${OUTFIT_RULES}\nKişi 1'e yalnızca 1. listeden, Kişi 2'ye yalnızca 2. listeden parça ver.\n`;
  if (note) p += `Not: ${note}\n`;
  if (weather) p += `Bugünün havası: ${weather}\n`;
  if (bodyA) p += `Kişi 1'in vücut tipi: ${bodyA}.\n`;
  if (bodyB) p += `Kişi 2'nin vücut tipi: ${bodyB}.\n`;
  p += `SADECE şu JSON'u döndür: {"kombinler":[{"baslik":"kısa ad","kisi1":[1,2],"kisi2":[7,9],"aciklama":"1-2 cümle"}]}\n1. liste (${nameA}):\n${linesA.join('\n')}\n2. liste (${nameB}):\n${linesB.join('\n')}`;
  const j = await gemini([{ text: p }]);
  const get = (arr, side) => [...new Set((arr || []).map((n) => all[Number(n) - 1]).filter((x) => x && x[0] === side).map((x) => x[1].id))];
  return (j.kombinler || []).map((o) => ({ title: o.baslik || 'Çift kombini', why: o.aciklama || '', a: get(o.kisi1, 'A'), b: get(o.kisi2, 'B') }))
    .filter((o) => o.a.length && o.b.length);
}

// Yapay zekâsız yedek motor
export function fallbackOutfits(pool, occasion, season, pinned, count = 3) {
  const okForm = { 'İş': ['Resmi', 'Şık günlük'], 'Davet / Düğün': ['Resmi', 'Şık günlük'], 'Akşam yemeği': ['Şık günlük', 'Resmi', 'Günlük'],
    'Spor': ['Spor'], 'Seyahat': ['Günlük', 'Spor'], 'Günlük': ['Günlük', 'Şık günlük'] }[occasion];
  const seasonOK = (i) => !season || !i.season || i.season === 'Dört mevsim' || i.season === season;
  const fit = (i) => seasonOK(i) && (!okForm || !i.formality || okForm.includes(i.formality));
  const shuffle = (a) => a.map((x) => [Math.random(), x]).sort((p, q) => p[0] - q[0]).map((p) => p[1]);
  const by = (c) => shuffle(pool.filter((i) => i.category === c && fit(i)));
  const tops = by('Üst'), bottoms = by('Alt'), ones = by('Tek parça'), shoes = by('Ayakkabı'), outer = by('Dış giyim');
  const pin = pool.find((i) => i.id === pinned);
  const out = [];
  for (let k = 0; k < count * 2 && out.length < count; k++) {
    const set = [];
    const useOne = pin ? pin.category === 'Tek parça' : (ones.length && (k % 2 === 1 || !tops.length || !bottoms.length));
    if (useOne) { const o = pin?.category === 'Tek parça' ? pin : ones[k % (ones.length || 1)]; if (!o) continue; set.push(o); }
    else {
      const t = pin?.category === 'Üst' ? pin : tops[k % (tops.length || 1)];
      const b = pin?.category === 'Alt' ? pin : bottoms[k % (bottoms.length || 1)];
      if (!t || !b) continue;
      set.push(t, b);
    }
    const sh = pin?.category === 'Ayakkabı' ? pin : shoes[k % (shoes.length || 1)];
    if (sh) set.push(sh);
    const ou = pin?.category === 'Dış giyim' ? pin : (season === 'Kış' || season === 'İlkbahar/Sonbahar') ? outer[k % (outer.length || 1)] : null;
    if (ou) set.push(ou);
    const ac = pin?.category === 'Aksesuar' ? pin : null;
    if (ac) set.push(ac);
    const ids = [...new Set(set.map((i) => i.id))];
    if (out.some((o) => o.ids.join() === ids.join())) continue;
    out.push({ title: `Öneri ${out.length + 1}`, ids, why: 'Tür, mevsim ve resmiyet uyumuna göre seçildi (yapay zekâsız öneri).' });
  }
  return out;
}

// Üzerindeki kıyafetlerle çekilmiş fotoğraftaki her parçayı bulur.
// Dönüş: [{ fields: {ad, tur, ...}, box: [ymin, xmin, ymax, xmax] (0-1000) }]
export function detectPrompt() {
  return `Bu fotoğrafta bir kişinin üzerinde giydiği kıyafetler var. Görünen HER ayrı kıyafeti ve aksesuarı bul (ör. gömlek, tişört, pantolon, etek, elbise, ceket, ayakkabı, çanta, şapka).
Her parça için kutu ver: [ymin, xmin, ymax, xmax], 0-1000 aralığında normalize edilmiş. Kutu YALNIZCA o kıyafeti kapsasın; yüzü ve başı mümkün olduğunca dışarıda bırak.
Büyük kısmı görünmeyen (ör. ceketin altında neredeyse tamamen kalan) parçaları ekleme. Aynı türden iki ayakkabıyı tek parça say.
SADECE şu JSON'u döndür:
{"parcalar":[{"ad":"kısa Türkçe ad","tur":"${CATEGORIES.join('" | "')}","renk":"ana renk","mevsim":"${SEASONS.join('" | "')}","resmiyet":"${FORMALITY.join('" | "')}","kumas":"tahmini kumaş","kalinlik":"${THICKNESS.join('" | "')}","kalip":"${FITS.join('" | "')}","paca":"${LEGS.join('" | "')}","kutu":[0,0,1000,1000]}]}`;
}

export function parseDetections(j) {
  const arr = Array.isArray(j) ? j : (j.parcalar || j.items || []);
  return arr.map((p) => {
    let b = p.kutu || p.box_2d || p.box;
    if (!Array.isArray(b) || b.length !== 4) return null;
    b = b.map((v) => Math.max(0, Math.min(1000, Number(v) || 0)));
    let [y0, x0, y1, x1] = b;
    if (y1 < y0) [y0, y1] = [y1, y0];
    if (x1 < x0) [x0, x1] = [x1, x0];
    if (y1 - y0 < 20 || x1 - x0 < 20) return null;
    return { fields: p, box: [y0, x0, y1, x1] };
  }).filter(Boolean);
}


// ---- Gerçekçi önizleme (görüntü üretimi). Google'da bu modellerin ücretsiz hakkı yok. ----
const IMAGE_MODELS = ['gemini-3.1-flash-image-preview', 'gemini-2.5-flash-image'];

// persons: [{ face: base64 jpeg, desc: 'kadın, ~165 cm…', items: [{ data: base64 jpeg, label }] }]
export async function tryOnImage(persons) {
  const key = apiKey();
  if (!key) throw new Error('API anahtarı yok');
  const two = persons.length > 1;
  const parts = [{ text:
    `Gerçekçi bir moda fotoğrafı oluştur. ${two ? 'İki kişi yan yana' : 'Bir kişi'}, önden, tam boy (baştan ayağa), düz açık gri stüdyo arka planında, doğal yumuşak ışıkta duruyor.
Her kişinin yüzünü ve saçını verilen fotoğraftakiyle aynı tut. Kişiyi yalnızca verilen kıyafetlerle giydir; kıyafetlerin rengini, desenini, kesimini ve dokusunu aynen koru, başka kıyafet ya da aksesuar ekleme. Vücut ölçülerini aşağıdaki tarife göre doğal ve gerçekçi yap. Görselde yazı olmasın.` }];
  persons.forEach((p, i) => {
    parts.push({ text: `Kişi ${i + 1} (${p.desc}) fotoğrafı:` });
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: p.face } });
    parts.push({ text: `Kişi ${i + 1}'in giyeceği kıyafetler:` });
    for (const it of p.items) {
      parts.push({ text: it.label });
      parts.push({ inline_data: { mime_type: 'image/jpeg', data: it.data } });
    }
  });
  let lastMsg = '';
  for (const model of IMAGE_MODELS) {
    let r;
    try {
      r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } })
      });
    } catch { throw new Error('İnternete bağlanılamadı.'); }
    const data = await r.json().catch(() => ({}));
    const msg = data?.error?.message || '';
    if (r.status === 404) { lastMsg = msg; continue; }
    if (r.status === 429 || /billing|free.?tier|limit: ?0/i.test(msg)) {
      if (r.status === 429 && !/limit: ?0|free.?tier|billing/i.test(msg)) throw new QuotaError('Görüntü üretme kotası doldu, biraz sonra tekrar dene.', retryDelayMs(data));
      throw new Error("Bu özellik ücretli: Google AI Studio'da faturalandırma (billing) açılmalı. Görüntü modellerinin ücretsiz hakkı yok.");
    }
    if (r.status >= 500) { lastMsg = `Google sunucusu yanıt vermedi (${r.status}).`; continue; }
    if (!r.ok) throw new Error(msg || `Hata ${r.status}`);
    const out = (data.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData || p.inline_data);
    if (!out) {
      const why = data.candidates?.[0]?.finishReason;
      throw new Error('Görüntü üretilemedi' + (why && why !== 'STOP' ? ` (${why}); güvenlik filtresine takılmış olabilir.` : '. Tekrar dene.'));
    }
    const d = out.inlineData || out.inline_data;
    const bin = atob(d.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: d.mimeType || d.mime_type || 'image/png' });
  }
  throw new TempError(lastMsg || 'Görüntü modeli bulunamadı.');
}
