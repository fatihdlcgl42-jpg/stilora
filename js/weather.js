// Hava durumu: Open-Meteo (ücretsiz, anahtar gerektirmez). Konum yalnızca bu cihazda saklanır.
import { getMeta, setMeta } from './db.js';

const CODES = [
  [[0], 'Açık', '☀️'], [[1, 2], 'Parçalı bulutlu', '⛅'], [[3], 'Kapalı', '☁️'], [[45, 48], 'Sisli', '🌫️'],
  [[51, 53, 55, 56, 57], 'Çiseleme', '🌦️'], [[61, 63, 65, 66, 67, 80, 81, 82], 'Yağmurlu', '🌧️'],
  [[71, 73, 75, 77, 85, 86], 'Karlı', '❄️'], [[95, 96, 99], 'Fırtınalı', '⛈️']
];
export function describeCode(c) {
  const f = CODES.find((x) => x[0].includes(c));
  return f ? { text: f[1], icon: f[2] } : { text: 'Bilinmiyor', icon: '🌡️' };
}

export async function getPlace() { return (await getMeta('place')) || null; }

export async function setPlaceFromGPS() {
  if (!navigator.geolocation) throw new Error('Bu cihaz konum vermiyor');
  const pos = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, (e) => rej(new Error(e.code === 1 ? 'Konum izni verilmedi' : 'Konum alınamadı')), { enableHighAccuracy: false, timeout: 15000, maximumAge: 3600000 }));
  // Yaklaşık konum yeter: 2 ondalık (~1 km)
  const place = { lat: +pos.coords.latitude.toFixed(2), lon: +pos.coords.longitude.toFixed(2), name: 'Konumum' };
  await setMeta('place', place);
  await setMeta('weather', null);
  return place;
}

export async function setPlaceFromCity(city) {
  const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&language=tr&name=${encodeURIComponent(city)}`);
  const j = await r.json();
  const g = j.results?.[0];
  if (!g) throw new Error('Şehir bulunamadı');
  const place = { lat: +g.latitude.toFixed(2), lon: +g.longitude.toFixed(2), name: g.name };
  await setMeta('place', place);
  await setMeta('weather', null);
  return place;
}

export async function getWeather(force = false) {
  const place = await getPlace();
  if (!place) return null;
  const cached = await getMeta('weather');
  if (!force && cached && Date.now() - cached.at < 60 * 60 * 1000 && cached.lat === place.lat && cached.lon === place.lon) return cached;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&timezone=auto&forecast_days=1`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('Hava durumu alınamadı');
  const j = await r.json();
  const w = {
    at: Date.now(), lat: place.lat, lon: place.lon, place: place.name,
    now: Math.round(j.current?.temperature_2m), max: Math.round(j.daily?.temperature_2m_max?.[0]),
    min: Math.round(j.daily?.temperature_2m_min?.[0]), rain: j.daily?.precipitation_probability_max?.[0] ?? null,
    code: j.daily?.weather_code?.[0] ?? j.current?.weather_code
  };
  await setMeta('weather', w);
  return w;
}

// Yapay zekâya giden kısa hava notu (şehir adı gönderilmez)
export function weatherNote(w) {
  if (!w) return '';
  const d = describeCode(w.code).text.toLocaleLowerCase('tr');
  let s = `en yüksek ${w.max}°C, en düşük ${w.min}°C, ${d}`;
  if (w.rain != null) s += `, yağış ihtimali %${w.rain}`;
  return s;
}

export function seasonFromWeather(w) {
  if (!w) return '';
  if (w.max >= 24) return 'Yaz';
  if (w.max <= 10) return 'Kış';
  return 'İlkbahar/Sonbahar';
}
