// Sabitler, kıyafet modeli, eski web kayıtlarının taşınması ve Android uyumu
export const YOK = 'Belirtilmemiş';
export const CATEGORIES = ['Üst', 'Alt', 'Tek parça', 'Dış giyim', 'Ayakkabı', 'Aksesuar'];
export const SEASONS = ['Dört mevsim', 'Yaz', 'Kış', 'İlkbahar/Sonbahar'];
export const FORMALITY = ['Günlük', 'Şık günlük', 'Resmi', 'Spor'];
export const THICKNESS = ['İnce', 'Orta', 'Kalın'];
export const FITS = [YOK, 'Skinny', 'Slim', 'Regular', 'Relaxed', 'Loose', 'Baggy', 'Oversize'];
export const LEGS = [YOK, 'Düz', 'Bootcut', 'Havuç', 'Geniş paça', 'Mom fit'];
export const FIT_CATS = ['Üst', 'Alt', 'Dış giyim'];
export const OCCASIONS = ['Günlük', 'İş', 'Davet / Düğün', 'Akşam yemeği', 'Spor', 'Seyahat'];
export const HARMONY = ['Renk uyumlu', 'Tamamlayıcı', 'Resmiyet dengeli'];
// Giyince kirli sepetine düşen türler
export const DIRTY_CATS = ['Üst', 'Alt', 'Tek parça'];

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function newItem(profileId, photo) {
  const now = Date.now();
  return {
    schema: 2, id: uid(), profileId, photo, original: null,
    name: '', category: '', color: '', season: '', formality: '', fabric: '', thickness: '',
    brand: '', size: '', model: '', fit: YOK, leg: YOK, note: '',
    favorite: false, dirty: false, stored: false, wearCount: 0, lastWorn: 0,
    aiStatus: 'none', aiError: '', bgStatus: 'none', bgError: '', check: false, userEdited: [],
    createdAt: now, updatedAt: now
  };
}

export function pick(val, list, fallback = '') {
  if (!val) return fallback;
  const v = String(val).toLocaleLowerCase('tr').replace(/\s+/g, ' ').trim();
  const L = (x) => x.toLocaleLowerCase('tr');
  return list.find((x) => L(x) === v)
    || list.find((x) => x && x !== YOK && v.includes(L(x)))
    || list.find((x) => x && x !== YOK && L(x).includes(v))
    || fallback;
}

// 0.1.x web sürümünden kalan kayıtları yeni yapıya çevir
const OLD_CAT = { 'Üst giyim': 'Üst', 'Alt giyim': 'Alt', 'Elbise / Tulum': 'Tek parça', 'Dış giyim': 'Dış giyim', 'Ayakkabı': 'Ayakkabı', 'Çanta': 'Aksesuar', 'Aksesuar': 'Aksesuar', 'Spor': 'Üst', 'Ev / İç giyim': 'Üst' };
const OLD_SEASON = { 'İlkbahar / Sonbahar': 'İlkbahar/Sonbahar' };
const OLD_FORM = { 'Smart casual': 'Şık günlük' };
const OLD_FIT = { 'Slim fit': ['Slim', YOK], 'Regular fit': ['Regular', YOK], 'Oversize': ['Oversize', YOK], 'Relaxed': ['Relaxed', YOK], 'Skinny': ['Skinny', YOK],
  'Straight': [YOK, 'Düz'], 'Wide leg': [YOK, 'Geniş paça'], 'Bol paça': [YOK, 'Geniş paça'], 'Boru paça': [YOK, 'Düz'], 'İspanyol paça': [YOK, 'Bootcut'], 'Mom fit': [YOK, 'Mom fit'] };

export function migrate(it) {
  if (it.schema === 2) return false;
  const base = newItem(it.profileId, it.photo);
  const out = Object.assign(base, it);
  out.schema = 2;
  out.category = OLD_CAT[it.category] ?? pick(it.category, CATEGORIES);
  out.season = OLD_SEASON[it.season] ?? (it.season || '');
  out.formality = OLD_FORM[it.formality] ?? (it.formality || '');
  const f = OLD_FIT[it.fit];
  if (f) { out.fit = f[0]; out.leg = f[1]; }
  else if (it.fit && !FITS.includes(it.fit)) { out.model = out.model || it.fit; out.fit = YOK; }
  if (!FITS.includes(out.fit)) out.fit = YOK;
  if (!LEGS.includes(out.leg)) out.leg = YOK;
  Object.assign(it, out);
  return true;
}

// ---- Android biçimi (kiyafetler.json) ----
export function toAndroid(it, foto) {
  return {
    ad: it.name || 'Kıyafet', tur: it.category || CATEGORIES[0], renk: it.color || '', foto,
    mevsim: it.season || SEASONS[0], kumas: it.fabric || '', resmiyet: it.formality || FORMALITY[0],
    id: it.id, kontrol: !!it.check, marka: it.brand || '', beden: it.size || '', model: it.model || '',
    kalip: it.fit || YOK, paca: it.leg || YOK,
    // Android'in tanımadığı alanlar yok sayılır
    kalinlik: it.thickness || '', not: it.note || '', favori: !!it.favorite, kirli: !!it.dirty,
    depoda: !!it.stored, giyilmeSayisi: it.wearCount || 0, sonGiyilme: it.lastWorn || 0
  };
}

export function fromAndroid(o, profileId, photo) {
  const it = newItem(profileId, photo);
  const g = (...keys) => { for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k]; return undefined; };
  it.id = String(g('id') || it.id);
  it.name = String(g('ad') || '');
  it.category = pick(g('tur'), CATEGORIES, CATEGORIES[0]);
  it.color = String(g('renk') || '');
  it.season = pick(g('mevsim'), SEASONS, SEASONS[0]);
  it.fabric = String(g('kumas') || '');
  it.formality = pick(g('resmiyet'), FORMALITY, FORMALITY[0]);
  it.thickness = pick(g('kalinlik'), THICKNESS, '');
  it.check = !!g('kontrol');
  it.brand = String(g('marka') || '');
  it.size = String(g('beden', 'numara') || '');
  it.model = String(g('model') || '');
  it.fit = pick(g('kalip'), FITS, YOK);
  it.leg = pick(g('paca'), LEGS, YOK);
  it.note = String(g('not') || '');
  it.favorite = !!g('favori');
  it.dirty = !!g('kirli');
  it.stored = !!g('depoda', 'depo');
  it.wearCount = Number(g('giyilmeSayisi', 'giyilme') || 0) || 0;
  it.lastWorn = Number(g('sonGiyilme') || 0) || 0;
  it.aiStatus = 'done';
  it.bgStatus = 'done';
  return it;
}
