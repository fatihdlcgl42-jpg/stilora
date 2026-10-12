// Gemini bağlantısı: kota hatasında yavaşlar, başka hatalarda anlaşılır mesaj verir
import { CATEGORIES, SEASONS, FORMALITY, THICKNESS, FITS, LEGS, FIT_CATS, YOK, pick } from './model.js';

export const DEFAULT_MODEL = 'gemini-3.8-flash';
const RETIRED_MODELS = ['gemini-2.5-flash'];

function lsGet(k, d = '') { try { return localStorage.getItem(k) ?? d; } catch { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* yoksay */ } }
export { lsGet, lsSet };

if (RETIRED_MODELS.includes(lsGet('stilora.model'))) lsSet('stilora.model', DEFAULT_MODEL);

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

function friendly(status, msg) {
  if (status === 400 && /API key|API_KEY/i.test(msg)) return 'API anahtarı geçersiz. Profil → Ayarlar\'dan kontrol et.';
  if (status === 403) return 'Bu anahtarın Gemini\'ye erişim izni yok (403).';
  if (status === 404) return `Model bulunamadı: ${apiModel()}. Ayarlardan model adını kontrol et.`;
  if (status >= 500) return 'Google tarafında geçici bir sorun var, birazdan tekrar dene.';
  return msg || `Hata ${status}`;
}

export async function gemini(parts) {
  const key = apiKey();
  if (!key) throw new Error('API anahtarı yok');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(apiModel())}:generateContent?key=${encodeURIComponent(key)}`;
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
  let r;
  try { r = await send(lowThinking); }
  catch { throw new Error('İnternete bağlanılamadı.'); }
  let data = await r.json().catch(() => ({}));
  if (r.status === 400 && lowThinking && /thinking/i.test(data?.error?.message || '')) {
    lowThinking = false; lsSet('stilora.lowThinking', 'off');
    r = await send(false);
    data = await r.json().catch(() => ({}));
  }
  if (r.status === 429) throw new QuotaError('Yapay zekâ kotası doldu (429)', retryDelayMs(data));
  if (!r.ok) throw new Error(friendly(r.status, data?.error?.message));
  const text = (data.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
  const clean = text.replace(/^\s*```(json)?/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(clean); }
  catch { throw new Error('Yapay zekâ yanıtı okunamadı, tekrar dene.'); }
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
export async function suggestOutfits({ pool, occasion, note, weather, recent, avoid, pinned }) {
  const lines = pool.map((i, n) => describe(i, n + 1));
  const idx = new Map(pool.map((i, n) => [i.id, n + 1]));
  let p = `Sen Türkçe konuşan bir stil danışmanısın. "${occasion}" için 3 farklı kombin öner.\n${OUTFIT_RULES}\n`;
  if (note) p += `Kullanıcının notu: ${note}\n`;
  if (weather) p += `Bugünün havası: ${weather}\n`;
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
export async function suggestCouple({ poolA, poolB, nameA, nameB, occasion, harmony, note, weather }) {
  const all = [...poolA.map((i) => ['A', i]), ...poolB.map((i) => ['B', i])];
  const linesA = poolA.map((i, n) => describe(i, n + 1));
  const linesB = poolB.map((i, n) => describe(i, poolA.length + n + 1));
  let p = `Sen Türkçe konuşan bir stil danışmanısın. İki kişi birlikte "${occasion}" için çıkacak. Her biri için kendi gardırobundan, birbiriyle uyumlu 3 çift kombini öner. Uyum tarzı: ${harmony} (Renk uyumlu: ortak renk paleti; Tamamlayıcı: birbirini tamamlayan zıt ama uyumlu renkler; Resmiyet dengeli: aynı resmiyet seviyesi, renkler serbest).\n${OUTFIT_RULES}\nKişi 1'e yalnızca 1. listeden, Kişi 2'ye yalnızca 2. listeden parça ver.\n`;
  if (note) p += `Not: ${note}\n`;
  if (weather) p += `Bugünün havası: ${weather}\n`;
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
