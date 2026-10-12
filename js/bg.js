// Cihaz içi arka plan kaldırma: fotoğraf telefondan dışarı çıkmaz.
// Model (RMBG-1.4, ~45 MB) ilk kullanımda bir kez indirilir, sonra tarayıcı önbelleğinden gelir.
// Not: RMBG-1.4 yalnızca ticari olmayan kullanım için ücretsizdir; uygulama satılacaksa model değiştirilmeli.
const LIB_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2';
const MODEL_ID = 'briaai/RMBG-1.4';

let loading = null;

export function isLoaded() { return !!loading; }

async function load(onStatus) {
  if (!loading) {
    loading = (async () => {
      onStatus?.('Arka plan modeli yükleniyor (ilk seferde ~45 MB)…');
      const T = await import(LIB_URL);
      T.env.allowLocalModels = false;
      const model = await T.AutoModel.from_pretrained(MODEL_ID, { config: { model_type: 'custom' }, dtype: 'q8' });
      const processor = await T.AutoProcessor.from_pretrained(MODEL_ID, {
        config: {
          do_normalize: true, do_pad: false, do_rescale: true, do_resize: true,
          image_mean: [0.5, 0.5, 0.5], image_std: [1, 1, 1], resample: 2,
          rescale_factor: 1 / 255, size: { width: 1024, height: 1024 },
          feature_extractor_type: 'ImageFeatureExtractor'
        }
      });
      return { T, model, processor };
    })().catch((e) => { loading = null; throw e; });
  }
  return loading;
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

// Arka planı beyaza çevirir, kıyafeti ortalar. Dönüş: JPEG Blob
export async function removeBackground(blob, onStatus) {
  const { T, model, processor } = await load(onStatus);
  onStatus?.('Arka plan temizleniyor…');
  const bmp = await bitmap(blob);
  const w = bmp.width, h = bmp.height;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0, w, h);
  const px = g.getImageData(0, 0, w, h);
  const image = new T.RawImage(new Uint8ClampedArray(px.data), w, h, 4).rgb();
  const { pixel_values } = await processor(image);
  const { output } = await model({ input: pixel_values });
  const mask = await T.RawImage.fromTensor(output[0].mul(255).to('uint8')).resize(w, h);
  const m = mask.data;

  // Kıyafetin sınırlarını bul, maskeyi uygula
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
