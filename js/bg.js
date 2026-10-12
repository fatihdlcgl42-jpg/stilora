// Cihaz içi arka plan kaldırma: fotoğraf telefondan dışarı çıkmaz.
// İki model kullanılır, ikisi de ilk kullanımda bir kez indirilir, sonra tarayıcı önbelleğinden gelir:
//  1) Kıyafet ayırma (SegFormer, ~30 MB): fotoğrafta insan/manken varsa yalnız kıyafeti bırakır,
//     kol, bacak, yüz ve saçı siler.
//  2) Genel arka plan kaldırma (RMBG-1.4, ~45 MB): insan yoksa (düz çekim, askı) kullanılır.
// Not: RMBG-1.4 yalnızca ticari olmayan kullanım için ücretsizdir; uygulama satılacaksa değiştirilmeli.
const LIB_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2';
const RMBG_ID = 'briaai/RMBG-1.4';
const SEG_ID = 'Xenova/segformer_b2_clothes';

// SegFormer etiketleri
const SKIN = ['Face', 'Hair', 'Left-arm', 'Right-arm', 'Left-leg', 'Right-leg'];
const CLOTHES = ['Hat', 'Sunglasses', 'Upper-clothes', 'Skirt', 'Pants', 'Dress', 'Belt', 'Left-shoe', 'Right-shoe', 'Bag', 'Scarf'];
const BY_CATEGORY = {
  'Üst': ['Upper-clothes'],
  'Dış giyim': ['Upper-clothes', 'Dress'],
  'Alt': ['Pants', 'Skirt'],
  'Tek parça': ['Dress', 'Upper-clothes', 'Skirt', 'Pants'],
  'Ayakkabı': ['Left-shoe', 'Right-shoe'],
  'Aksesuar': ['Hat', 'Sunglasses', 'Belt', 'Bag', 'Scarf']
};

let libP = null, rmbgP = null, segP = null;

const lib = () => (libP ||= import(LIB_URL).then((T) => { T.env.allowLocalModels = false; return T; }).catch((e) => { libP = null; throw e; }));

async function loadRmbg(onStatus) {
  if (!rmbgP) {
    rmbgP = (async () => {
      onStatus?.('Arka plan modeli yükleniyor (ilk seferde ~45 MB)…');
      const T = await lib();
      const model = await T.AutoModel.from_pretrained(RMBG_ID, { config: { model_type: 'custom' }, dtype: 'q8' });
      const processor = await T.AutoProcessor.from_pretrained(RMBG_ID, {
        config: {
          do_normalize: true, do_pad: false, do_rescale: true, do_resize: true,
          image_mean: [0.5, 0.5, 0.5], image_std: [1, 1, 1], resample: 2,
          rescale_factor: 1 / 255, size: { width: 1024, height: 1024 },
          feature_extractor_type: 'ImageFeatureExtractor'
        }
      });
      return { model, processor };
    })().catch((e) => { rmbgP = null; throw e; });
  }
  return rmbgP;
}

async function loadSeg(onStatus) {
  if (!segP) {
    segP = (async () => {
      onStatus?.('Kıyafet ayırma modeli yükleniyor (ilk seferde ~30 MB)…');
      const T = await lib();
      return T.pipeline('image-segmentation', SEG_ID, { dtype: 'q8' });
    })().catch((e) => { segP = null; throw e; });
  }
  return segP;
}

async function bitmap(blob) {
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

// Kıyafet ayırma: insan yoksa null döner. Varsa kıyafet maskesi (w*h, 0-255).
async function clothesMask(T, image, w, h, category, onStatus) {
  let seg;
  try { seg = await loadSeg(onStatus); }
  catch { return null; } // model inemezse genel yönteme düş
  onStatus?.('Kıyafet ayrılıyor…');
  const out = await seg(image);
  const n = w * h;
  const count = (labels) => {
    let c = 0;
    for (const o of out) if (labels.includes(o.label)) { const d = o.mask.data; for (let i = 0; i < n; i++) if (d[i] > 127) c++; }
    return c;
  };
  const skin = count(SKIN);
  if (skin < n * 0.01) return null; // insan/manken yok: düz çekim
  const merge = (labels) => {
    const m = new Uint8Array(n);
    for (const o of out) if (labels.includes(o.label)) { const d = o.mask.data; for (let i = 0; i < n; i++) if (d[i] > m[i]) m[i] = d[i]; }
    return m;
  };
  const wanted = BY_CATEGORY[category];
  if (wanted && count(wanted) > n * 0.02) return merge(wanted);
  const all = count(CLOTHES);
  return all > n * 0.02 ? merge(CLOTHES) : null;
}

async function rmbgMask(T, image, w, h, onStatus) {
  const { model, processor } = await loadRmbg(onStatus);
  onStatus?.('Arka plan temizleniyor…');
  const { pixel_values } = await processor(image);
  const { output } = await model({ input: pixel_values });
  const mask = await T.RawImage.fromTensor(output[0].mul(255).to('uint8')).resize(w, h);
  return mask.data;
}

// Arka planı (ve varsa insanı) beyaza çevirir, kıyafeti ortalar. Dönüş: JPEG Blob
export async function removeBackground(blob, onStatus, category = '') {
  const T = await lib();
  const bmp = await bitmap(blob);
  // Telefon belleği için en fazla 1600 px üzerinde çalış
  const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0, w, h);
  const px = g.getImageData(0, 0, w, h);
  const image = new T.RawImage(new Uint8ClampedArray(px.data), w, h, 4).rgb();

  let m = await clothesMask(T, image, w, h, category, onStatus);
  if (!m) m = await rmbgMask(T, image, w, h, onStatus);

  let x0 = w, y0 = h, x1 = -1, y1 = -1, covered = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = m[y * w + x];
      px.data[(y * w + x) * 4 + 3] = a;
      if (a > 128) { covered++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  }
  if (x1 < 0 || covered < w * h * 0.01) throw new Error('Kıyafet ayırt edilemedi');
  g.putImageData(px, 0, 0);

  const pad = Math.round(Math.max(x1 - x0, y1 - y0) * 0.08);
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const side = Math.max(bw, bh) + pad * 2;
  const out = document.createElement('canvas');
  const scale = Math.min(1, 1000 / side);
  out.width = out.height = Math.round(side * scale);
  const og = out.getContext('2d');
  og.fillStyle = '#ffffff';
  og.fillRect(0, 0, out.width, out.height);
  og.drawImage(c, x0, y0, bw, bh,
    Math.round(((side - bw) / 2) * scale), Math.round(((side - bh) / 2) * scale), Math.round(bw * scale), Math.round(bh * scale));
  return new Promise((res) => out.toBlob(res, 'image/jpeg', 0.86));
}
