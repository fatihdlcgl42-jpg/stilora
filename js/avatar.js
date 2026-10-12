// Avatar: boy, kilo ve vücut tipine göre çizilen silüet; yüz fotoğrafı kafada;
// kombindeki kıyafetler beyaz zeminden ayrılıp vücuttaki yerlerine yerleştirilir ("kâğıt bebek" görünümü).

export const BODY_TYPES = [
  ['dikdortgen', 'Dikdörtgen', 'Omuz, bel ve kalça birbirine yakın'],
  ['ters-ucgen', 'Ters üçgen', 'Omuzlar kalçadan geniş'],
  ['armut', 'Armut', 'Kalça omuzlardan geniş'],
  ['kum-saati', 'Kum saati', 'Omuz ve kalça dengeli, bel belirgin'],
  ['elma', 'Elma', 'Ağırlık daha çok gövdede, bel belirsiz']
];
export const bodyTypeName = (k) => BODY_TYPES.find((b) => b[0] === k)?.[1] || '';

// [omuz, bel, kalça] çarpanları
const SHAPE = {
  'dikdortgen': [1, 0.95, 1],
  'ters-ucgen': [1.14, 0.88, 0.9],
  'armut': [0.9, 0.9, 1.16],
  'kum-saati': [1.04, 0.76, 1.07],
  'elma': [1, 1.12, 1]
};
// Yarım genişlikler (px, 320 px boy için)
const BASE = {
  erkek: { neck: 9, sh: 44, ch: 40, wa: 33, hp: 35, arm: 10 },
  kadin: { neck: 8, sh: 37, ch: 35, wa: 27, hp: 39, arm: 8.5 }
};

export function bmi(p) {
  const h = Number(p?.height) / 100, w = Number(p?.weight);
  return h > 0.5 && w > 20 ? w / (h * h) : 0;
}
export function bmiLabel(v) {
  if (!v) return '';
  if (v < 18.5) return 'zayıf';
  if (v < 25) return 'normal';
  if (v < 30) return 'fazla kilolu';
  return 'obez';
}
// Yapay zekâya kilo yerine giden genel yapı tarifi
export function buildWord(p) {
  const v = bmi(p);
  if (!v) return '';
  if (v < 18.5) return 'ince yapılı';
  if (v < 25) return 'orta yapılı';
  if (v < 30) return 'iri yapılı';
  return 'dolgun yapılı';
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Noktalardan yumuşak (Catmull-Rom) kapalı yol
function smooth(pts) {
  const n = pts.length;
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d + 'Z';
}

export function geometry(p) {
  const sex = p?.sex === 'erkek' ? 'erkek' : 'kadin';
  const height = clamp(Number(p?.height) || (sex === 'erkek' ? 177 : 165), 130, 210);
  const H = clamp(250 + (height - 140) * 1.9, 230, 372);
  const y0 = 396 - H, cx = 100;
  const v = bmi(p) || 22.5;
  const wf = clamp(1 + (v - 22.5) * 0.035, 0.82, 1.55);
  const s = H / 320;
  const [ks, kw, kh] = SHAPE[p?.bodyType] || SHAPE.dikdortgen;
  const b = BASE[sex];
  const g = {
    sex, H, y0, cx, s, wf,
    neck: b.neck * s * Math.sqrt(wf),
    sh: b.sh * s * ks * Math.sqrt(wf),
    ch: b.ch * s * ((ks + 1) / 2) * wf,
    wa: b.wa * s * kw * Math.pow(wf, 1.35),
    hp: b.hp * s * kh * wf,
    arm: b.arm * s * Math.pow(wf, 0.8),
    Y: (f) => y0 + f * H
  };
  g.headR = 0.062 * H;
  g.headY = g.Y(0.068);
  g.shY = g.Y(0.17); g.chY = g.Y(0.25); g.waY = g.Y(0.4); g.hpY = g.Y(0.5); g.crY = g.Y(0.545);
  g.knY = g.Y(0.74); g.anY = g.Y(0.95); g.ftY = g.Y(1);
  g.armOut = Math.max(3 * s, g.hp - g.sh + 5 * s);
  return g;
}

function bodySVG(g, skin, line) {
  const { cx } = g;
  const torso = smooth([
    [cx - g.neck, g.Y(0.125)], [cx - g.neck, g.shY - 7 * g.s], [cx - g.sh + 4 * g.s, g.shY], [cx - g.sh, g.shY + 9 * g.s],
    [cx - g.ch, g.chY], [cx - g.wa, g.waY], [cx - g.hp, g.hpY], [cx - g.hp * 0.96, g.crY], [cx, g.crY + 3 * g.s],
    [cx + g.hp * 0.96, g.crY], [cx + g.hp, g.hpY], [cx + g.wa, g.waY], [cx + g.ch, g.chY], [cx + g.sh, g.shY + 9 * g.s],
    [cx + g.sh - 4 * g.s, g.shY], [cx + g.neck, g.shY - 7 * g.s], [cx + g.neck, g.Y(0.125)]
  ]);
  const leg = (d) => smooth([
    [cx + d * g.hp * 0.98, g.hpY + 4 * g.s], [cx + d * g.hp * 0.8, g.knY], [cx + d * g.hp * 0.55, g.anY],
    [cx + d * g.hp * 0.3, g.anY + 2 * g.s], [cx + d * g.hp * 0.2, g.knY], [cx + d * 2.5 * g.s, g.crY]
  ]);
  const wristY = g.Y(0.52);
  const arm = (d) => smooth([
    [cx + d * (g.sh - 2 * g.s), g.shY + 2 * g.s], [cx + d * (g.sh + g.arm * 0.6), g.shY + 6 * g.s],
    [cx + d * (g.sh + g.armOut + g.arm * 0.2), wristY], [cx + d * (g.sh + g.armOut - g.arm * 0.6), wristY + 2 * g.s],
    [cx + d * (g.sh - g.arm * 0.6), g.chY]
  ]);
  const hand = (d) => `<ellipse cx="${(cx + d * (g.sh + g.armOut - g.arm * 0.2)).toFixed(1)}" cy="${(wristY + 7 * g.s).toFixed(1)}" rx="${(g.arm * 0.55).toFixed(1)}" ry="${(8 * g.s).toFixed(1)}"/>`;
  const foot = (d) => `<ellipse cx="${(cx + d * g.hp * 0.45).toFixed(1)}" cy="${(g.ftY - 4 * g.s).toFixed(1)}" rx="${(g.hp * 0.32).toFixed(1)}" ry="${(5 * g.s).toFixed(1)}"/>`;
  // Gövde ve bacaklar: önce çizgili, sonra çizgisiz dolgu (iç birleşim çizgileri kaybolur)
  const core = `<path d="${leg(-1)}"/><path d="${leg(1)}"/><path d="${torso}"/>`;
  return `<g fill="${skin}" stroke-linejoin="round">
    <g stroke="${line}" stroke-width="2.2">${core}</g><g stroke="none">${core}</g>
    <g stroke="${line}" stroke-width="1.2">${foot(-1)}${foot(1)}<path d="${arm(-1)}"/><path d="${arm(1)}"/>${hand(-1)}${hand(1)}</g></g>`;
}

function headSVG(g, skin, line, faceURL, id) {
  const { cx } = g;
  if (faceURL) {
    return `<defs><clipPath id="hc${id}"><circle cx="${cx}" cy="${g.headY.toFixed(1)}" r="${g.headR.toFixed(1)}"/></clipPath></defs>
      <image href="${faceURL}" x="${(cx - g.headR).toFixed(1)}" y="${(g.headY - g.headR).toFixed(1)}" width="${(g.headR * 2).toFixed(1)}" height="${(g.headR * 2).toFixed(1)}" clip-path="url(#hc${id})" preserveAspectRatio="xMidYMid slice"/>
      <circle cx="${cx}" cy="${g.headY.toFixed(1)}" r="${g.headR.toFixed(1)}" fill="none" stroke="${line}" stroke-width="1.2"/>`;
  }
  const r = g.headR;
  return `<circle cx="${cx}" cy="${g.headY.toFixed(1)}" r="${r.toFixed(1)}" fill="${skin}" stroke="${line}" stroke-width="1.2"/>
    <circle cx="${(cx - r * 0.35).toFixed(1)}" cy="${(g.headY - r * 0.1).toFixed(1)}" r="${(r * 0.08).toFixed(1)}" fill="${line}"/>
    <circle cx="${(cx + r * 0.35).toFixed(1)}" cy="${(g.headY - r * 0.1).toFixed(1)}" r="${(r * 0.08).toFixed(1)}" fill="${line}"/>
    <path d="M${(cx - r * 0.3).toFixed(1)},${(g.headY + r * 0.35).toFixed(1)} Q${cx},${(g.headY + r * 0.55).toFixed(1)} ${(cx + r * 0.3).toFixed(1)},${(g.headY + r * 0.35).toFixed(1)}" fill="none" stroke="${line}" stroke-width="1.2"/>`;
}

// ---- Kıyafet fotoğrafından beyaz zemini ayır (kenardan taşma doldurma) ----
const cutCache = new WeakMap();

async function loadBitmap(blob) {
  if ('createImageBitmap' in window) {
    try { return await createImageBitmap(blob); } catch { /* aşağıya düş */ }
  }
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = URL.createObjectURL(blob);
  });
}

export function cutout(blob) {
  if (!blob) return Promise.resolve(null);
  if (cutCache.has(blob)) return cutCache.get(blob);
  const p = (async () => {
    const img = await loadBitmap(blob);
    const k = Math.min(1, 600 / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * k)), h = Math.max(1, Math.round(img.height * k));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, w, h);
    const im = g.getImageData(0, 0, w, h), d = im.data;
    const isBg = (i) => { const r = d[i], gg = d[i + 1], b = d[i + 2]; return r > 228 && gg > 228 && b > 228 && Math.max(r, gg, b) - Math.min(r, gg, b) < 18; };
    const seen = new Uint8Array(w * h), stack = [];
    for (let x = 0; x < w; x++) { stack.push(x, (h - 1) * w + x); }
    for (let y = 0; y < h; y++) { stack.push(y * w, y * w + w - 1); }
    let cleared = 0;
    while (stack.length) {
      const p2 = stack.pop();
      if (seen[p2]) continue;
      seen[p2] = 1;
      if (!isBg(p2 * 4)) continue;
      d[p2 * 4 + 3] = 0; cleared++;
      const x = p2 % w, y = (p2 / w) | 0;
      if (x > 0) stack.push(p2 - 1);
      if (x < w - 1) stack.push(p2 + 1);
      if (y > 0) stack.push(p2 - w);
      if (y < h - 1) stack.push(p2 + w);
    }
    // İçerik sınırları
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 0) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 < 0) return null;
    g.putImageData(im, 0, 0);
    const out = document.createElement('canvas');
    out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
    out.getContext('2d').drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
    const png = await new Promise((res) => out.toBlob(res, 'image/png'));
    return { url: URL.createObjectURL(png), w: out.width, h: out.height, clean: cleared > w * h * 0.08 };
  })().catch(() => null);
  cutCache.set(blob, p);
  return p;
}

// Kategorilere göre vücuttaki yer
function slot(g, cat, name = '') {
  const n = String(name).toLocaleLowerCase('tr');
  if (cat === 'Aksesuar') {
    if (/kemer/.test(n)) { const w = g.wa * 2.5; return { x: g.cx - w / 2, w, y: g.waY - 0.02 * g.H, h: 0.05 * g.H, a: 'xMidYMid', z: 4.5, fixed: true }; }
    if (/şapka|bere|kasket/.test(n)) { const w = g.headR * 2.6; return { x: g.cx - w / 2, w, y: g.headY - g.headR * 1.55, h: g.headR * 1.3, a: 'xMidYMax', z: 9, fixed: true }; }
    if (/atkı|şal|eşarp|fular/.test(n)) { const w = g.sh * 1.6; return { x: g.cx - w / 2, w, y: g.shY - 0.04 * g.H, h: 0.16 * g.H, a: 'xMidYMin', z: 6, fixed: true }; }
    if (/gözlük/.test(n)) { const w = g.headR * 1.8; return { x: g.cx - w / 2, w, y: g.headY - g.headR * 0.45, h: g.headR * 0.6, a: 'xMidYMid', z: 9, fixed: true }; }
  }
  const { cx } = g;
  const wide = (half) => [cx - half, half * 2];
  if (cat === 'Üst') { const [x, w] = wide(g.sh + g.arm + 6 * g.s); return { x, w, y: g.shY - 0.025 * g.H, h: g.hpY + 0.05 * g.H - (g.shY - 0.025 * g.H), a: 'xMidYMin', z: 3 }; }
  if (cat === 'Dış giyim') { const [x, w] = wide(g.sh + g.arm + g.armOut * 0.5 + 9 * g.s); return { x, w, y: g.shY - 0.03 * g.H, h: g.Y(0.64) - (g.shY - 0.03 * g.H), a: 'xMidYMin', z: 5 }; }
  if (cat === 'Tek parça') { const [x, w] = wide(Math.max(g.sh, g.hp) + g.arm + 4 * g.s); return { x, w, y: g.shY - 0.025 * g.H, h: g.Y(0.84) - (g.shY - 0.025 * g.H), a: 'xMidYMin', z: 4 }; }
  if (cat === 'Alt') { const [x, w] = wide(g.hp * 1.22); return { x, w, y: g.waY - 0.01 * g.H, h: g.anY + 0.012 * g.H - (g.waY - 0.01 * g.H), a: 'xMidYMin', z: 2 }; }
  if (cat === 'Ayakkabı') { const [x, w] = wide(g.hp * 1.15); return { x, w, y: g.anY - 0.035 * g.H, h: g.ftY + 3 - (g.anY - 0.035 * g.H), a: 'xMidYMax', z: 1 }; }
  if (cat === 'Aksesuar') { const sz = 0.15 * g.H; return { x: cx + g.sh + g.armOut - sz * 0.35, w: sz, y: g.Y(0.47), h: sz, a: 'xMidYMid', z: 6 }; }
  return null;
}

let uidN = 0;
// profile: {sex, height, weight, bodyType, skin}, items: kıyafet listesi, faceURL: yüz resmi adresi
export async function avatarSVG(profile, items = [], faceURL = '') {
  const g = geometry(profile);
  const skin = profile?.skin || '#e8c2a4';
  const line = 'rgba(60,40,30,.35)';
  const id = ++uidN;
  const used = new Set();
  const layers = [];
  let acc = 0;
  for (const it of items) {
    if (!it?.photo || !it.category) continue;
    if (it.category !== 'Aksesuar' && used.has(it.category)) continue;
    if (it.category === 'Aksesuar' && acc >= 2 && !/kemer|şapka|bere|kasket|atkı|şal|eşarp|fular|gözlük/i.test(it.name || '')) continue;
    const sl = slot(g, it.category, it.name);
    if (!sl) continue;
    const cut = await cutout(it.photo);
    if (!cut) continue;
    used.add(it.category);
    let { x } = sl;
    if (it.category === 'Aksesuar' && !sl.fixed) { if (acc === 1) x = 200 - x - sl.w; acc++; } // ikinci el aksesuarı diğer elde
    layers.push({ z: sl.z, svg: `<image href="${cut.url}" x="${x.toFixed(1)}" y="${sl.y.toFixed(1)}" width="${sl.w.toFixed(1)}" height="${sl.h.toFixed(1)}" preserveAspectRatio="${sl.a} meet"${cut.clean ? '' : ' opacity="0.95"'}/>` });
  }
  layers.sort((a, b) => a.z - b.z);
  return `<svg viewBox="0 0 200 400" xmlns="http://www.w3.org/2000/svg" class="avatar-svg" role="img" aria-label="Avatar">
    <ellipse cx="100" cy="${(g.ftY + 1).toFixed(1)}" rx="${(g.hp * 1.4).toFixed(1)}" ry="5" fill="rgba(0,0,0,.08)"/>
    ${bodySVG(g, skin, line)}
    ${layers.filter((l) => l.z < 8).map((l) => l.svg).join('')}
    ${headSVG(g, skin, line, faceURL, id)}
    ${layers.filter((l) => l.z >= 8).map((l) => l.svg).join('')}
  </svg>`;
}

// Yüz fotoğrafından ten rengi tahmini: yanak bölgesinden örnek alır, ten olmayan renkleri (kıyafet, arka plan) eler
export async function skinFromFace(blob) {
  try {
    const img = await loadBitmap(blob);
    const c = document.createElement('canvas');
    c.width = c.height = 48;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, img.width * 0.3, img.height * 0.28, img.width * 0.4, img.height * 0.32, 0, 0, 48, 48);
    const d = g.getImageData(0, 0, 48, 48).data;
    let r = 0, gg = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const R = d[i], G = d[i + 1], B = d[i + 2];
      // Ten tonları: kırmızı > yeşil > mavi, çok koyu ya da gri değil
      if (R > 60 && R > G && G > B && R - B > 15 && R - B < 150) { r += R; gg += G; b += B; n++; }
    }
    if (n < 48 * 48 * 0.15) return '';
    const hex = (v) => Math.round(clamp(v / n, 0, 255)).toString(16).padStart(2, '0');
    return `#${hex(r)}${hex(gg)}${hex(b)}`;
  } catch { return ''; }
}
