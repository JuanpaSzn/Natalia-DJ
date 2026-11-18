/* Natalia DJ — web app personal que conversa contigo y pone música en tu Spotify.
 * Todo corre en tu teléfono, sin IA externa: entiende tu pedido al instante y arma sesiones de un solo género.
 */
'use strict';

// ---------- Configuración y almacenamiento ----------
const SCOPES = [
  'user-top-read', 'user-read-recently-played', 'user-library-read', 'user-library-modify',
  'user-read-playback-state', 'user-modify-playback-state', 'user-read-currently-playing',
  'playlist-modify-private', 'playlist-modify-public',
].join(' ');
const DEFAULT_COUNT = 25;
// Dirección fija de Natalia (siempre igual, aunque abras la app desde otro enlace o desde index.html).
const REDIRECT_URI = location.hostname === 'juanpaszn.github.io' ? 'https://juanpaszn.github.io/Natalia-DJ/' : location.origin + location.pathname.replace(/index\.html$/, '');

const DEFAULT_CLIENT_ID = '14ae18a9acca4246a56e7331a962edd5';
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem('sofia.' + key); return v === null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('sofia.' + key, JSON.stringify(value)); } catch { /* sin espacio o bloqueado */ }
  },
  del(key) { try { localStorage.removeItem('sofia.' + key); } catch { /* nada */ } },
};

// v12: Natalia usa su propio Client ID. Una sola vez: cambia el ID, borra la conexión vieja y los bloqueos viejos.
if (store.get('appName', '') !== 'natalia') {
  store.set('clientId', DEFAULT_CLIENT_ID);
  ['token', 'searchBlockedUntil', 'apilog'].forEach((k) => store.del(k));
  store.set('limitGuess', 12);
  store.set('appName', 'natalia');
}

const settings = () => ({
  clientId: store.get('clientId', DEFAULT_CLIENT_ID),
  count: (() => { const c = Number(store.get('count', DEFAULT_COUNT)) || DEFAULT_COUNT; return c === 15 ? DEFAULT_COUNT : c; })(),
});

const memory = () => store.get('memory', { suggested: [], loved: [], disliked: [] });
const saveMemory = (m) => {
  m.suggested = m.suggested.slice(-2500);
  m.loved = m.loved.slice(-200);
  m.disliked = m.disliked.slice(-200);
  store.set('memory', m);
};

// ---------- Utilidades de interfaz ----------
const $ = (id) => document.getElementById(id);
const messagesEl = $('messages');

function addMessage(kind, text) {
  const div = document.createElement('div');
  div.className = 'msg ' + kind;
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function chatHistory() { return store.get('chat', []); }
function pushHistory(role, text) {
  const h = chatHistory();
  h.push({ role, text: String(text).slice(0, 800) });
  store.set('chat', h.slice(-12));
}

function showSetup(show) {
  $('setup').classList.toggle('hidden', !show);
  document.body.classList.toggle('setup-open', show);
  $('redirectHint').textContent = REDIRECT_URI;
}

// ---------- Spotify: inicio de sesión (PKCE, sin servidor) ----------
function randomString(len) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}
async function sha256base64url(text) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function login() {
  const { clientId } = settings();
  if (!clientId) { addMessage('error', 'Primero pega tu Client ID de Spotify y toca Guardar.'); return; }
  const verifier = randomString(64);
  const challenge = await sha256base64url(verifier);
  // El verificador viaja dentro de "state" para que el regreso funcione aunque el iPhone
  // abra el regreso en otra ventana.
  const state = verifier + '.' + clientId;
  const params = new URLSearchParams({
    response_type: 'code', client_id: clientId, scope: SCOPES,
    code_challenge_method: 'S256', code_challenge: challenge,
    redirect_uri: REDIRECT_URI, state,
  });
  addMessage('sofia', `Conectando… Spotify debe tener EXACTAMENTE esta Redirect URI:\n${REDIRECT_URI}`);
  setTimeout(() => { location.href = 'https://accounts.spotify.com/authorize?' + params; }, 1200);
}

async function tokenRequest(body) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.error || ('Spotify respondió ' + res.status));
  const prev = store.get('token', {});
  const token = {
    access: data.access_token,
    refresh: data.refresh_token || prev.refresh,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
  store.set('token', token);
  return token;
}

async function handleRedirect() {
  const url = new URL(location.href);
  const code = url.searchParams.get('code');
  const err = url.searchParams.get('error');
  if (!code && !err) return false;
  history.replaceState(null, '', REDIRECT_URI);
  if (err) { addMessage('error', 'Spotify no dio permiso: ' + err); return true; }
  const state = url.searchParams.get('state') || '';
  const [verifier, stateClientId] = state.split('.');
  if (stateClientId && !settings().clientId) store.set('clientId', stateClientId);
  try {
    await tokenRequest({
      grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI,
      client_id: settings().clientId, code_verifier: verifier,
    });
    addMessage('sofia', '¡Listo, ya estoy conectada a tu Spotify! Déjame conocer tus gustos un momento…');
    await loadProfile(true);
  } catch (e) {
    addMessage('error', 'No pude terminar la conexión con Spotify: ' + e.message);
  }
  return true;
}

async function getAccessToken() {
  const t = store.get('token', null);
  if (!t || !t.refresh) throw new Error('NO_LOGIN');
  if (t.access && Date.now() < t.expiresAt) return t.access;
  const fresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: settings().clientId });
  return fresh.access;
}

// Máximo 3 peticiones a la vez a Spotify. Si Spotify pide pausa, no se le insiste.
let inFlight = 0;
const waiting = [];
let pausedUntil = 0;
let searchBlockedUntil = Number(store.get('searchBlockedUntil', 0)) || 0;
const searchBlocked = () => searchBlockedUntil > Date.now();
async function slot() {
  if (inFlight >= 3) await new Promise((r) => waiting.push(r));
  inFlight++;
}
function release() { inFlight--; const next = waiting.shift(); if (next) next(); }

// Registro de cada llamada a Spotify (para el modo diagnóstico: toca 5 veces el logo "N").
const apiLog = store.get('apilog', []);
let apiLogDirty = false;
function logCall(method, path, query, status, retryAfter, ms) {
  apiLog.push({ t: Date.now(), m: method, p: path + (query && query.q ? ' ' + String(query.q).slice(0, 40) : '') + (query && query.offset ? ' @' + query.offset : ''), s: status, ra: retryAfter || 0, ms, v: VERSION });
  if (apiLog.length > 300) apiLog.splice(0, apiLog.length - 300);
  if (!apiLogDirty) { apiLogDirty = true; setTimeout(() => { apiLogDirty = false; store.set('apilog', apiLog); }, 2000); }
}
const callsSince = (ms) => apiLog.filter((x) => x.t > Date.now() - ms).length;
// Natalia aprende cuántas llamadas aguanta Spotify en 30 s y nunca se pasa (deja 2 libres para reproducir).
let limitGuess = Number(store.get('limitGuess', 12)) || 12;
function growLimit() {
  const recent429 = apiLog.some((x) => x.s === 429 && x.t > Date.now() - 30 * 60000);
  if (!recent429 && limitGuess < 25 && Math.random() < 0.25) { limitGuess++; store.set('limitGuess', limitGuess); }
}
const budgetLeft = () => limitGuess - 2 - callsSince(30000);

async function sp(path, opts = {}, retried = false) {
  const left = pausedUntil - Date.now();
  if (left > 0) {
    const e = new Error('Spotify pidió una pausa'); e.status = 429; e.retryAfter = Math.ceil(left / 1000); throw e;
  }
  await slot();
  try { return await spRaw(path, opts, retried); } finally { release(); }
}

async function spRaw(path, { method = 'GET', body, query } = {}, retried = false) {
  const token = await getAccessToken();
  const url = new URL('https://api.spotify.com/v1' + path);
  if (query) Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, v));
  const t0 = Date.now();
  const res = await fetch(url, {
    method,
    headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  logCall(method, path, query, res.status, res.headers.get('Retry-After'), Date.now() - t0);
  if (res.status === 401 && !retried) {
    const t = store.get('token', {}); t.expiresAt = 0; store.set('token', t);
    return spRaw(path, { method, body, query }, true);
  }
  if (res.status === 429) {
    const secs = Number(res.headers.get('Retry-After')) || 3;
    let reason = '';
    try { const j = await res.json(); reason = (j && j.error && j.error.reason) || (j && j.reason) || ''; } catch { /* sin cuerpo */ }
    if (apiLog.length) apiLog[apiLog.length - 1].r = reason;
    if (path === '/search') {
      // Spotify tiene un cupo aparte para búsquedas. Si se acaba, dejo de buscar un rato y uso otros caminos.
      const recent = apiLog.filter((x) => x.s === 429 && x.p.startsWith('/search') && x.t > Date.now() - 120000).length;
      const mins = reason === 'QUOTA_EXCEEDED' ? 60 : recent >= 2 ? 15 : 0;
      searchBlockedUntil = Math.max(searchBlockedUntil, Date.now() + (mins ? mins * 60000 : secs * 1000));
      store.set('searchBlockedUntil', searchBlockedUntil);
      store.set('searchBlockInfo', { at: Date.now(), reason: reason || '(sin motivo)', secs, client: String(settings().clientId).slice(-4), ver: VERSION });
    } else {
      pausedUntil = Math.max(pausedUntil, Date.now() + secs * 1000);
      limitGuess = Math.max(5, Math.min(limitGuess, callsSince(30000) - 1));
      store.set('limitGuess', limitGuess);
    }
    const e = new Error('Spotify pidió una pausa'); e.status = 429; e.retryAfter = secs; e.reason = reason; e.search = path === '/search'; throw e;
  }
  if (res.status === 204) return null;
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const e = new Error((data && data.error && data.error.message) || ('Spotify respondió ' + res.status));
    e.status = res.status;
    e.reason = data && data.error && data.error.reason;
    throw e;
  }
  return data;
}

// ---------- Perfil musical ----------
// Lee tus artistas (con sus géneros) y tus canciones, y los agrupa por género.
async function loadProfile(force, silent) {
  const cached = store.get('profile2', null);
  if (!force && cached && Date.now() - cached.at < 12 * 3600 * 1000) return cached;
  const calls = await Promise.allSettled([
    sp('/me/top/artists', { query: { time_range: 'medium_term', limit: 50 } }),
    Promise.resolve(null),
    sp('/me/top/artists', { query: { time_range: 'short_term', limit: 50 } }),
    sp('/me/top/tracks', { query: { time_range: 'short_term', limit: 50 } }),
    Promise.resolve(null),
    sp('/me/tracks', { query: { limit: 50 } }),
    sp('/me/player/recently-played', { query: { limit: 50 } }),
  ]);
  const val = (i) => (calls[i].status === 'fulfilled' && calls[i].value && calls[i].value.items) || [];
  const artists = {};
  [0, 1, 2].forEach((i) => val(i).forEach((a, rank) => {
    const prev = artists[a.id] || { id: a.id, name: a.name, genres: a.genres || [], score: 0 };
    prev.score += 50 - rank;
    artists[a.id] = prev;
  }));
  const tracks = {};
  const addTrack = (t, w) => {
    if (!t || !t.uri || t.is_local) return;
    const prev = tracks[t.uri] || simplify(t);
    prev.score = (prev.score || 0) + w;
    tracks[t.uri] = prev;
  };
  val(3).forEach((t, r) => addTrack(t, 60 - r));
  val(4).forEach((t, r) => addTrack(t, 50 - r));
  val(5).forEach((i) => addTrack(i.track, 20));
  val(6).forEach((i) => addTrack(i.track, 10));
  Object.values(artists).forEach((a) => rememberGenres(a.id, a.genres));
  if (!store.get('organizer', null)) store.set('likedUris', val(5).map((i) => i.track && i.track.uri).filter(Boolean));
  const genreScore = {};
  Object.values(artists).forEach((a) => a.genres.forEach((g) => { genreScore[g] = (genreScore[g] || 0) + a.score; }));
  const profile = {
    at: Date.now(),
    artists: Object.values(artists).sort((a, b) => b.score - a.score),
    tracks: Object.values(tracks).sort((a, b) => b.score - a.score),
    genres: Object.entries(genreScore).sort((a, b) => b[1] - a[1]).map(([g]) => g),
  };
  classifyProfile(profile);
  store.set('profile2', profile);
  if (force && !silent) {
    const sum = tasteSummary(profile);
    addMessage('sofia', sum ? `Ya leí tus gustos. Lo que más escuchas:\n${sum}\n\n¿Qué te pongo?` : 'Ya estoy conectada, pero Spotify casi no me dio datos de lo que escuchas. Pídeme algo y voy aprendiendo con tus ❤.');
  }
  return profile;
}

function simplify(t) {
  return {
    uri: t.uri,
    id: t.id,
    name: t.name,
    artistIds: (t.artists || []).map((a) => a.id),
    artists: (t.artists || []).map((a) => a.name),
    year: Number(String((t.album && t.album.release_date) || '').slice(0, 4)) || 0,
    img: (t.album && t.album.images && (t.album.images[t.album.images.length - 1] || {}).url) || '',
  };
}
const labelOf = (t) => `${t.artists.join(', ')} - ${t.name}`;

// ---------- Intérprete propio (instantáneo, sin IA) ----------
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9& ]/g, ' ').replace(/\s+/g, ' ').trim();

// Géneros que entiende Natalia. "genres" son los nombres que usa Spotify (el primero es el principal),
// "fam" agrupa géneros parecidos y "pl" es el nombre de la playlist cuando organiza tus Me gusta.
// Van de lo más específico a lo más general.
const GENRE_ALIASES = [
  { re: /corridos? belic(o|os|on|ones|ote|otes)|belic(o|os|on|ones)|belikon\w*/, label: 'corridos bélicos', genres: ['corridos belicos', 'corrido'], fam: 'mexicano', pl: 'Corridos' },
  { re: /corridos? tumbados?|tumbados?/, label: 'corridos tumbados', genres: ['corridos tumbados', 'corrido'], fam: 'mexicano', pl: 'Corridos' },
  { re: /corridos?/, label: 'corridos', genres: ['corridos tumbados', 'corrido', 'corridos belicos'], fam: 'mexicano', pl: 'Corridos' },
  { re: /sierren[oa]s?/, label: 'sierreño', genres: ['sierreno'], fam: 'mexicano', pl: 'Corridos' },
  { re: /regional mexicano|musica mexicana|banda|nortenas?|norteno|mariachi|rancheras?/, label: 'regional mexicano', genres: ['musica mexicana', 'banda', 'norteno', 'ranchera'], fam: 'mexicano', pl: 'Regional mexicano' },
  { re: /regg?a?e?ton|regueton|perreo/, label: 'reguetón', genres: ['reggaeton', 'urbano latino', 'perreo'], fam: 'urbano', pl: 'Reguetón' },
  { re: /dembow/, label: 'dembow', genres: ['dembow'], fam: 'dembow', pl: 'Dembow' },
  { re: /trap latino|latin trap|trap/, label: 'trap latino', genres: ['trap latino', 'latin trap'], fam: 'urbano', pl: 'Trap latino' },
  { re: /\bdrill\b/, label: 'drill', genres: ['drill', 'uk drill'], fam: 'rap', pl: 'Rap y drill' },
  { re: /rap (en )?espanol|rap latino|hip hop latino|rap colombiano/, label: 'rap en español', genres: ['latin hip hop', 'rap latina', 'rap colombiano'], fam: 'rap', pl: 'Rap en español' },
  { re: /\brap\b|hip ?hop/, label: 'rap', genres: ['hip hop', 'rap'], fam: 'rap', pl: 'Rap' },
  { re: /\br ?(&|and|y)? ?b\b|rnb/, label: 'R&B', genres: ['r&b', 'contemporary r&b'], fam: 'rnb', pl: 'R&B' },
  { re: /vallenatos?/, label: 'vallenato', genres: ['vallenato'], fam: 'tropical', pl: 'Vallenato' },
  { re: /champeta/, label: 'champeta', genres: ['champeta'], fam: 'tropical', pl: 'Champeta' },
  { re: /salsa/, label: 'salsa', genres: ['salsa', 'salsa colombiana'], fam: 'tropical', pl: 'Salsa' },
  { re: /bachata/, label: 'bachata', genres: ['bachata'], fam: 'tropical', pl: 'Bachata' },
  { re: /merengue/, label: 'merengue', genres: ['merengue'], fam: 'tropical', pl: 'Merengue' },
  { re: /cumbia/, label: 'cumbia', genres: ['cumbia', 'cumbia villera'], fam: 'tropical', pl: 'Cumbia' },
  { re: /\brkt\b|cachengue|cuarteto/, label: 'RKT', genres: ['rkt', 'cachengue', 'cuarteto'], fam: 'rkt', pl: 'RKT' },
  { re: /musica popular|despecho|guasca/, label: 'música popular', genres: ['musica popular colombiana', 'musica popular'], fam: 'popular', pl: 'Música popular' },
  { re: /cristian|worship|alabanza|adoracion|gospel|de dios/, label: 'música cristiana', genres: ['latin christian', 'latin worship', 'worship', 'christian'], fam: 'cristiana', pl: 'Cristiana' },
  { re: /hard ?techno|techno hard|schranz/, label: 'hard techno', genres: ['hard techno', 'schranz'], fam: 'techno', pl: 'Techno' },
  { re: /industrial/, label: 'industrial', genres: ['industrial techno', 'industrial'], fam: 'techno', pl: 'Techno' },
  { re: /techno/, label: 'techno', genres: ['techno', 'minimal techno'], fam: 'techno', pl: 'Techno' },
  { re: /afro ?house/, label: 'afro house', genres: ['afro house'], fam: 'house', pl: 'House' },
  { re: /\bhouse\b/, label: 'house', genres: ['house', 'tech house', 'deep house'], fam: 'house', pl: 'House' },
  { re: /drum (and|&|y|n) ?bass|\bdnb\b/, label: 'drum and bass', genres: ['drum and bass', 'liquid funk'], fam: 'dnb', pl: 'Drum and bass' },
  { re: /dubstep/, label: 'dubstep', genres: ['dubstep', 'riddim'], fam: 'edm', pl: 'Electrónica' },
  { re: /trance/, label: 'trance', genres: ['trance', 'progressive trance'], fam: 'edm', pl: 'Electrónica' },
  { re: /hardstyle/, label: 'hardstyle', genres: ['hardstyle'], fam: 'edm', pl: 'Electrónica' },
  { re: /phonk/, label: 'phonk', genres: ['phonk', 'drift phonk'], fam: 'phonk', pl: 'Phonk' },
  { re: /electronica|electro|\bedm\b/, label: 'electrónica', genres: ['edm', 'electro house', 'big room'], fam: 'edm', pl: 'Electrónica' },
  { re: /metalcore/, label: 'metalcore', genres: ['metalcore'], fam: 'metal', pl: 'Metal' },
  { re: /\bmetal\b/, label: 'metal', genres: ['metal', 'heavy metal', 'nu metal'], fam: 'metal', pl: 'Metal' },
  { re: /\bpunk\b/, label: 'punk', genres: ['punk', 'pop punk'], fam: 'rock', pl: 'Rock' },
  { re: /rock (en )?espanol|rock latino/, label: 'rock en español', genres: ['rock en espanol', 'latin rock'], fam: 'rock', pl: 'Rock en español' },
  { re: /\brock\b|grunge/, label: 'rock', genres: ['rock', 'alternative rock', 'classic rock'], fam: 'rock', pl: 'Rock' },
  { re: /\bindie\b/, label: 'indie', genres: ['indie', 'indie rock', 'indie pop'], fam: 'indie', pl: 'Indie' },
  { re: /baladas?|romantic/, label: 'baladas', genres: ['latin ballad', 'balada'], fam: 'pop', pl: 'Baladas' },
  { re: /pop latino/, label: 'pop latino', genres: ['latin pop'], fam: 'pop', pl: 'Pop latino' },
  { re: /k ?pop/, label: 'K-pop', genres: ['k-pop'], fam: 'kpop', pl: 'K-pop' },
  { re: /j ?pop|anime/, label: 'J-pop', genres: ['j-pop', 'anime'], fam: 'jpop', pl: 'J-pop' },
  { re: /\bpop\b/, label: 'pop', genres: ['pop', 'dance pop'], fam: 'pop', pl: 'Pop' },
  { re: /\bjazz\b/, label: 'jazz', genres: ['jazz', 'smooth jazz'], fam: 'jazz', pl: 'Jazz' },
  { re: /\bsoul\b|\bfunk\b(?! bra)/, label: 'soul y funk', genres: ['soul', 'funk', 'neo soul'], fam: 'soul', pl: 'Soul y funk' },
  { re: /\bblues\b/, label: 'blues', genres: ['blues'], fam: 'jazz', pl: 'Blues' },
  { re: /lo ?fi/, label: 'lo-fi', genres: ['lo-fi', 'lo-fi beats', 'chillhop'], fam: 'chill', pl: 'Lo-fi' },
  { re: /ambient|meditac|instrumental/, label: 'ambient', genres: ['ambient', 'new age'], fam: 'chill', pl: 'Ambient' },
  { re: /reggae\b|\bdub\b/, label: 'reggae', genres: ['reggae', 'roots reggae'], fam: 'reggae', pl: 'Reggae' },
  { re: /afro ?beats?|afrobeat|amapiano/, label: 'afrobeats', genres: ['afrobeats', 'amapiano'], fam: 'afro', pl: 'Afrobeats' },
  { re: /funk (brasil|carioca)|baile funk/, label: 'funk brasileño', genres: ['funk carioca', 'brazilian funk'], fam: 'brasil', pl: 'Funk brasileño' },
  { re: /bossa ?nova|samba/, label: 'bossa nova', genres: ['bossa nova', 'mpb'], fam: 'brasil', pl: 'Bossa nova' },
  { re: /country/, label: 'country', genres: ['country'], fam: 'country', pl: 'Country' },
  { re: /clasica|orquesta|piano clasico|opera/, label: 'música clásica', genres: ['classical', 'orchestra'], fam: 'clasica', pl: 'Clásica' },
  { re: /flamenco/, label: 'flamenco', genres: ['flamenco', 'nuevo flamenco'], fam: 'flamenco', pl: 'Flamenco' },
  { re: /tango/, label: 'tango', genres: ['tango'], fam: 'tango', pl: 'Tango' },
];
const aliasByLabel = (label) => GENRE_ALIASES.find((g) => g.label === label) || null;

// A qué género de Natalia pertenece un género de Spotify (por ejemplo "latin hip hop" -> rap en español).
function aliasOfSpotifyGenre(g) {
  const n = norm(g);
  return GENRE_ALIASES.find((a) => a.genres.includes(n) || a.genres.includes(g)) || GENRE_ALIASES.find((a) => a.re.test(n)) || null;
}
function aliasOfArtistGenres(genres) {
  for (const g of genres || []) { const a = aliasOfSpotifyGenre(g); if (a) return a; }
  return null;
}

// Países: los artistas que más suenan allá ahora, todos del mismo género.
const COUNTRIES = [
  { re: /colombia|colombian|medellin|bogota/, name: 'Colombia', market: 'CO', label: 'reguetón', artists: ['Karol G', 'Feid', 'Blessd', 'Ryan Castro', 'Maluma', 'J Balvin', 'Kapo', 'Beéle'] },
  { re: /puerto ?ric|boricua/, name: 'Puerto Rico', market: 'PR', label: 'reguetón', artists: ['Bad Bunny', 'Rauw Alejandro', 'Myke Towers', 'Jhayco', 'Young Miko', 'Arcángel', 'Ozuna', 'Anuel AA'] },
  { re: /mexic/, name: 'México', market: 'MX', label: 'corridos tumbados', artists: ['Natanael Cano', 'Peso Pluma', 'Fuerza Regida', 'Junior H', 'Tito Double P', 'Gabito Ballesteros', 'Luis R Conriquez', 'Xavi'] },
  { re: /dominican|santo domingo/, name: 'República Dominicana', market: 'DO', label: 'dembow', artists: ['El Alfa', 'Rochy RD', 'Bulin 47', 'Chimbala', 'Tokischa', 'Kiko El Crazy', 'Donaty', 'Yaisel LM'] },
  { re: /argentin/, name: 'Argentina', market: 'AR', label: 'trap argentino', artists: ['Duki', 'Milo J', 'Trueno', 'Tiago PZK', 'Nicki Nicole', 'Paulo Londra', 'LIT killah', 'YSY A'] },
  { re: /espana|madrid|barcelona/, name: 'España', market: 'ES', label: 'urbano español', artists: ['Quevedo', 'Saiko', 'Rels B', 'Bad Gyal', 'Morad', 'Beny Jr', 'Omar Montes', 'JC Reyes'] },
  { re: /estados unidos|gringo|usa\b|eeuu/, name: 'Estados Unidos', market: 'US', label: 'rap', artists: ['Kendrick Lamar', 'Drake', 'Travis Scott', 'Future', 'Doechii', 'Lil Baby', 'Tyler, The Creator', 'GloRilla'] },
];

// Música de motivación de verdad (estilo Eminem). Todas son rap, para que la cola no cambie de género.
const MOTIVATION = [
  ['Lose Yourself', 'Eminem'], ["'Till I Collapse", 'Eminem'], ['Not Afraid', 'Eminem'], ['Godzilla', 'Eminem'],
  ['Phenomenal', 'Eminem'], ['Survival', 'Eminem'], ['Cinderella Man', 'Eminem'], ['Without Me', 'Eminem'],
  ['Rap God', 'Eminem'], ['Venom', 'Eminem'], ['Remember the Name', 'Fort Minor'], ['Stronger', 'Kanye West'],
  ['POWER', 'Kanye West'], ["Can't Hold Us", 'Macklemore'], ['In Da Club', '50 Cent'], ['Many Men', '50 Cent'],
  ["X Gon' Give It To Ya", 'DMX'], ['Party Up', 'DMX'], ["Can't Be Touched", 'Roy Jones Jr.'],
  ['Started From the Bottom', 'Drake'], ['HUMBLE.', 'Kendrick Lamar'], ['DNA.', 'Kendrick Lamar'],
  ['SICKO MODE', 'Travis Scott'], ['Numb / Encore', 'JAY-Z'], ['Run This Town', 'JAY-Z'],
  ['Forgot About Dre', 'Dr. Dre'], ['Still D.R.E.', 'Dr. Dre'], ['Mo Bamba', 'Sheck Wes'],
  ['Hustlin', 'Rick Ross'], ['Hall of Fame', 'The Script'], ['Kill Shot', 'Eminem'], ['Berzerk', 'Eminem'],
];

const RX = {
  fresh: /moda|nuev[oa]s?|tendenc|reciente|estren|actual|del momento|pegando|viral|lanzamient|estos dias|esta semana/,
  old: /viej[oa]s?|viejitas?|antigu[oa]s?|clasic(?!a)|de antes|old school|ochenter|noventer|dosmiler/,
  newGenre: /genero nuevo|nuevo genero|otro genero|genero distinto|genero diferente|generos? que no|algo totalmente (nuevo|distinto)/,
  discover: /descubr|sorprend|nunca|no conozco|no haya escuchado|algo distinto/,
  likes: /mis gustos|que me gust|lo que me gusta|mis favorit|mi musica|lo de siempre/,
  relax: /relaj|tranquil|calm|dormir|descansar|suave|chill|estudiar|concentr/,
  motiv: /motiv|gym|gimnasio|entren|ejercicio|pesas|correr|animo|echarle ganas|dar todo/,
  similar: /parecid|similar|como (a )?|estilo de|tipo /,
  deep: /menos (escuchad|conocid|famos|sonad|popular|pegad)|rarezas|no tan (conocid|famos|sonad|pegad)|joyitas?|joyas|underrated|ocultas|casi nadie|poca gente|pocos (han )?escuch|poco (escuchad|conocid|sonad)|nadie conoce|b ?sides/,
  fav: /me encanta|me gusta mucho|me fascina|la amo|lo amo|los amo|amo a|favorit|la mejor|el mejor|me mata|la rompe|lo rompe/,
  popular: /popular|famos|exitos|hits|mejores|mas escuchad|mas sonad|pegadit|pegad[oa]s|temazos|\btop\b/,
  country: /que se escucha|escuchando en|suena en|sonando en|pegado en|top (de )?|en colombia|en puerto|en mexico|en espana|en argentina|en republica|en estados/,
  organize: /(organiz|orden|clasific|divid|separ|acomod)\w*.*(me gusta|megusta|favorit|likes|gustad|guardad|biblioteca)/,
};
const COMMANDS = [
  { re: /^(siguiente|la siguiente|salta(la)?|pasa(la)?|next|otra cancion|cambia(la)?)$/, run: () => sp('/me/player/next', { method: 'POST' }), say: 'Va la siguiente.' },
  { re: /^(pausa|pausala|para|para la musica|deten(la)?|stop|callate)$/, run: () => sp('/me/player/pause', { method: 'PUT' }), say: 'En pausa.' },
  { re: /^(sigue|continua|play|dale play|reanuda)$/, run: () => sp('/me/player/play', { method: 'PUT' }), say: 'Seguimos.' },
  { re: /^(me gusta esta|me encanta esta|guardala|guarda esta|me gusto|me encanto)$/, run: () => rate(true), say: '' },
  { re: /^(no me gusta|no me gusta esta|quita esta|quitala|esta no|no me gusto)$/, run: () => rate(false), say: '' },
];
const FILLER = /\b(parce|parcero|parcera|mano|bro|llave|pana|pa|socio|hermano|rolas?|rolitas?|temazos?|temitas?|cancioncitas?|chimba|bacan[oa]s?|melo|ome|pues|vea|mijo|mija|nea|pero|sean|sea|casi|nadie|haya|hayan|escuchado|conocido|gente|poca|pocos|porfis|plis|please|sofia|sofi|ve|oye|hola|por favor|porfa|ponme|pon|ponga|pongas|reproduce|reproducir|quiero|quisiera|escuchar|oir|un|una|unos|unas|tema|temas|cancion|canciones|musica|de|del|la|el|los|las|algo|me|mi|mis|que|y|en|con|a|al|hoy|ahora|solo|puro|pura|puros|full|mas|otra|otras|otro|otros|bien|tipo|artistas?|parecid[oa]s?|similares?|estilo|como|recomiendame|recomienda|recomendar|dame|music|gente|esta|estan|estos|dias|escuchando|escucha|suena|sonando|pais)\b/g;
const STOP_STEM = /^(moda|nuev|tendenc|recient|estren|actual|momento|pegand|viral|lanzamient|viej|antigu|clasic|descubr|sorprend|nunca|conozc|escuchad|distint|genero|gust|favorit|relaj|tranquil|dormir|descans|motiv|energ|entren|ejercic|fiesta|rumba|prend|parche|parecid|similar|estilo|recomiend|ingles|espanol|siempre|sesion|playlist|ponme|sofia|gimnas|concentr|estudi|semana|escuch|oig)/;
const STOP_EXACT = new Set(['pon', 'no', 'nada', 'todo', 'esa', 'eso', 'este', 'lo', 'le', 'se', 'su', 'sus', 'para', 'haya', 'antes', 'old', 'school', 'dj', 'lista', 'calma', 'calmada', 'suave', 'chill', 'gym', 'activa', 'activo', 'activarme', 'totalmente', 'diferente', 'gym', 'pesas', 'correr', 'animo', 'top', 'he', 'ha', 'has', 'yo', 'ya', 'menos', 'rarezas', 'joyitas', 'ocultas', 'populares', 'popular', 'famosas', 'famosos', 'exitos', 'hits', 'mejores', 'sonadas', 'conocidas', 'joyas', 'joyita', 'joyitas', 'unas', 'bueno', 'buenas', 'buenos', 'chimbas', 'duro', 'durisimo', 'brutal', 'es', 'son', 'era', 'cantante', 'cantantes', 'artista', 'favorita', 'favorito', 'favoritas', 'favoritos', 'encanta', 'fascina', 'amo', 'mata', 'rompe', 'mucho', 'mejor', 'banda', 'grupo']);

// Quita las palabras de relleno pero deja los artículos que son parte del nombre:
// "quiero escuchar de la rose" -> "la rose", "pon el alfa" -> "el alfa", "los tigres del norte".
const FILLER_WORD = new RegExp('^(?:' + FILLER.source + ')$');
function cleanPart(p) {
  const words = p.replace(/por favor|de verdad/g, ' ').split(' ').filter(Boolean);
  const isContent = (w) => w && !FILLER_WORD.test(w) && !STOP_EXACT.has(w) && !STOP_STEM.test(w);
  const keep = words.map(isContent);
  for (let i = words.length - 2; i >= 0; i--) {
    const w = words[i];
    if (keep[i] || !keep[i + 1]) continue;
    if (/^(la|el|los|las|lo)$/.test(w)) keep[i] = true;
    else if (/^(de|del)$/.test(w) && i > 0 && keep[i - 1]) keep[i] = true;
  }
  return words.filter((w, i) => keep[i]).join(' ');
}

// El género solo cuenta si la palabra termina ahí ("corridos belicones" no es "corridos belico" + "nes").
const ALIAS_RX = new Map(GENRE_ALIASES.map((g) => [g, new RegExp('(?:' + g.re.source + ')(?![a-z])')]));
function interpret(text) {
  const t = norm(text);
  let genre = null;
  let rest = t;
  for (const g of GENRE_ALIASES) {
    const rx = ALIAS_RX.get(g);
    if (rx.test(t)) { genre = g; rest = rest.replace(rx, ' '); break; }
  }
  const country = COUNTRIES.find((c) => c.re.test(t)) || null;
  if (country) rest = rest.replace(country.re, ' ');
  const mode = {};
  Object.keys(RX).forEach((k) => { mode[k] = RX[k].test(t); });
  if (mode.newGenre) mode.discover = true;
  if (mode.deep) mode.popular = false;
  mode.raw = t;
  // Varios artistas: "Luis R Conriquez y Natanael Cano", "Feid, Blessd".
  const parts = rest.replace(/ (y|e|and|junto con|con|mezclado con|mezcla de) |,/g, ' | ').split('|')
    .map(cleanPart)
    .filter((p) => p.length >= 2);
  rest = parts.join(' ');
  const artistQuery = rest.length >= 2 && !mode.likes ? rest : '';
  return { t, genre, mode, country, artistQuery, artistParts: mode.likes ? [] : parts };
}

const yearFilter = (mode) => {
  const y = new Date().getFullYear();
  if (mode.fresh) return ` year:${y - 1}-${y}`;
  if (mode.old) return ' year:1990-2012';
  return '';
};

// Búsqueda a prueba de fallos: si Spotify rechaza una forma de preguntar, prueba otra más simple
// y recuerda cuál funcionó. Guarda el último error real para mostrártelo.
let searchShape = 0;
let lastSearchError = null;
async function spSearch(q, type, offset, market) {
  if (searchBlocked()) { const e = new Error('SEARCH_BLOCKED'); e.status = 429; e.search = true; lastSearchError = e; return null; }
  const shapes = [
    { q, type, limit: 10, offset, market: market || 'from_token' },
    { q, type, limit: 10, offset, ...(market && market !== 'from_token' ? { market } : {}) },
    { q, type, limit: 5 },
  ];
  for (let i = searchShape; i < shapes.length; i++) {
    try {
      const r = await sp('/search', { query: shapes[i] });
      if (i > searchShape) searchShape = i;
      lastSearchError = null;
      return r;
    } catch (e) {
      lastSearchError = e;
      if (e.message === 'NO_LOGIN' || e.status === 401 || e.status === 429) break;
    }
  }
  return null;
}

// Memoria de búsquedas en el teléfono: lo que ya se buscó hoy sale al instante, sin preguntarle a Spotify.
const CACHE_MAX = 250;
const memCache = { t: store.get('tcache', {}), a: store.get('acache', {}), b: store.get('bcache', {}) };
let cacheDirty = false;
function cacheGet(kind, key, ttl) {
  const e = memCache[kind][key];
  return e && Date.now() - e.at < ttl ? e.v : null;
}
function cachePut(kind, key, v) {
  const c = memCache[kind];
  c[key] = { at: Date.now(), v };
  const keys = Object.keys(c);
  if (keys.length > CACHE_MAX) keys.sort((x, y) => c[x].at - c[y].at).slice(0, keys.length - CACHE_MAX).forEach((k) => delete c[k]);
  if (!cacheDirty) { cacheDirty = true; setTimeout(() => { cacheDirty = false; store.set('tcache', memCache.t); store.set('acache', memCache.a); store.set('bcache', memCache.b); }, 1500); }
}

const tKey = (q, offset, market) => `${q}|${offset}|${market || ''}`;
async function searchTracks(q, offset = 0, market) {
  const key = tKey(q, offset, market);
  const hit = cacheGet('t', key, 12 * 3600 * 1000);
  if (hit) return hit;
  const r = await spSearch(q, 'track', offset, market);
  const out = ((r && r.tracks && r.tracks.items) || []).filter(Boolean).map(simplify);
  if (r) cachePut('t', key, out);
  return out;
}

// Artistas que Natalia ya conoce (con su id de Spotify): de tus gustos, tus favoritos y todo lo ya buscado.
function artistIndex() {
  const idx = {};
  const add = (name, id) => { if (name && id && !idx[norm(name)]) idx[norm(name)] = { id, name }; };
  const profile = store.get('profile2', null);
  if (profile) {
    profile.artists.forEach((a) => add(a.name, a.id));
    profile.tracks.forEach((t) => t.artists.forEach((n, i) => add(n, t.artistIds[i])));
  }
  Object.entries(memory().fav || {}).forEach(([id, f]) => add(f.name, id));
  Object.values(memCache.a).forEach((e) => e.v && add(e.v.name, e.v.id));
  Object.values(memCache.t).forEach((e) => (e.v || []).forEach((t) => t.artists.forEach((n, i) => add(n, t.artistIds[i]))));
  return idx;
}
function knownArtist(name) {
  const n = norm(name);
  const idx = artistIndex();
  if (idx[n]) return idx[n];
  let best = null; let bestSim = 0;
  Object.entries(idx).forEach(([k, v]) => { const sim = similarity(k, n); if (sim > bestSim) { bestSim = sim; best = v; } });
  return bestSim >= 0.8 ? best : null;
}

// Canciones de un artista SIN usar la búsqueda: sus álbumes más recientes (otro cupo de Spotify).
async function artistTracksById(a, { deep } = {}) {
  let albums = cacheGet('b', 'al:' + a.id, 7 * 24 * 3600 * 1000);
  if (!albums) {
    const r = await sp(`/artists/${a.id}/albums`, { query: { include_groups: 'album,single', limit: 10 } });
    albums = ((r && r.items) || []).filter(Boolean).map((x) => ({ id: x.id, type: x.album_type, date: x.release_date || '', img: ((x.images || [])[x.images.length - 1] || {}).url || '' }));
    cachePut('b', 'al:' + a.id, albums);
  }
  const sorted = albums.slice().sort((x, y) => (y.date > x.date ? 1 : -1));
  const full = sorted.filter((x) => x.type === 'album');
  const pick = deep ? shuffle(full.length ? full : sorted).slice(0, 2)
    : [...new Set([sorted[0], full[0], shuffle(sorted)[0]].filter(Boolean))].slice(0, 2);
  const lists = await Promise.all(pick.map(async (al) => {
    const hit = cacheGet('b', 'tr:' + al.id, 30 * 24 * 3600 * 1000);
    if (hit) return hit;
    try {
      const d = await sp(`/albums/${al.id}`);
      const items = ((d && d.tracks && d.tracks.items) || []).filter((t) => t && t.uri).map((t) => ({
        uri: t.uri, id: t.id, name: t.name,
        artistIds: (t.artists || []).map((x) => x.id), artists: (t.artists || []).map((x) => x.name),
        year: Number(String(al.date).slice(0, 4)) || 0, img: al.img,
      }));
      cachePut('b', 'tr:' + al.id, items);
      return items;
    } catch { return []; }
  }));
  return lists.flat().filter((t) => t.artistIds.includes(a.id));
}

// Una sola búsqueda trae al artista y sus canciones más populares a la vez.
// Si ya lo conozco (está en tus gustos o ya lo busqué), ni siquiera busco.
async function findArtist(name) {
  const n = norm(name);
  const hit = cacheGet('a', n, 7 * 24 * 3600 * 1000);
  if (hit) return { ...hit };
  const known = knownArtist(name);
  if (known) return { id: known.id, name: known.name, genres: [], exact: true, sim: 1, tracks: [] };
  try {
    const r = await spSearch(name, 'artist,track', 0);
    const items = ((r && r.artists && r.artists.items) || []).filter(Boolean);
    const exact = items.find((a) => norm(a.name) === n);
    const close = items.find((a) => norm(a.name).startsWith(n) || n.startsWith(norm(a.name)))
      || items.find((a) => similarity(norm(a.name), n) >= 0.75);
    const raw = exact || close || items[0] || null;
    if (!raw) return null;
    rememberGenres(raw.id, raw.genres);
    const tracks = ((r && r.tracks && r.tracks.items) || []).filter(Boolean).map(simplify).filter((t) => t.artistIds.includes(raw.id));
    const best = { id: raw.id, name: raw.name, genres: raw.genres || [], exact: !!(exact || close), sim: similarity(norm(raw.name), n), tracks };
    cachePut('a', n, best);
    return best;
  } catch { return null; }
}

// Parecido entre dos textos (0 a 1), para entender nombres mal escritos: "Naranel Cano" = Natanael Cano.
function similarity(a, b) {
  if (!a || !b) return 0;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return 1 - d[a.length][b.length] / Math.max(a.length, b.length);
}

// Junta varias búsquedas en paralelo (todas a la vez: así tarda lo que tarda la más lenta).
// Todo lo que ya está guardado en el teléfono para una búsqueda (gratis: no le pregunta a Spotify).
function cachedFor(prefix) {
  const out = [];
  Object.entries(memCache.t).forEach(([k, e]) => { if (k.startsWith(prefix) && Date.now() - e.at < 3 * 24 * 3600 * 1000) out.push(...e.v); });
  return out;
}

// Junta búsquedas en paralelo. Las primeras "required" siempre se hacen; las demás solo si ya están
// guardadas en el teléfono o si queda margen con Spotify (así nunca nos frena).
function gather(queries, market, required = queries.length) {
  let budget = budgetLeft();
  return Promise.all(queries.map(([q, off], i) => {
    if (cacheGet('t', tKey(q, off, market), 12 * 3600 * 1000)) return searchTracks(q, off, market);
    if (i < required || budget > 0) { budget--; return searchTracks(q, off, market); }
    return Promise.resolve([]);
  }));
}

// Ordena como DJ: sin repetir canción, sin el mismo artista seguido.
function arrange(groups, count, avoid) {
  const seenUri = new Set();
  const seenName = new Set();
  const pools = groups.map((g) => g.filter((t) => {
    const key = norm(t.name).replace(/\b(remix|en vivo|live|version|remasterizado|remaster|feat|ft)\b.*$/, '').trim() + '|' + norm(t.artists[0]);
    if (seenUri.has(t.uri) || seenName.has(key) || avoid.uris.has(t.uri) || t.artistIds.some((id) => avoid.artists.has(id))) return false;
    seenUri.add(t.uri); seenName.add(key); return true;
  }));
  const out = [];
  let lastArtist = '';
  let guard = 0;
  while (out.length < count && pools.some((p) => p.length) && guard++ < 500) {
    for (const p of pools) {
      if (!p.length || out.length >= count) continue;
      let i = p.findIndex((t) => t.artists[0] !== lastArtist);
      if (i < 0) i = 0;
      const [t] = p.splice(i, 1);
      out.push(t);
      lastArtist = t.artists[0];
    }
  }
  return out;
}

const shuffle = (a) => a.map((x) => [Math.random(), x]).sort((p, q) => p[0] - q[0]).map((p) => p[1]);
const rnd = (n) => Math.floor(Math.random() * n);
function pickByWeight(items) {
  const total = items.reduce((s, x) => s + x.w, 0);
  if (!total) return null;
  let r = Math.random() * total;
  for (const x of items) { r -= x.w; if (r <= 0) return x.v; }
  return items[items.length - 1].v;
}

// Géneros de artistas que Natalia ya conoce (para clasificar y aprender sin volver a preguntarle a Spotify).
function rememberGenres(id, genres) {
  if (!id || !genres || !genres.length) return;
  const c = store.get('artistGenres', {});
  c[id] = genres.slice(0, 6);
  const keys = Object.keys(c);
  if (keys.length > 3000) keys.slice(0, keys.length - 3000).forEach((k) => delete c[k]);
  store.set('artistGenres', c);
}

// ---------- Tus gustos: a qué género pertenece cada artista ----------
// Spotify ya no dice el género de los artistas, así que Natalia lo averigua con:
// 1) esta lista de artistas conocidos, 2) lo que aprende de cada búsqueda por género,
// 3) con quién colaboran tus artistas, y 4) preguntándole a Spotify por género (una sola vez).
const ARTIST_SEEDS = {
  'corridos tumbados': ['Natanael Cano', 'Peso Pluma', 'Junior H', 'Fuerza Regida', 'Gabito Ballesteros', 'Tito Double P', 'Xavi', 'Ivan Cornejo', 'Eslabon Armado', 'Oscar Maydon', 'Chino Pacas', 'Dannylux', 'Jasiel Nuñez', 'Herencia de Grandes', 'Grupo Marca Registrada', 'Neton Vega', 'Luis R Conriquez', 'Hernan Lopez', 'Victor Mendivil', 'Alemán', 'Dareyes De La Sierra'],
  'corridos bélicos': ['Luis R Conriquez', 'Kevin AMF', 'Grupo Arriesgado', 'El Makabelico', 'Gerardo Coronel', 'Clave Especial', 'Los Gemelos de Sinaloa', 'Alfredo Olivas', 'Calle 24', 'Hector Rubio', 'Los Dareyes de la Sierra', 'Jesús Ortiz Paz'],
  'regional mexicano': ['Grupo Frontera', 'Carin Leon', 'Christian Nodal', 'Banda MS de Sergio Lizárraga', 'Calibre 50', 'Julión Álvarez y su Norteño Banda', 'La Arrolladora Banda El Limón De Rene Camacho', 'Grupo Firme', 'Los Tigres Del Norte', 'Ángela Aguilar', 'Vicente Fernández', 'Gerardo Ortiz', 'El Fantasma', 'Edén Muñoz', 'Pepe Aguilar'],
  'reguetón': ['Bad Bunny', 'Karol G', 'Feid', 'J Balvin', 'Daddy Yankee', 'Ozuna', 'Rauw Alejandro', 'Maluma', 'Myke Towers', 'Jhayco', 'Blessd', 'Ryan Castro', 'Wisin & Yandel', 'Don Omar', 'Nicky Jam', 'Farruko', 'Sech', 'Young Miko', 'Kapo', 'Beéle', 'Manuel Turizo', 'Lunay', 'Justin Quiles', 'Dalex', 'Zion & Lennox', 'Plan B', 'Tito El Bambino', 'Arcángel', 'De La Ghetto', 'Ñengo Flow', 'Kevvo', 'Dei V', 'Omar Courtz', 'Reykon', 'Lenny Tavárez', 'Mora', 'Brray', 'Jowell & Randy', 'Hector El Father', 'Tego Calderón'],
  'trap latino': ['Anuel AA', 'Eladio Carrión', 'Bryant Myers', 'Kris R', 'Pirlo', 'Duki', 'Myke Towers', 'Almighty', 'Lito Kirino', 'Noriel', 'Ele A El Dominio', 'Hades66', 'Yan Block', 'Quevedo', 'Rels B', 'Trueno', 'Milo J', 'Tiago PZK', 'Paulo Londra', 'Khea', 'Jon Z', 'Alex Rose', 'Juhn', 'YOVNGCHIMI', 'Polimá Westcoast', 'Pablo Chill-E', 'Marcianeke', 'Cris MJ', 'Ovi', 'Natos y Waor', 'Morad', 'Beny Jr', 'Nicki Nicole', 'Bizarrap', 'Saiko', 'JC Reyes', 'Luar La L', 'Mora', 'Arcángel', 'Bad Gyal', 'Gotay "El Autentiko"'],
  'rap': ['Eminem', 'Drake', 'Kendrick Lamar', 'Travis Scott', 'Kanye West', 'J. Cole', '50 Cent', 'Future', 'Lil Wayne', 'Jay-Z', 'Snoop Dogg', 'Dr. Dre', 'Tyler, The Creator', 'Lil Baby', 'A$AP Rocky', 'Post Malone', 'Juice WRLD', 'XXXTENTACION', 'Mac Miller', 'Playboi Carti', 'Metro Boomin', '21 Savage', 'Lil Uzi Vert', 'Nicki Minaj', 'Cardi B', 'Doechii', 'Gunna', 'Young Thug', 'DMX', 'Tupac', 'The Notorious B.I.G.', 'Pop Smoke', 'Central Cee', 'Don Toliver', 'Lil Nas X', 'Polo G', 'NF', 'Logic', 'Macklemore', 'Fort Minor'],
  'rap en español': ['Canserbero', 'Residente', 'Calle 13', 'Nach', 'Kase.O', 'Akapellah', 'Gera MX', 'Santa RM', 'Alemán', 'Cartel de Santa', 'C-Kan', 'Porta', 'Ac Mafia', 'Arianna Puello', 'Rapper School'],
  'R&B': ['The Weeknd', 'SZA', 'Frank Ocean', 'Chris Brown', 'Usher', 'Bryson Tiller', 'Daniel Caesar', 'Summer Walker', 'H.E.R.', 'Brent Faiyaz', 'Khalid', 'Giveon', 'Jhené Aiko', 'Alicia Keys', 'Beyoncé', 'Rihanna', '6LACK', 'Tinashe', 'Kehlani', 'Ne-Yo'],
  'vallenato': ['Diomedes Díaz', 'Silvestre Dangond', 'Jorge Celedón', 'Carlos Vives', 'Peter Manjarrés', 'Los Diablitos', 'Binomio de Oro de América', 'Martín Elías', 'Poncho Zuleta', 'Iván Villazón', 'Felipe Peláez', 'Los Inquietos del Vallenato', 'Otto Serge'],
  'champeta': ['Mr. Black El Presidente', 'Kevin Flórez', 'El Afinaito', 'Zaider', 'Charles King', 'Louis Towers', 'Twister El Rey'],
  'salsa': ['Marc Anthony', 'Héctor Lavoe', 'Willie Colón', 'Rubén Blades', 'Grupo Niche', 'Joe Arroyo', 'Frankie Ruiz', 'Gilberto Santa Rosa', 'Celia Cruz', 'Oscar D\'León', 'Victor Manuelle', 'Jerry Rivera', 'Eddie Santiago', 'Fruko Y Sus Tesos', 'Guayacán Orquesta', 'La Sonora Ponceña', 'Tito Rojas', 'El Gran Combo De Puerto Rico'],
  'bachata': ['Romeo Santos', 'Aventura', 'Prince Royce', 'Juan Luis Guerra 4.40', 'Anthony Santos', 'Frank Reyes', 'Zacarías Ferreira', 'Raulin Rodriguez', 'Toby Love', 'Grupo Extra', 'Monchy & Alexandra', 'Luis Vargas', 'Elvis Martinez'],
  'merengue': ['Juan Luis Guerra 4.40', 'Elvis Crespo', 'Wilfrido Vargas', 'Johnny Ventura', 'Sergio Vargas', 'Fernando Villalona', 'Eddy Herrera', 'Los Hermanos Rosario', 'Kinito Mendez'],
  'cumbia': ['Los Ángeles Azules', 'Grupo Kual?', 'Los Askis', 'Celso Piña', 'Agua Marina', 'Grupo 5', 'Corazón Serrano', 'La Sonora Dinamita', 'Rodolfo Aicardi', 'Damas Gratis', 'Los Palmeras', 'Ráfaga', 'Américo', 'Los Mirlos'],
  'RKT': ['L-Gante', 'El Noba', 'Callejero Fino', 'La T y La M', 'Damas Gratis', 'Dj Tao', 'Rusherking', 'Luck Ra', 'Ke Personajes', 'La K\'onga', 'Q\' Lokura'],
  'música popular': ['Jhon Alex Castaño', 'Jessi Uribe', 'Paola Jara', 'Pipe Bueno', 'Yeison Jiménez', 'Luis Alberto Posada', 'Darío Gómez', 'Pipe Bueno', 'Francy', 'Arelys Henao', 'Giovanny Ayala', 'Galy Galiano', 'Jhonny Rivera', 'El Charrito Negro'],
  'música cristiana': ['Marcos Witt', 'Jesús Adrián Romero', 'Hillsong en Español', 'Barak', 'Marco Barrientos', 'Christine D\'Clario', 'Miel San Marcos', 'Evan Craft', 'Redimi2', 'Alex Campos', 'Ingrid Rosario', 'Danilo Montero', 'Elevation Worship', 'Hillsong Worship', 'Bethel Music', 'Maverick City Music', 'Lauren Daigle', 'Montesanto', 'Su Presencia', 'Generación 12'],
  'hard techno': ['I Hate Models', 'Trym', 'Klangkuenstler', 'Kobosil', 'Nico Moreno', 'VTSS', 'Sara Landry', 'Charlie Sparks', 'Dax J', 'Alignment', 'Shlømo', 'Funk Tribu', '999999999', 'Fantasm'],
  'industrial': ['Rammstein', 'Nine Inch Nails', 'Ministry', 'Front 242', 'KMFDM', 'Surgeon', 'Perc', 'Ancient Methods', 'Rabih Beaini', 'Orphx'],
  'techno': ['Charlotte de Witte', 'Amelie Lens', 'Adam Beyer', 'Richie Hawtin', 'Carl Cox', 'Enrico Sangiuliano', 'Reinier Zonneveld', 'Boris Brejcha', 'ANNA', 'Stephan Bodzin', 'Ben Klock', 'Jeff Mills'],
  'house': ['Fisher', 'Chris Lake', 'John Summit', 'Dom Dolla', 'Fred again..', 'Disclosure', 'Calvin Harris', 'Purple Disco Machine', 'Peggy Gou', 'MK', 'Chris Lorenzo', 'Vintage Culture', 'Meduza', 'Mau P'],
  'afro house': ['Black Coffee', 'Keinemusik', '&ME', 'Adam Port', 'Rampa', 'Themba', 'Enoo Napa', 'Da Capo'],
  'electrónica': ['David Guetta', 'Martin Garrix', 'Avicii', 'Tiësto', 'Alesso', 'Hardwell', 'Swedish House Mafia', 'Zedd', 'Kygo', 'Marshmello', 'Alan Walker', 'Steve Aoki', 'Skrillex', 'Afrojack', 'Don Diablo'],
  'drum and bass': ['Chase & Status', 'Sub Focus', 'Netsky', 'Pendulum', 'Wilkinson', 'Andy C', 'Hybrid Minds', 'Camo & Krooked', 'Dimension', 'Sota'],
  'dubstep': ['Excision', 'Subtronics', 'Skrillex', 'Virtual Riot', 'Zeds Dead', 'Svdden Death', 'Marauda', 'Kai Wachi'],
  'trance': ['Armin van Buuren', 'Above & Beyond', 'Paul van Dyk', 'Ferry Corsten', 'Aly & Fila', 'Gareth Emery', 'Cosmic Gate'],
  'hardstyle': ['Headhunterz', 'Da Tweekaz', 'Sub Zero Project', 'D-Block & S-te-Fan', 'Brennan Heart', 'Wildstylez', 'Rebelion'],
  'phonk': ['Kordhell', 'DVRST', 'MoonDeity', 'INTERWORLD', 'PlayaPhonk', 'Ghostface Playa', 'Pastel Ghost', 'NCTS', 'Hensonn', 'Dxrk ダーク'],
  'metal': ['Metallica', 'Slipknot', 'System Of A Down', 'Iron Maiden', 'Megadeth', 'Pantera', 'Korn', 'Avenged Sevenfold', 'Black Sabbath', 'Slayer', 'Gojira', 'Disturbed'],
  'metalcore': ['Bring Me The Horizon', 'Architects', 'Parkway Drive', 'Killswitch Engage', 'Bullet For My Valentine', 'Asking Alexandria', 'Spiritbox', 'Of Mice & Men', 'Wage War'],
  'punk': ['Green Day', 'Blink-182', 'The Offspring', 'Sum 41', 'Ramones', 'Rise Against', 'Bad Religion', 'Social Distortion', 'Sex Pistols'],
  'rock en español': ['Soda Stereo', 'Caifanes', 'Maná', 'Héroes Del Silencio', 'Enanitos Verdes', 'Los Prisioneros', 'Café Tacvba', 'Zoé', 'Aterciopelados', 'Los Fabulosos Cadillacs', 'Gustavo Cerati', 'Molotov', 'El Tri', 'Hombres G', 'Babasónicos', 'Los Bunkers'],
  'rock': ['Queen', 'AC/DC', 'Guns N\' Roses', 'Nirvana', 'Linkin Park', 'Red Hot Chili Peppers', 'Foo Fighters', 'Arctic Monkeys', 'The Beatles', 'Led Zeppelin', 'The Rolling Stones', 'Pink Floyd', 'Bon Jovi', 'Imagine Dragons', 'Muse', 'Pearl Jam', 'The Killers', 'Coldplay', 'Radiohead', 'Oasis', 'Twenty One Pilots', 'Fall Out Boy', 'Paramore', 'My Chemical Romance', 'Evanescence', 'Three Days Grace', 'Papa Roach', 'Breaking Benjamin', 'Shinedown', 'Creedence Clearwater Revival'],
  'indie': ['Tame Impala', 'The Strokes', 'Arctic Monkeys', 'Mac DeMarco', 'Cage The Elephant', 'Vampire Weekend', 'Phoenix', 'Hozier', 'Mitski', 'Cigarettes After Sex', 'The Neighbourhood', 'Glass Animals', 'Hippo Campus', 'Wallows', 'Clairo'],
  'baladas': ['Luis Miguel', 'Ricardo Arjona', 'Alejandro Sanz', 'Camilo Sesto', 'José José', 'Juan Gabriel', 'Ricardo Montaner', 'Laura Pausini', 'Franco De Vita', 'Chayanne', 'Cristian Castro', 'Marco Antonio Solís', 'Rocío Dúrcal', 'Ana Gabriel', 'Reik', 'Sin Bandera', 'Camila', 'Jesse & Joy', 'Pablo Alborán', 'Franco de Vita'],
  'pop latino': ['Shakira', 'Sebastián Yatra', 'Camilo', 'Morat', 'Carlos Vives', 'Enrique Iglesias', 'Ricky Martin', 'Juanes', 'Thalía', 'Paulina Rubio', 'Aitana', 'TINI', 'Danny Ocean', 'Piso 21', 'Cami', 'Reik', 'Mau y Ricky', 'Emilia', 'Nicky Jam', 'Lali'],
  'K-pop': ['BTS', 'BLACKPINK', 'Stray Kids', 'TWICE', 'NewJeans', 'SEVENTEEN', 'ATEEZ', 'aespa', 'LE SSERAFIM', 'IVE', 'Jung Kook', 'ROSÉ', 'Jimin', 'EXO', 'ENHYPEN', 'TXT', 'ITZY', 'BIGBANG', 'Red Velvet'],
  'J-pop': ['YOASOBI', 'Kenshi Yonezu', 'Ado', 'LiSA', 'Official HIGE DANdism', 'Fujii Kaze', 'Aimer', 'King Gnu', 'RADWIMPS', 'Mrs. GREEN APPLE', 'Vaundy', 'Eve'],
  'pop': ['Taylor Swift', 'Dua Lipa', 'Ed Sheeran', 'Ariana Grande', 'Billie Eilish', 'Harry Styles', 'Olivia Rodrigo', 'Bruno Mars', 'Justin Bieber', 'Sabrina Carpenter', 'Lady Gaga', 'Katy Perry', 'Miley Cyrus', 'Selena Gomez', 'Shawn Mendes', 'Charli xcx', 'Chappell Roan', 'Tate McRae', 'Doja Cat', 'Benson Boone', 'Maroon 5', 'OneRepublic', 'Sia', 'Halsey', 'Lana Del Rey', 'Adele', 'Sam Smith', 'Lewis Capaldi', 'Teddy Swims', 'Gracie Abrams'],
  'jazz': ['Miles Davis', 'John Coltrane', 'Louis Armstrong', 'Ella Fitzgerald', 'Chet Baker', 'Bill Evans', 'Dave Brubeck', 'Thelonious Monk', 'Norah Jones', 'Herbie Hancock', 'Nina Simone', 'Billie Holiday', 'Frank Sinatra'],
  'soul y funk': ['Marvin Gaye', 'Stevie Wonder', 'Aretha Franklin', 'James Brown', 'Earth, Wind & Fire', 'Al Green', 'Otis Redding', 'Sam Cooke', 'Bill Withers', 'Kool & The Gang', 'Prince', 'Leon Bridges', 'Anderson .Paak', 'Erykah Badu', 'D\'Angelo'],
  'blues': ['B.B. King', 'Muddy Waters', 'Stevie Ray Vaughan', 'John Lee Hooker', 'Howlin\' Wolf', 'Etta James', 'Gary Clark Jr.', 'Buddy Guy', 'Eric Clapton', 'Joe Bonamassa'],
  'lo-fi': ['Lofi Fruits Music', 'Chillhop Music', 'Lofi Girl', 'Kupla', 'Idealism', 'Nujabes', 'Tomppabeats', 'Jinsang', 'eevee', 'Philanthrope', 'Saib', 'potsu', 'Wun Two'],
  'ambient': ['Brian Eno', 'Ólafur Arnalds', 'Nils Frahm', 'Max Richter', 'Hammock', 'Tycho', 'Marconi Union', 'Jon Hopkins', 'Stars Of The Lid', 'Hania Rani'],
  'reggae': ['Bob Marley & The Wailers', 'Damian Marley', 'Peter Tosh', 'Sean Paul', 'Shaggy', 'UB40', 'Chronixx', 'Koffee', 'Protoje', 'Gondwana', 'Alborosie', 'Rebelution', 'SOJA', 'Stick Figure', 'Dread Mar I', 'Los Cafres'],
  'afrobeats': ['Burna Boy', 'Wizkid', 'Rema', 'Davido', 'Tems', 'Asake', 'Ayra Starr', 'CKay', 'Fireboy DML', 'Omah Lay', 'Tyla', 'Joeboy', 'Kizz Daniel', 'Victony', 'Uncle Waffles'],
  'funk brasileño': ['MC Kevinho', 'Anitta', 'MC Ryan SP', 'Ludmilla', 'MC IG', 'MC Cabelinho', 'Pedro Sampaio', 'MC Hariel', 'MC Livinho', 'Kevin O Chris', 'DJ GBR', 'MC Daniel'],
  'bossa nova': ['João Gilberto', 'Antônio Carlos Jobim', 'Astrud Gilberto', 'Stan Getz', 'Vinicius de Moraes', 'Sérgio Mendes', 'Bebel Gilberto', 'Elis Regina', 'Caetano Veloso', 'Gilberto Gil', 'Marisa Monte', 'Seu Jorge'],
  'country': ['Morgan Wallen', 'Luke Combs', 'Zach Bryan', 'Chris Stapleton', 'Kane Brown', 'Jason Aldean', 'Luke Bryan', 'Johnny Cash', 'Dolly Parton', 'Shaboozey', 'Lainey Wilson', 'Carrie Underwood', 'Kenny Chesney', 'Blake Shelton', 'Tim McGraw'],
  'música clásica': ['Ludwig van Beethoven', 'Wolfgang Amadeus Mozart', 'Johann Sebastian Bach', 'Frédéric Chopin', 'Antonio Vivaldi', 'Pyotr Ilyich Tchaikovsky', 'Claude Debussy', 'Erik Satie', 'Ludovico Einaudi', 'Hans Zimmer', 'Yiruma'],
  'flamenco': ['Paco de Lucía', 'Camarón de la Isla', 'Rosalía', 'Niña Pastori', 'Diego El Cigala', 'Estrella Morente', 'Vicente Amigo', 'Tomatito', 'Ketama', 'Gipsy Kings', 'Rocío Márquez'],
  'tango': ['Carlos Gardel', 'Astor Piazzolla', 'Gotan Project', 'Bajofondo', 'Juan D\'Arienzo', 'Aníbal Troilo', 'Osvaldo Pugliese', 'Julio Sosa', 'Otros Aires'],
  'dembow': ['El Alfa', 'Rochy RD', 'Bulin 47', 'Chimbala', 'Tokischa', 'Kiko El Crazy', 'Donaty', 'Yaisel LM', 'Haraca Kiko', 'Ceky Viciny', 'Shelow Shaq', 'La Perversa', 'Black Jonas Point', 'Braulio Fogon'],
  'drill': ['Pop Smoke', 'Central Cee', 'Headie One', 'Digga D', 'Fivio Foreign', 'Kay Flock', 'Unknown T', 'Russ Millions', 'Sheff G', 'Ice Spice'],
  'sierreño': ['Ivan Cornejo', 'Eslabon Armado', 'Jasiel Nuñez', 'DannyLux', 'Luis R Conriquez', 'Arsenal Efectivo', 'Los Elegantes de Jerez'],
};

// Nombre normalizado -> género de Natalia.
const SEED_INDEX = (() => {
  const idx = {};
  Object.entries(ARTIST_SEEDS).forEach(([label, names]) => names.forEach((n) => {
    const k = norm(n);
    if (!idx[k]) idx[k] = label;
  }));
  return idx;
})();

// Lo que Natalia ya aprendió: id de artista -> género (se va llenando sola con cada búsqueda por género).
function learnedAliases() { return store.get('artistAlias', {}); }
function learnAliases(pairs) {
  if (!pairs.length) return;
  const c = learnedAliases();
  pairs.forEach(([id, label]) => { if (id && label && !c[id]) c[id] = label; });
  const keys = Object.keys(c);
  if (keys.length > 6000) keys.slice(0, keys.length - 6000).forEach((k) => delete c[k]);
  store.set('artistAlias', c);
}

// El género de un artista ({id, name, genres}), o null si aún no se sabe.
function aliasOfArtist(a, extra) {
  if (!a) return null;
  if (extra && extra[a.id]) return aliasByLabel(extra[a.id]);
  const learned = learnedAliases()[a.id];
  if (learned) return aliasByLabel(learned);
  const fromSpotify = aliasOfArtistGenres(a.genres);
  if (fromSpotify) return fromSpotify;
  const seed = SEED_INDEX[norm(a.name)];
  return seed ? aliasByLabel(seed) : null;
}

// Arma el mapa de géneros de tu perfil: lista + colaboraciones (si un artista que no conozco
// colabora con uno de corridos, seguramente es de corridos).
function classifyProfile(profile) {
  const map = {};
  profile.artists.forEach((a) => { const al = aliasOfArtist(a); if (al) map[a.id] = al.label; });
  const nameOf = {};
  profile.artists.forEach((a) => { nameOf[a.id] = a.name; });
  for (let round = 0; round < 2; round++) {
    profile.tracks.forEach((t) => {
      const known = t.artistIds.map((id, i) => map[id] || (aliasOfArtist({ id, name: t.artists[i] }) || {}).label).find(Boolean);
      if (!known) return;
      t.artistIds.forEach((id, i) => {
        if (!map[id]) {
          const own = aliasOfArtist({ id, name: t.artists[i] });
          map[id] = own ? own.label : known;
        }
      });
    });
  }
  // Artistas de tus canciones que no estaban en tu top: también cuentan.
  profile.tracks.forEach((t) => t.artistIds.forEach((id, i) => {
    if (!profile.artists.find((a) => a.id === id)) {
      profile.artists.push({ id, name: t.artists[i], genres: [], score: Math.round((t.score || 10) / 2) });
    }
  }));
  profile.aliasOf = map;
  return profile;
}

// Para los artistas que todavía no sé, le pregunto a Spotify "¿este artista es de este género?".
async function probeUnknownArtists(profile) {
  if (profile.probedAt && Date.now() - profile.probedAt < 24 * 3600 * 1000) return profile;
  profile.probedAt = Date.now();
  store.set('profile2', profile);
  const unknown = profile.artists.filter((a) => !profile.aliasOf[a.id]).sort((a, b) => b.score - a.score).slice(0, 8);
  if (!unknown.length) return profile;
  const taste = tasteByGenre(profile);
  const candidates = Object.keys(taste).sort((a, b) => taste[b] - taste[a]).slice(0, 3).map(aliasByLabel).filter(Boolean);
  const jobs = [];
  unknown.forEach((a) => candidates.forEach((al) => jobs.push([a, al])));
  const found = {};
  let stop = false;
  await pool(jobs, 1, async ([a, al]) => {
    if (found[a.id] || stop || busy) return;
    await new Promise((r) => setTimeout(r, 400));
    try {
      const r = await sp('/search', { query: { q: `artist:"${a.name}" genre:"${al.genres[0]}"`, type: 'track', limit: 1 } });
      const t = r && r.tracks && r.tracks.items && r.tracks.items[0];
      if (t && t.artists.some((x) => x.id === a.id)) found[a.id] = al.label;
    } catch (e) { if (e.status === 429) stop = true; }
  });
  learnAliases(Object.entries(found));
  Object.assign(profile.aliasOf, found);
  store.set('profile2', profile);
  return profile;
}

// Resumen corto de tus gustos, para que veas que Natalia te conoce.
function tasteSummary(profile) {
  const taste = tasteByGenre(profile);
  const top = Object.keys(taste).sort((a, b) => taste[b] - taste[a]).slice(0, 4);
  if (!top.length) return '';
  return top.map((label) => {
    const names = profile.artists.filter((a) => profile.aliasOf[a.id] === label).sort((a, b) => b.score - a.score).slice(0, 3).map((a) => a.name);
    return `• ${label}${names.length ? ': ' + names.join(', ') : ''}`;
  }).join('\n');
}

// Cuánto escuchas cada género (tus artistas + lo que me has pedido).
function tasteByGenre(profile) {
  const score = {};
  const map = profile.aliasOf || {};
  profile.artists.forEach((a) => {
    const label = map[a.id] || (aliasOfArtist(a) || {}).label;
    if (label) score[label] = (score[label] || 0) + a.score;
  });
  Object.entries(memory().asked || {}).forEach(([l, n]) => { if (aliasByLabel(l)) score[l] = (score[l] || 0) + n * 15; });
  return score;
}
const feedback = () => memory().genres || {};

// Lo que ya escuchaste o ya te recomendé: nunca se repite en "Descubrir".
function heardUris(profile) {
  const m = memory();
  return new Set([
    ...m.suggested.map((x) => x.uri),
    ...profile.tracks.map((t) => t.uri),
    ...(store.get('likedUris', []) || []),
  ]);
}

function avoidFor(profile, strict, recent = 80) {
  const m = memory();
  const uris = new Set(m.disliked.filter((x) => Date.now() - (x.at || 0) < 90 * 86400000).map((x) => x.uri));
  if (strict) heardUris(profile).forEach((u) => uris.add(u));
  else if (recent) m.suggested.slice(-recent).forEach((x) => uris.add(x.uri));
  const artists = new Set(Object.entries(m.artists || {}).filter(([, s]) => s <= -2).map(([id]) => id));
  return { uris, artists };
}

// Sesión de un solo género.
async function genreSession(alias, mode, profile, { market, newGenre } = {}) {
  const count = settings().count;
  const discover = mode.discover || newGenre;
  const yf = yearFilter(mode);
  const known = new Set(profile.artists.map((a) => a.id));
  const base = (discover ? 10 + rnd(4) * 10 : rnd(3) * 10) + (mode.more ? 20 : 0);
  const [g1, g2] = alias.genres;
  let start = base;
  if (discover || mode.more) {
    for (let o = base; o <= 90; o += 10) { if (!cacheGet('t', tKey(`genre:"${g1}"${yf}`, o, market), 12 * 3600 * 1000)) { start = o; break; } }
  }
  const qs = [[`genre:"${g1}"${yf}`, start], [`genre:"${g1}"${yf}`, start + 10]];
  // Artistas de ese género (los tuyos y los conocidos) para que nunca quede corta.
  const favs = Object.values(memory().fav || {}).filter((f) => f.label === alias.label).map((f) => f.name);
  const seedNames = [
    ...shuffle(favs).slice(0, 2),
    ...shuffle([
      ...profile.artists.filter((a) => (profile.aliasOf || {})[a.id] === alias.label).slice(0, 6).map((a) => a.name),
      ...shuffle(ARTIST_SEEDS[alias.label] || []).slice(0, 4),
    ]),
  ].filter((n, i, arr) => arr.indexOf(n) === i).slice(0, 1);
  const seedQs = seedNames.map((n) => [`artist:"${n}"${yf}`, discover ? 10 : 0]);
  const lists = await gather([...qs, ...seedQs], market, 1);
  if (aliasByLabel(alias.label)) learnAliases(lists.slice(0, qs.length).flat().map((t) => [t.artistIds[0], alias.label]));
  let found = shuffle(lists.flat());
  found = found.concat(shuffle(cachedFor(`genre:"${g1}"`)), shuffle(seedNames.flatMap((n) => cachedFor(`artist:"${n}"`))));
  if (discover) found = found.filter((t) => !t.artistIds.some((id) => known.has(id)));
  if (found.length < 6) {
    const more = (await gather([[`genre:"${g1}"`, 0], [`${alias.label}${yf}`, 0]], market, found.length ? 0 : 1)).flat();
    found = found.concat(shuffle(more));
  }
  if (found.length < 10) {
    const ids = [
      ...Object.entries(memory().fav || {}).filter(([, f]) => f.label === alias.label).map(([id, f]) => ({ id, name: f.name })),
      ...shuffle(profile.artists.filter((a) => (profile.aliasOf || {})[a.id] === alias.label)).map((a) => ({ id: a.id, name: a.name })),
    ].filter((a, i, arr) => arr.findIndex((b) => b.id === a.id) === i).slice(0, 2);
    const extra = await Promise.all(ids.map((a) => artistTracksById(a, { deep: discover }).catch(() => [])));
    found = found.concat(shuffle(extra.flat()));
  }
  const mine = discover ? [] : shuffle(profile.tracks.filter((t) => t.artistIds.some((id) => (profile.aliasOf || {})[id] === alias.label)));
  const mineShare = mode.likes ? Math.ceil(count * 0.6) : mode.fresh ? 0 : 4;
  let tracks = arrange([mine.slice(0, mineShare), found], count, avoidFor(profile, discover, mode.more ? 200 : 80));
  if (tracks.length < 10 && !discover) tracks = arrange([mine.slice(0, mineShare), found], count, avoidFor(profile, false, 0));
  if (tracks.length < 5 && discover) tracks = arrange([found], count, avoidFor(profile, false));
  return tracks;
}

// Elige uno de tus géneros, pesando lo que escuchas y lo que marcaste con ❤ / 👎.
function pickMyGenre(profile, exclude) {
  const taste = tasteByGenre(profile);
  const fb = feedback();
  const items = Object.entries(taste)
    .filter(([label]) => label !== exclude && (fb[label] || 0) > -3)
    .map(([label, s]) => ({ v: aliasByLabel(label), w: s * Math.max(0.2, 1 + 0.25 * (fb[label] || 0)) }))
    .filter((x) => x.v)
    .sort((a, b) => b.w - a.w)
    .slice(0, 5);
  // Géneros que no estaban en tu perfil pero te encantaron.
  Object.entries(fb).filter(([l, s]) => s >= 2 && !taste[l] && aliasByLabel(l)).forEach(([l, s]) => items.push({ v: aliasByLabel(l), w: s * 50 }));
  return pickByWeight(items);
}

// Un género que NO escuchas (ni nada de su familia), que vaya cambiando y aprendiendo de tus ❤ / 👎.
function pickNewGenre(profile) {
  const taste = tasteByGenre(profile);
  const total = Object.values(taste).reduce((s, x) => s + x, 0) || 1;
  const famScore = {};
  Object.entries(taste).forEach(([l, s]) => { const a = aliasByLabel(l); if (a) famScore[a.fam] = (famScore[a.fam] || 0) + s; });
  const blockedFams = new Set(Object.entries(famScore).filter(([, s]) => s / total >= 0.08).map(([f]) => f));
  const fb = feedback();
  const tried = (memory().tried || []).slice(-6);
  const seenLabels = new Set();
  const items = GENRE_ALIASES.filter((a) => {
    if (seenLabels.has(a.label)) return false;
    seenLabels.add(a.label);
    return !blockedFams.has(a.fam) && !taste[a.label] && (fb[a.label] || 0) > -2;
  }).map((a) => ({ v: a, w: (1 + 2 * Math.max(0, fb[a.label] || 0)) * (tried.includes(a.label) ? 0.15 : 1) }));
  return pickByWeight(items);
}

async function countrySession(c, mode, profile) {
  const y = new Date().getFullYear();
  const pick = shuffle(c.artists).slice(0, 3);
  const lists = await gather(pick.map((a) => [`artist:"${a}" year:${y - 1}-${y}`, 0]), c.market, 1);
  const groups = lists.map((l, i) => l.filter((t) => t.artists.some((n) => norm(n) === norm(pick[i]))).slice(0, 6));
  c.artists.forEach((a) => groups.push(shuffle(cachedFor(`artist:"${a}" year:${y - 1}-${y}`).filter((t) => t.artists.some((n) => norm(n) === norm(a)))).slice(0, 4)));
  // Si la búsqueda no está disponible, uso los artistas de ese país que ya conozco (sin buscar).
  if (groups.flat().length < 10) {
    let known = shuffle(c.artists.map(knownArtist).filter(Boolean)).slice(0, 3);
    if (known.length < 3) {
      const same = shuffle(profile.artists.filter((a) => (profile.aliasOf || {})[a.id] === c.label && !known.some((k) => k.id === a.id)));
      known = known.concat(same.map((a) => ({ id: a.id, name: a.name }))).slice(0, 3);
    }
    const more = await Promise.all(known.map((a) => artistTracksById(a).catch(() => [])));
    more.forEach((l) => groups.push(shuffle(l).slice(0, 8)));
  }
  return arrange(shuffle(groups), settings().count, avoidFor(profile, false));
}

async function motivationSession(profile) {
  const known = store.get('motivTracks', {});
  const missing = shuffle(MOTIVATION.filter(([n]) => !known[n])).slice(0, Math.max(0, Math.min(2, budgetLeft() - 2)));
  const lists = await Promise.all(missing.map(([name, artist]) => searchTracks(`track:"${name}" artist:"${artist}"`, 0)));
  lists.forEach((l, i) => { const t = l.find((x) => x.artists.some((a) => norm(a).includes(norm(missing[i][1])))); if (t) known[missing[i][0]] = t; });
  store.set('motivTracks', known);
  let tracks = shuffle(Object.values(known));
  if (tracks.length < settings().count) {
    const extra = await gather([['artist:"Eminem"', 0], [`artist:"${shuffle(['50 Cent', 'DMX', 'Kanye West', 'Kendrick Lamar'])[0]}"`, 0], ['artist:"Eminem"', 10]], undefined, 1);
    tracks = tracks.concat(shuffle(extra.flat()));
  }
  if (tracks.length < 10) {
    const known = ['Eminem', '50 Cent', 'DMX', 'Kendrick Lamar', 'Kanye West', 'Drake'].map(knownArtist).filter(Boolean).slice(0, 2);
    const more = await Promise.all(known.map((a) => artistTracksById(a).catch(() => [])));
    tracks = tracks.concat(shuffle(more.flat()));
  }
  const avoid = avoidFor(profile, false);
  avoid.uris = new Set(memory().disliked.map((x) => x.uri));
  return arrange(tracks.map((t) => [t]), settings().count, avoid);
}


// Lo que me pides también cuenta como gusto (tu historial de pedidos).
function noteAsked(artists, profile) {
  const m = memory();
  m.asked = m.asked || {};
  artists.forEach((ar) => { const al = aliasOfArtist(ar, profile.aliasOf); if (al) m.asked[al.label] = Math.min(20, (m.asked[al.label] || 0) + 1); });
  saveMemory(m);
}

// Pregunta a Spotify si un artista es de alguno de estos géneros (pocas preguntas, en paralelo).
async function probeArtist(artist, labels) {
  const results = await Promise.all(labels.map(aliasByLabel).filter(Boolean).map(async (al) => {
    try {
      const r = await sp('/search', { query: { q: `artist:"${artist.name}" genre:"${al.genres[0]}"`, type: 'track', limit: 1 } });
      const t = r && r.tracks && r.tracks.items && r.tracks.items[0];
      return t && t.artists.some((x) => x.id === artist.id) ? al : null;
    } catch { return null; }
  }));
  const al = results.find(Boolean) || null;
  if (al) learnAliases([[artist.id, al.label]]);
  return al;
}

// Un artista: sus canciones (populares o menos conocidas) y, para que fluya, más de SU MISMO género.
async function artistSession(artist, mode, profile) {
  const count = settings().count;
  const yf = yearFilter(mode);
  const ownOffs = mode.deep || mode.more ? [20, 30] : [0, 10];
  const taste = tasteByGenre(profile);
  const guess = Object.keys(taste).sort((a, b) => taste[b] - taste[a]).slice(0, 3);
  const knownAl = aliasOfArtist(artist, profile.aliasOf);
  const al = knownAl;
  const onlyHimEarly = mode.popular || mode.deep || /\bsolo\b|\bpuro\b|\bpuras?\b|nada mas/.test(mode.raw || '');
  const ownQs = mode.deep || mode.more ? ownOffs.map((o) => [`artist:"${artist.name}"`, o])
    : mode.fresh ? [[`artist:"${artist.name}"${yf}`, 0]]
    : [[`artist:"${artist.name}"`, 10]];
  const genreQs = al && !onlyHimEarly && !mode.similar ? [[`genre:"${al.genres[0]}"${yf}`, rnd(2) * 10]] : al && mode.similar ? [[`genre:"${al.genres[0]}"${yf}`, 0], [`genre:"${al.genres[0]}"${yf}`, 10]] : [];
  let firstPage = mode.deep || mode.fresh || mode.more ? [] : (artist.tracks || []);
  const [lists, albumTracks] = await Promise.all([
    gather([...ownQs, ...genreQs], undefined, firstPage.length || !searchBlocked() ? 0 : 1),
    firstPage.length >= 8 && !searchBlocked() ? Promise.resolve([]) : artistTracksById(artist, { deep: mode.deep || mode.more }).catch(() => []),
  ]);
  firstPage = [...firstPage, ...albumTracks];
  let own = [...firstPage, ...lists.slice(0, ownQs.length).flat(), ...(mode.fresh ? [] : cachedFor(`artist:"${artist.name}"|`))].filter((t) => t.artistIds.includes(artist.id));
  const genreTracks = [...lists.slice(ownQs.length).flat(), ...(al ? cachedFor(`genre:"${al.genres[0]}"`) : []),
    ...(al ? profile.tracks.filter((t) => t.artistIds.some((id) => (profile.aliasOf || {})[id] === al.label)) : [])].filter((t) => !t.artistIds.includes(artist.id));
  if (mode.fav) {
    const m = memory(); m.artists = m.artists || {}; m.fav = m.fav || {};
    m.artists[artist.id] = Math.max(3, (m.artists[artist.id] || 0) + 3);
    m.fav[artist.id] = { name: artist.name, label: al ? al.label : '', at: Date.now() };
    if (al) { m.genres = m.genres || {}; m.genres[al.label] = Math.min(10, (m.genres[al.label] || 0) + 1); }
    saveMemory(m);
  }
  // Relacionados: con quién colabora (los "feat") y, si sé su género, más de ese género.
  const collabs = {};
  own.forEach((t) => t.artists.forEach((n, i) => { if (t.artistIds[i] !== artist.id) collabs[n] = (collabs[n] || 0) + 1; }));
  const collabNames = Object.keys(collabs).sort((a, b) => collabs[b] - collabs[a]).slice(0, al ? 0 : 1);
  if (!mode.popular && !mode.deep) own = shuffle(own);
  const onlyHim = onlyHimEarly;
  let others = [];
  if (!onlyHim) {
    // Sin género conocido: el artista con quien más colabora (una búsqueda que casi siempre ya está guardada).
    const rel = collabNames.length ? (await gather(collabNames.map((n) => [`artist:"${n}"`, 0]), undefined, 0)).flat()
      .filter((t) => !t.artistIds.includes(artist.id) && t.artists.some((n) => collabNames.includes(n))) : [];
    others = [...shuffle(rel).slice(0, 6), ...shuffle(genreTracks)];
  }
  const ownShare = mode.similar && others.length ? 2 : onlyHim || others.length < 5 ? count : Math.ceil(count * 0.6);
  const tracks = arrange([own.slice(0, ownShare), others], count, avoidFor(profile, false, mode.more ? 200 : 0));
  noteAsked([artist], profile);
  const label = mode.similar ? `parecidos a ${artist.name}` : artist.name;
  const what = mode.deep ? 'las menos conocidas de ' : mode.popular ? 'lo más popular de ' : '';
  let intro = mode.similar ? `Artistas del estilo de ${artist.name}${al ? `, todo ${al.label}` : ''}.`
    : `Va ${what}${artist.name}${!onlyHim && others.length ? `, y para que fluya, artistas relacionados${al ? ` de ${al.label}` : ''}` : ''}.`;
  if (mode.fav) intro = `¡Anotado! ${artist.name} quedó en tus favoritos: desde ahora te pondré más de ${artist.name} y de lo relacionado. Si algo relacionado no te gusta, dale 👎 y no te lo vuelvo a poner. ` + intro;
  return { tracks, key: al ? al.label : '', label, intro };
}

// Busca playlists en Spotify con tus palabras y usa la que tenga más canciones que sí se puedan leer.
async function playlistSession(query, profile) {
  try {
    const r = await spSearch(query, 'playlist', 0);
    const pls = ((r && r.playlists && r.playlists.items) || []).filter(Boolean).slice(0, 1);
    const lists = await Promise.all(pls.map(async (pl) => {
      let d = null;
      try { d = await sp(`/playlists/${pl.id}/items`, { query: { limit: 50 } }); }
      catch (e) { if (e.status === 404) { try { d = await sp(`/playlists/${pl.id}/tracks`, { query: { limit: 50 } }); } catch { d = null; } } }
      const items = ((d && d.items) || []).map((i) => i && (i.item || i.track)).filter((t) => t && t.uri && t.type !== 'episode' && !t.is_local);
      return { pl, tracks: items.map(simplify) };
    }));
    const best = lists.sort((a, b) => b.tracks.length - a.tracks.length)[0];
    if (!best || best.tracks.length < 6) return null;
    const tracks = arrange([shuffle(best.tracks)], settings().count, avoidFor(profile, false, 0));
    return { tracks, key: '', label: best.pl.name, intro: `No conocía "${query}", así que lo busqué en Spotify y te puse la playlist "${best.pl.name}".` };
  } catch { return null; }
}

// Arma la sesión. Siempre UN solo género, para que todo fluya.
async function buildSession(text, extra) {
  await waitPause(5000);
  const { genre, mode, country, artistQuery, artistParts } = interpret(text);
  Object.assign(mode, extra || {});
  let profile = store.get('profile2', null);
  if (!profile || !profile.aliasOf) profile = await loadProfile(true);
  const count = settings().count;

  // País: lo que más suena allá ahora.
  if (country && (mode.country || !artistQuery)) {
    if (genre) {
      const tracks = await genreSession(genre, { ...mode, fresh: true }, profile, { market: country.market });
      return { tracks, key: genre.label, label: `${genre.label} en ${country.name}`, intro: `Lo nuevo de ${genre.label} que suena en ${country.name}.` };
    }
    const tracks = await countrySession(country, mode, profile);
    return { tracks, key: country.label, label: `lo que suena en ${country.name}`, intro: `Lo que más suena en ${country.name} estos días, todo ${country.label}: los éxitos recientes de los artistas que dominan allá.` };
  }

  // Motivación de verdad (si no pidió un género o artista concreto).
  if (mode.motiv && !genre && !artistQuery) {
    const tracks = await motivationSession(profile);
    return { tracks, key: 'rap', label: 'motivación', intro: 'Motivación pura, todo rap del que levanta: Eminem y compañía. ¡A darle!' };
  }

  // Un género nuevo para ti (si dijo cuál, ese; si no, uno que nunca escuchas).
  if (mode.newGenre && !artistQuery) {
    const alias = genre || pickNewGenre(profile) || aliasByLabel('afrobeats');
    const m = memory(); m.tried = [...(m.tried || []), alias.label].slice(-10); saveMemory(m);
    const tracks = await genreSession(alias, mode, profile, { newGenre: true });
    return { tracks, key: alias.label, label: `género nuevo: ${alias.label}`, intro: `Género nuevo para ti: ${alias.label}. Toda la sesión es de ${alias.label}. Si te gusta, dale ❤ y lo tendré en cuenta; si no, 👎 y no te lo vuelvo a poner.` };
  }

  // Varios artistas a la vez: sus canciones más populares, mezcladas.
  if (!genre && artistParts.length >= 2) {
    const found = (await Promise.all(artistParts.map(findArtist))).filter((x) => x && (x.exact || x.sim >= 0.55));
    const uniq = found.filter((x, i) => found.findIndex((y) => y.id === x.id) === i);
    if (uniq.length >= 2) {
      const per = Math.ceil(count / uniq.length) + 2;
      const deepish = mode.deep || mode.more;
      const offsOf = (ar) => (deepish ? [20, 30] : [...((ar.tracks || []).length ? [] : [0]), ...(per > 10 ? [10] : [])]);
      const qs = uniq.map((ar) => offsOf(ar).map((o) => [`artist:"${ar.name}"`, o]));
      const flatLists = await gather(qs.flat(), undefined, uniq.length);
      let k = 0;
      const groups = await Promise.all(uniq.map(async (ar, i) => {
        const mine = flatLists.slice(k, k + qs[i].length).flat(); k += qs[i].length;
        let g = [...(deepish ? [] : (ar.tracks || [])), ...mine].filter((t) => t.artistIds.includes(ar.id));
        // Sin búsqueda disponible: sus álbumes (otro camino de Spotify).
        if (g.length < 6) g = g.concat(shuffle(await artistTracksById(ar, { deep: deepish }).catch(() => [])));
        return g.slice(0, per);
      }));
      const tracks = arrange(groups, count, avoidFor(profile, false, mode.more ? 200 : 0));
      const names = uniq.map((x) => x.name).join(' y ');
      noteAsked(uniq, profile);
      return { tracks, key: (aliasOfArtist(uniq[0], profile.aliasOf) || {}).label || '', label: names, intro: `${mode.deep ? 'Las menos conocidas' : 'Lo más popular'} de ${names}, mezclado.` };
    }
  }

  // Un artista, o algo que no reconocí: miro a la vez si es artista o género de Spotify.
  if (artistQuery) {
    const artist = await findArtist(artistQuery);
    const asGenre = genre || (artist && artist.exact) ? [] : await searchTracks(`genre:"${artistQuery}"`, 0);
    if (!genre && asGenre.length >= 5 && !(artist && artist.exact)) {
      const alias = { label: artistQuery, genres: [artistQuery], fam: artistQuery, pl: artistQuery };
      const tracks = await genreSession(alias, mode, profile);
      return { tracks, key: artistQuery, label: artistQuery, intro: `Sesión de ${artistQuery}, sin mezclar con otros géneros.` };
    }
    if (artist && artist.exact) {
      const r = await artistSession(artist, mode, profile);
      if (r.tracks.length >= 5) return r;
      const pl = await playlistSession(artistQuery, profile);
      return pl || r;
    }
    if (!genre) {
      // No lo conozco: busco playlists en Spotify con esas palabras y pongo la mejor.
      const pl = await playlistSession(artistQuery, profile);
      if (pl) return pl;
      if (artist) return artistSession(artist, mode, profile);
      const lists = await gather([[artistQuery, 0], [artistQuery, 10]]);
      return { tracks: arrange([lists.flat()], count, avoidFor(profile, false)), key: '', label: artistQuery, intro: `Esto encontré para "${artistQuery}".` };
    }
  }

  // Pidió un género: solo ese género.
  if (genre) {
    const tracks = await genreSession(genre, mode, profile);
    if (tracks.length < 10) { const pl = await playlistSession(text, profile); if (pl && pl.tracks.length > tracks.length) return pl; }
    const adj = mode.fresh ? ' nuevos' : mode.old ? ' de los clásicos' : mode.discover ? ' que nunca has escuchado' : '';
    return { tracks, key: genre.label, label: genre.label, intro: `Sesión de ${genre.label}${adj}, sin mezclar con otros géneros.` };
  }

  // Relajante sin género: lo-fi.
  if (mode.relax) {
    const alias = aliasByLabel('lo-fi');
    const tracks = await genreSession(alias, mode, profile);
    return { tracks, key: alias.label, label: 'relajante', intro: 'Algo relajante: lo-fi tranquilo, todo del mismo estilo.' };
  }

  // Tus gustos (o descubrir dentro de tus gustos): uno de tus géneros por sesión.
  let alias = pickMyGenre(profile);
  if (!alias) {
    const y = new Date().getFullYear();
    const lists = await gather([[`year:${y}`, 0], [`year:${y}`, 10]]);
    return { tracks: arrange([lists.flat()], count, avoidFor(profile, false)), key: '', label: 'lo nuevo', intro: 'Spotify casi no me dio datos de lo que escuchas, así que va lo más nuevo. Dale ❤ a lo que te guste o pídeme artistas, y así aprendo.' };
  }
  const tracks = await genreSession(alias, mode, profile);
  const intro = mode.discover ? `Descubrir: ${alias.label} que nunca has escuchado, de artistas nuevos para ti.`
    : mode.fresh ? `Lo nuevo de ${alias.label}, que es de lo que más escuchas.`
    : `Sesión de ${alias.label}, de lo que más te gusta, todo del mismo estilo.`;
  return { tracks, key: alias.label, label: alias.label, intro };
}

// ---------- Reproducción ----------
async function pickDevice() {
  const r = await sp('/me/player/devices');
  const devices = (r && r.devices) || [];
  if (!devices.length) return null;
  return devices.find((d) => d.is_active) || devices.find((d) => d.type === 'Smartphone') || devices[0];
}

// Reproducir: una sola orden a Spotify. Si no hay Spotify activo, se usa el que esté en la lista.
async function waitPause(maxMs) {
  const left = pausedUntil - Date.now();
  if (left > 0 && left <= maxMs) await new Promise((r) => setTimeout(r, left + 100));
}
async function playUris(uris, first) {
  await waitPause(6000);
  try {
    await sp('/me/player/play', { method: 'PUT', body: { uris } });
  } catch (e) {
    if (e.status === 429 && (e.retryAfter || 9) <= 6) {
      await waitPause(6000);
      await sp('/me/player/play', { method: 'PUT', body: { uris } });
    } else {
      if (e.status !== 404) throw e;
      const device = await pickDevice().catch(() => null);
      if (!device) throw new Error('NO_DEVICE');
      await sp('/me/player/play', { method: 'PUT', query: { device_id: device.id }, body: { uris } });
    }
  }
  if (first) showNowPlaying(first);
}
function showNowPlaying(t) {
  current = { uri: t.uri, id: t.id, artistIds: t.artistIds, artistNames: t.artists, label: labelOf(t), playing: true };
  $('npTitle').textContent = t.name;
  $('npArtist').textContent = t.artists.join(', ');
  if (t.img) $('npArt').src = t.img;
}

async function savePlaylist(name, uris) {
  let pl;
  try {
    pl = await sp('/me/playlists', { method: 'POST', body: { name, public: false, description: 'Creada por Natalia, tu DJ' } });
  } catch (e) {
    const me = await sp('/me');
    pl = await sp(`/users/${encodeURIComponent(me.id)}/playlists`, { method: 'POST', body: { name, public: false, description: 'Creada por Natalia, tu DJ' } });
  }
  try { await sp(`/playlists/${pl.id}/items`, { method: 'POST', body: { uris } }); }
  catch (e) { await sp(`/playlists/${pl.id}/tracks`, { method: 'POST', body: { uris } }); }
  return pl;
}

async function saveToLiked(track) {
  try { await sp('/me/library', { method: 'PUT', query: { uris: track.uri } }); }
  catch (e) { await sp('/me/tracks', { method: 'PUT', query: { ids: track.id } }); }
}

// ---------- Organizar tus Me gusta por género ----------
// Corre varias tareas a la vez, pero sin pasarse (para que Spotify no nos frene).
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

async function fetchAllLiked(onProgress) {
  const first = await sp('/me/tracks', { query: { limit: 50, offset: 0 } });
  const total = Math.min((first && first.total) || 0, 5000);
  const offsets = [];
  for (let o = 50; o < total; o += 50) offsets.push(o);
  let done = 50;
  const pages = await pool(offsets, 4, async (o) => {
    const r = await sp('/me/tracks', { query: { limit: 50, offset: o } }).catch(() => null);
    done += 50; onProgress(Math.min(done, total), total);
    return (r && r.items) || [];
  });
  return [first.items || [], ...pages].flat().filter((i) => i && i.track && i.track.uri && !i.track.is_local);
}

// Géneros de cada artista (primero lo que Natalia ya sabe, luego le pregunta a Spotify).
async function genresOf(artistIds) {
  const cache = store.get('artistGenres', {});
  const profile = store.get('profile2', null);
  if (profile) profile.artists.forEach((a) => { if (a.genres && a.genres.length) cache[a.id] = a.genres; });
  const missing = [...new Set(artistIds)].filter((id) => id && !cache[id]);
  let batchWorks = true;
  for (let i = 0; i < missing.length && batchWorks; i += 50) {
    const ids = missing.slice(i, i + 50);
    try {
      const r = await sp('/artists', { query: { ids: ids.join(',') } });
      ((r && r.artists) || []).forEach((a) => { if (a) cache[a.id] = a.genres || []; });
    } catch { batchWorks = false; }
  }
  if (!batchWorks) {
    await pool(missing.filter((id) => !cache[id]), 6, async (id) => {
      try { const a = await sp('/artists/' + id); cache[id] = (a && a.genres) || []; } catch { cache[id] = []; }
    });
  }
  store.set('artistGenres', cache);
  return cache;
}

// Averigua el género de muchos artistas: lo aprendido + la lista + colaboraciones + preguntas a Spotify.
async function classifyArtists(tracks, onProgress) {
  const profile = store.get('profile2', null) || { aliasOf: {} };
  const map = {};
  const names = {};
  const freq = {};
  tracks.forEach((t) => t.artists.forEach((a) => { names[a.id] = a.name; freq[a.id] = (freq[a.id] || 0) + 1; }));
  Object.keys(names).forEach((id) => {
    const al = (profile.aliasOf || {})[id] ? aliasByLabel(profile.aliasOf[id]) : aliasOfArtist({ id, name: names[id], genres: [] });
    if (al) map[id] = al.label;
  });
  const spread = () => tracks.forEach((t) => {
    const known = t.artists.map((a) => map[a.id]).find(Boolean);
    if (known) t.artists.forEach((a) => { if (!map[a.id]) map[a.id] = known; });
  });
  spread(); spread();
  const counts = {};
  Object.values(map).forEach((l) => { counts[l] = (counts[l] || 0) + 1; });
  const candidates = [...new Set([...Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, 5), 'corridos tumbados', 'reguetón', 'trap latino', 'rap', 'pop latino'])].slice(0, 7).map(aliasByLabel).filter(Boolean);
  const unknown = Object.keys(names).filter((id) => !map[id]).sort((a, b) => freq[b] - freq[a]).slice(0, 40);
  let done = 0;
  let stop = false;
  await pool(unknown, 2, async (id) => {
    for (const al of candidates) {
      if (stop) break;
      try {
        const r = await sp('/search', { query: { q: `artist:"${names[id]}" genre:"${al.genres[0]}"`, type: 'track', limit: 1 } });
        const t = r && r.tracks && r.tracks.items && r.tracks.items[0];
        if (t && t.artists.some((x) => x.id === id)) { map[id] = al.label; break; }
      } catch (e) { if (e.status === 429) stop = true; break; }
    }
    if (onProgress) onProgress(++done, unknown.length);
  });
  spread();
  learnAliases(Object.entries(map));
  return map;
}

function plNameOf(trackArtistIds, map) {
  for (const id of trackArtistIds) {
    const al = map[id] && aliasByLabel(map[id]);
    if (al) return al.pl;
  }
  return null;
}

async function createPlaylist(name) {
  const body = { name, public: false, description: 'Tus Me gusta de este género, ordenados por Natalia' };
  try { return await sp('/me/playlists', { method: 'POST', body }); }
  catch {
    const me = await sp('/me');
    return sp(`/users/${encodeURIComponent(me.id)}/playlists`, { method: 'POST', body });
  }
}
async function addToPlaylist(id, uris) {
  for (let i = 0; i < uris.length; i += 100) {
    const chunk = uris.slice(i, i + 100);
    try { await sp(`/playlists/${id}/items`, { method: 'POST', body: { uris: chunk } }); }
    catch { await sp(`/playlists/${id}/tracks`, { method: 'POST', body: { uris: chunk } }); }
  }
}

async function organizeLiked(bubble) {
  const say = (t) => { bubble.textContent = t; };
  const org = store.get('organizer', { at: 0, playlists: {} });
  say('Leyendo tus Me gusta…');
  const liked = await fetchAllLiked((d, t) => say(`Leyendo tus Me gusta… ${d} de ${t}`));
  store.set('likedUris', liked.map((i) => i.track.uri));
  const fresh = liked.filter((i) => !org.at || Date.parse(i.added_at) > org.at);
  if (!fresh.length) { say('Tus Me gusta ya están organizados. Desde ahora, cada ❤ va también a la playlist de su género.'); return; }
  say(`Viendo el género de ${fresh.length} canciones…`);
  const cache = await classifyArtists(fresh.map((i) => i.track), (d, t) => say(`Viendo el género de tus artistas… ${d} de ${t}`));
  const groups = {};
  fresh.forEach((i) => {
    const pl = plNameOf(i.track.artists.map((a) => a.id), cache) || 'Otros';
    (groups[pl] = groups[pl] || []).push(i.track.uri);
  });
  // Géneros con muy pocas canciones van a "Otros" (solo la primera vez, para no llenar tu Spotify de playlists).
  Object.keys(groups).forEach((pl) => {
    if (pl !== 'Otros' && groups[pl].length < 5 && !org.playlists[pl]) {
      groups.Otros = (groups.Otros || []).concat(groups[pl]); delete groups[pl];
    }
  });
  const names = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length);
  if (names.length === 1 && names[0] === 'Otros' && !org.at) {
    say('No logré saber el género de tus artistas, así que no creé nada para no hacerte un desorden. Pídeme música un rato (así aprendo géneros) y vuelve a intentarlo.');
    return;
  }
  let n = 0;
  for (const pl of names) {
    say(`Creando playlists… ${++n} de ${names.length} (${pl})`);
    if (!org.playlists[pl]) { const p = await createPlaylist('Natalia · ' + pl); org.playlists[pl] = p.id; }
    await addToPlaylist(org.playlists[pl], groups[pl]);
  }
  org.at = Date.now();
  store.set('organizer', org);
  say(`¡Listo! Organicé ${fresh.length} canciones en ${names.length} playlists:\n` +
    names.map((pl) => `• Natalia · ${pl} (${groups[pl].length})`).join('\n') +
    '\n\nDesde ahora, cada ❤ que des se guarda en tus Me gusta y también en la playlist de su género.');
}

// Cuando das ❤: también va a la playlist de su género (si ya organizaste tus Me gusta).
async function fileByGenre(track) {
  const org = store.get('organizer', null);
  if (!org || !org.at) return '';
  const cache = await classifyArtists([{ artists: (track.artistIds || []).map((id, i) => ({ id, name: (track.artistNames || [])[i] || '' })) }]);
  const pl = plNameOf(track.artistIds || [], cache) || 'Otros';
  if (!org.playlists[pl]) { const p = await createPlaylist('Natalia · ' + pl); org.playlists[pl] = p.id; store.set('organizer', org); }
  await addToPlaylist(org.playlists[pl], [track.uri]);
  const liked = store.get('likedUris', []); liked.push(track.uri); store.set('likedUris', liked.slice(-6000));
  return 'Natalia · ' + pl;
}

// ---------- ❤ y 👎: Natalia aprende ----------
function learn(track, delta) {
  const m = memory();
  m.genres = m.genres || {};
  m.artists = m.artists || {};
  const last = store.get('lastSession', null);
  let key = last && last.uris && last.uris.includes(track.uri) ? last.key : '';
  if (!key) {
    const cache = store.get('artistGenres', {});
    const al = (track.artistIds || []).map((id, i) => aliasOfArtistGenres(cache[id]) || aliasOfArtist({ id, name: (track.artistNames || [])[i] || '', genres: [] })).find(Boolean);
    key = al ? al.label : '';
  }
  if (key) m.genres[key] = Math.max(-5, Math.min(10, (m.genres[key] || 0) + delta));
  (track.artistIds || []).slice(0, 1).forEach((id) => { m.artists[id] = (m.artists[id] || 0) + delta; });
  if (delta > 0) {
    m.loved.push({ uri: track.uri, label: track.label, at: Date.now() });
    m.disliked = m.disliked.filter((x) => x.uri !== track.uri);
  } else {
    m.disliked.push({ uri: track.uri, label: track.label, at: Date.now() });
  }
  saveMemory(m);
}

async function rate(love) {
  await refreshNowPlaying(true);
  if (!current) { addMessage('sofia', 'No veo nada sonando ahora mismo.'); return; }
  const track = current;
  learn(track, love ? 1 : -1);
  if (love) {
    await saveToLiked(track);
    let where = '';
    try { where = await fileByGenre(track); } catch { /* si falla, al menos quedó en Me gusta */ }
    addMessage('sofia', `❤ "${track.label}" guardada en tus Me gusta${where ? ` y en ${where}` : ''}. Te pondré más de este estilo.`);
  } else {
    addMessage('sofia', `👎 Entendido, no te vuelvo a poner "${track.label}" y le bajo a ese estilo.`);
    await sp('/me/player/next', { method: 'POST' });
  }
}

// ---------- Flujo principal: un pedido ----------
let busy = false;
let lastSpokenByVoice = false;

let retryTimer = null;
let queuedText = null;
async function handleRequest(text, retryOf) {
  text = text.trim();
  if (!text) return;
  if (!retryOf && retryTimer) { clearTimeout(retryTimer); retryTimer = null; } // lo nuevo que pidas manda
  if (busy) { if (!retryOf) { queuedText = text; } return; }
  if (!settings().clientId) { showSetup(true); addMessage('error', 'Me falta tu Client ID de Spotify en Ajustes.'); return; }
  if (!store.get('token', null)) { showSetup(true); addMessage('error', 'Primero conéctame a tu Spotify con el botón verde.'); return; }
  busy = true;
  if (!retryOf) { addMessage('user', text); pushHistory('user', text); }
  const t = norm(text).replace(/^(ve |oye )?(sofi|sofia|nati|natalia)\b ?/, '').replace(/ (por favor|porfa)$/, '').trim();
  const cmd = COMMANDS.find((c) => c.re.test(t));
  if (cmd) {
    try { await cmd.run(); if (cmd.say) addMessage('sofia', cmd.say); setTimeout(refreshNowPlaying, 700); }
    catch (e) { addMessage('error', friendlyError(e)); }
    busy = false; return;
  }
  if (RX.organize.test(t)) {
    const b = addMessage('sofia', 'Voy a organizar tus Me gusta por género. Esto sí tarda un poco (es una sola vez)…');
    try { await organizeLiked(b); } catch (e) { addMessage('error', 'No pude terminar de organizar: ' + friendlyError(e)); }
    busy = false; return;
  }
  // Memoria de la conversación: "pon más", "otras", "más nuevas"… siguen con lo último que pediste.
  let request = text;
  let extra = {};
  const last = retryOf ? null : store.get('lastRequest', null);
  if (retryOf) extra = { ...retryOf, retry: true };
  const FOLLOW = /^(y )?(pon(me)? |dame |quiero |echale )?(mas|otras?|otros?|sigue|seguir|continua|lo mismo|igual|otra tanda|mas canciones|mas temas|mas de eso|mas asi)( (de )?(eso|esas?|esos?|asi|parecid\w*|igual\w*|similares?|canciones|temas|del mismo|de lo mismo|estilo))*$/;
  const TWEAK = /^(y |pero |ahora )?(pon(me)? |dame )?(mas |las |unas |solo )?(nuev|recient|viej|antigu|clasic|popular|famos|pegad|menos|joyit|rarez|tranquil|suave)\w*( \w+){0,3}$/;
  if (last && FOLLOW.test(t)) { request = last.key && aliasByLabel(last.key) && !interpret(last.text).genre && !interpret(last.text).artistQuery ? last.key : last.text; extra = { more: true }; }
  else if (last && TWEAK.test(t) && !interpret(t).artistQuery && !interpret(t).genre) { request = last.text + ' ' + t; extra = { more: true }; }
  const thinking = addMessage('sofia thinking', 'Armando tu sesión…');
  try {
    const session = await buildSession(request, extra);
    store.set('lastRequest', { text: request, key: session.key, at: Date.now() });
    growLimit();
    if (session.key && aliasByLabel(session.key)) { const m = memory(); m.asked = m.asked || {}; m.asked[session.key] = Math.min(20, (m.asked[session.key] || 0) + 0.5); saveMemory(m); }
    store.set('lastSession', { key: session.key, uris: session.tracks.map((x) => x.uri) });
    const tracks = session.tracks;
    if (tracks.length < 5 && lastSearchError && lastSearchError.status === 429 && !extra.retry) throw lastSearchError;
    if (!tracks.length) {
      if (lastSearchError) throw lastSearchError;
      throw new Error('No encontré canciones para eso. Dímelo de otra forma, por ejemplo "pon corridos" o "pon Natanael Cano".');
    }
    const playing = playUris(tracks.map((t) => t.uri), tracks[0]);
    playing.catch(() => {});
    thinking.remove();
    const msg = session.intro;
    const answer = { nombre_sesion: session.label.charAt(0).toUpperCase() + session.label.slice(1) };
    const bubble = addMessage('sofia', msg);
    pushHistory('sofia', msg);
    const list = document.createElement('ol');
    list.className = 'tracklist';
    tracks.forEach((t) => { const li = document.createElement('li'); li.textContent = labelOf(t); list.appendChild(li); });
    bubble.appendChild(list);
    const actions = document.createElement('div');
    actions.className = 'actions';
    const btnSave = document.createElement('button');
    btnSave.textContent = 'Guardar como playlist';
    btnSave.onclick = async () => {
      btnSave.disabled = true;
      try {
        const name = 'Natalia · ' + (answer.nombre_sesion || 'Sesión') + ' · ' + new Date().toLocaleDateString('es');
        await savePlaylist(name, tracks.map((t) => t.uri));
        btnSave.textContent = 'Guardada en tu Spotify ✓';
      } catch (e) { btnSave.textContent = 'No se pudo guardar'; addMessage('error', e.message); }
    };
    const btnReplay = document.createElement('button');
    btnReplay.textContent = 'Volver a ponerla';
    btnReplay.onclick = () => playUris(tracks.map((t) => t.uri)).catch((e) => addMessage('error', e.message));
    actions.append(btnReplay, btnSave);
    bubble.appendChild(actions);
    const m = memory();
    tracks.forEach((t) => m.suggested.push({ uri: t.uri, label: labelOf(t), at: Date.now() }));
    saveMemory(m);
    speak(msg);
    await playing;
  } catch (e) {
    thinking.remove();
    const shortWait = !e.search || (searchBlockedUntil - Date.now()) <= 25000;
    if (e.status === 429 && shortWait && !extra.retry && (e.retryAfter || 0) <= 20) {
      const secs = Math.min(20, Math.max(2, e.search ? Math.ceil((searchBlockedUntil - Date.now()) / 1000) : (e.retryAfter || 3)));
      addMessage('sofia', `Spotify me pidió esperar ${secs} segundos. Lo intento sola en cuanto pase, no hagas nada.`);
      retryTimer = setTimeout(() => { retryTimer = null; handleRequest(request, extra); }, secs * 1000 + 300);
      return;
    }
    addMessage('error', friendlyError(e));
  } finally {
    busy = false;
    if (queuedText) { const q = queuedText; queuedText = null; setTimeout(() => handleRequest(q), 0); }
  }
}

function friendlyError(e) {
  if (e.message === 'NO_LOGIN') return 'Necesito que me conectes a Spotify (Ajustes ⚙︎).';
  if (e.message === 'SEARCH_BLOCKED' || (e.status === 429 && e.search)) return `Spotify le bloqueó a tu app las búsquedas por un rato${searchBlocked() ? ` (unos ${Math.max(1, Math.ceil((searchBlockedUntil - Date.now()) / 60000))} min)` : ''}, por lo mucho que buscaban las versiones viejas. Mientras tanto sí funciona: "Mis gustos", "Lo nuevo" y artistas que ya escuchas (por ejemplo "pon Natanael Cano").`;
  if (e.message === 'NO_DEVICE') return 'Spotify está cerrado. Ábrelo, dale play a cualquier canción y vuelve a pedírmelo: arranca al instante.';
  if (e.status === 403 && /restriction/i.test(e.message)) return 'Spotify no dejó cambiar la música en este momento. Abre Spotify, dale play a algo y vuelve a pedírmelo.';
  if (e.status === 429) return `Spotify me pidió una pausa${e.retryAfter ? ` de ${Math.ceil(e.retryAfter)} segundos` : ''}. Vuelve a pedírmelo en un momento.`;
  if (e.status === 403 && /premium/i.test(e.message)) return 'Spotify pide Premium para controlar la reproducción.';
  if (e.status === 403) return 'Spotify no me dejó (403: ' + e.message + '). Revisa en Spotify for Developers que tu correo esté en "User Management" de tu app.';
  if (e.status === 404 && /device/i.test(e.message)) return 'No encuentro Spotify activo. Abre Spotify en el iPhone, pon algo un segundo y vuelve a pedírmelo.';
  return e.status ? `Spotify dijo: ${e.message} (código ${e.status})` : (e.message || 'Algo falló.');
}

// ---------- Voz ----------
function speak(text) {
  if (!lastSpokenByVoice || !('speechSynthesis' in window)) return;
  lastSpokenByVoice = false;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'es-MX';
  u.rate = 1.05;
  speechSynthesis.speak(u);
}

function setupMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btn = $('btnMic');
  if (!SR) {
    btn.onclick = () => { $('inMsg').focus(); addMessage('sofia', 'Para hablarme, toca el micrófono del teclado del iPhone y dicta tu pedido.'); };
    return;
  }
  let rec = null;
  btn.onclick = () => {
    if (rec) { rec.stop(); return; }
    rec = new SR();
    rec.lang = 'es-419';
    rec.interimResults = true;
    rec.continuous = false;
    let finalText = '';
    rec.onresult = (ev) => {
      const t = Array.from(ev.results).map((r) => r[0].transcript).join(' ');
      $('inMsg').value = t;
      if (ev.results[ev.results.length - 1].isFinal) finalText = t;
    };
    rec.onerror = () => {};
    rec.onend = () => {
      btn.classList.remove('listening');
      rec = null;
      const text = (finalText || $('inMsg').value).trim();
      if (text) { $('inMsg').value = ''; lastSpokenByVoice = true; handleRequest(text); }
    };
    btn.classList.add('listening');
    rec.start();
  };
}

// ---------- Reproductor y valoraciones ----------
let current = null;

async function refreshNowPlaying(force) {
  if (!store.get('token', null) || pausedUntil > Date.now()) return;
  if (!force && (document.hidden || busy || budgetLeft() < 4)) return;
  try {
    const r = await sp('/me/player');
    const item = r && r.item;
    if (!item) { current = null; $('npTitle').textContent = 'Nada sonando'; $('npArtist').textContent = 'Abre Spotify y pídele algo a Natalia'; $('npArt').removeAttribute('src'); return; }
    current = { uri: item.uri, id: item.id, artistIds: (item.artists || []).map((a) => a.id), artistNames: (item.artists || []).map((a) => a.name), label: `${(item.artists || []).map((a) => a.name).join(', ')} - ${item.name}`, playing: r.is_playing };
    $('npTitle').textContent = item.name;
    $('npArtist').textContent = (item.artists || []).map((a) => a.name).join(', ');
    const img = item.album && item.album.images && item.album.images[item.album.images.length > 1 ? 1 : 0];
    if (img) $('npArt').src = img.url;
  } catch { /* sin conexión o sin reproductor: lo intentamos luego */ }
}

function setupPlayer() {
  const act = (fn) => async () => {
    try { await fn(); setTimeout(refreshNowPlaying, 700); } catch (e) { addMessage('error', friendlyError(e)); }
  };
  $('btnNext').onclick = act(() => sp('/me/player/next', { method: 'POST' }));
  $('btnPrev').onclick = act(() => sp('/me/player/previous', { method: 'POST' }));
  $('btnPlay').onclick = act(async () => {
    const r = await sp('/me/player');
    if (r && r.is_playing) await sp('/me/player/pause', { method: 'PUT' });
    else await sp('/me/player/play', { method: 'PUT' });
  });
  $('btnLove').onclick = act(() => rate(true));
  $('btnDislike').onclick = act(() => rate(false));
  setInterval(() => { if (!busy) refreshNowPlaying(); }, 45000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !busy) refreshNowPlaying(); });
}

// ---------- Ajustes ----------
function fillSetup() {
  const s = settings();
  $('inClientId').value = s.clientId;
  $('inCount').value = s.count;
  const connected = !!store.get('token', null);
  $('spotifyStatus').textContent = connected ? 'Spotify: conectado ✓' : 'Spotify: no conectado';
  $('btnLogin').textContent = connected ? 'Volver a conectar Spotify' : 'Conectar con Spotify';
  $('btnLogout').classList.toggle('hidden', !connected);
}

function setupSettings() {
  $('btnSettings').onclick = () => { fillSetup(); showSetup($('setup').classList.contains('hidden')); };
  $('btnSaveSetup').onclick = () => {
    const id = $('inClientId').value.replace(/\s+/g, '');
    $('inClientId').value = id;
    if (!/^[0-9a-f]{32}$/i.test(id)) { addMessage('error', 'Ese Client ID no se ve bien: deben ser 32 letras y números, sin espacios. Cópialo otra vez de Spotify for Developers.'); return; }
    store.set('clientId', id);
    store.set('count', Math.min(40, Math.max(5, Number($('inCount').value) || DEFAULT_COUNT)));
    fillSetup();
    if (store.get('token', null)) { addMessage('sofia', 'Guardado.'); return; }
    // Sin conexión todavía: voy directo a Spotify para conectar (sin buscar otro botón).
    addMessage('sofia', 'Guardado. Te llevo a Spotify para conectar…');
    login();
  };
  $('btnLogin').onclick = login;
  $('btnLogout').onclick = () => { store.del('token'); store.del('profile2'); fillSetup(); addMessage('sofia', 'Desconecté tu Spotify.'); };
  $('btnShowCode').onclick = () => {
    const t = store.get('token', null);
    $('inTransfer').value = t && t.refresh ? t.refresh : '';
    addMessage('sofia', t ? 'Ese es tu código de conexión. Cópialo y pégalo en Ajustes de Natalia en la otra ventana.' : 'Aún no hay conexión con Spotify en esta ventana.');
  };
  $('btnUseCode').onclick = async () => {
    const code = $('inTransfer').value.trim();
    if (!code) return;
    try {
      await tokenRequest({ grant_type: 'refresh_token', refresh_token: code, client_id: settings().clientId });
      fillSetup();
      addMessage('sofia', '¡Conectada a tu Spotify!');
      await loadProfile(true);
    } catch (e) { addMessage('error', 'Ese código no funcionó: ' + e.message); }
  };
  $('btnResetBlock').onclick = () => {
    ['searchBlockedUntil', 'searchBlockInfo', 'apilog'].forEach((k) => store.del(k));
    searchBlockedUntil = 0; pausedUntil = 0; apiLog.length = 0;
    addMessage('sofia', `Reinicié el bloqueo y la pausa. Voy a probar la búsqueda de verdad con el Client ID …${String(settings().clientId).slice(-4)}. Pídeme algo.`);
  };
  $('btnForget').onclick = () => { store.del('memory'); store.del('chat'); addMessage('sofia', 'Borré mi memoria de valoraciones y canciones sugeridas.'); };
}

// ---------- Arranque ----------
const VERSION = 'v13 · 18 nov';

// Modo diagnóstico: toca 5 veces el logo "N" y Natalia muestra cada llamada que hizo a Spotify.
function showDiagnostics() {
  const last = apiLog.slice(-40);
  const n429 = apiLog.filter((x) => x.s === 429 && x.t > Date.now() - 600000).length;
  const hhmmss = (t) => new Date(t).toLocaleTimeString('es', { hour12: false });
  const text = `Diagnóstico Natalia ${VERSION}\n` +
    `Llamadas a Spotify: ${callsSince(30000)} en 30 s · ${callsSince(60000)} en 1 min · ${callsSince(600000)} en 10 min\n` +
    `Pausas pedidas por Spotify (429) en 10 min: ${n429}${pausedUntil > Date.now() ? ` · en pausa ${Math.ceil((pausedUntil - Date.now()) / 1000)} s más` : ''}\n` +
    `Client ID en uso: …${String(settings().clientId).slice(-4)} · Redirect: ${REDIRECT_URI}\n` +
    `Bloqueo: ${(() => { const i = store.get('searchBlockInfo', null); return i ? `lo puso Spotify a las ${hhmmss(i.at)} (motivo: ${i.reason}, Client …${i.client}, ${i.ver})` : searchBlocked() ? 'guardado de antes (no lo puso esta versión)' : 'ninguno'; })()}\n` +
    `Búsquedas: ${searchBlocked() ? `bloqueadas por Spotify ${Math.ceil((searchBlockedUntil - Date.now()) / 60000)} min más (uso otros caminos)` : 'funcionando'}\n\n` +
    last.map((x) => `${hhmmss(x.t)} ${x.s}${x.r ? ' ' + x.r : ''} ${x.m} ${x.p}${x.ra ? ' espera ' + x.ra + 's' : ''} ${x.ms}ms ${x.v && x.v !== VERSION ? '(' + x.v + ')' : ''}`).join('\n');
  const b = addMessage('sofia', text);
  b.style.fontSize = '12px';
  const copy = document.createElement('button');
  copy.textContent = 'Copiar diagnóstico';
  copy.onclick = async () => { try { await navigator.clipboard.writeText(text); copy.textContent = 'Copiado ✓'; } catch { copy.textContent = 'No se pudo copiar'; } };
  const actions = document.createElement('div'); actions.className = 'actions'; actions.appendChild(copy); b.appendChild(actions);
}
function setupDiagnostics() {
  let taps = [];
  const logo = document.querySelector('.logo');
  if (!logo) return;
  logo.addEventListener('click', () => {
    taps = [...taps.filter((t) => Date.now() - t < 3000), Date.now()];
    if (taps.length >= 5) { taps = []; showDiagnostics(); }
  });
}
async function init() {
  setupDiagnostics();
  const v = document.getElementById('version'); if (v) v.textContent = `${VERSION} · …${String(settings().clientId).slice(-4)}`;
  setupSettings();
  setupPlayer();
  setupMic();
  document.querySelectorAll('#chips button').forEach((b) => { b.onclick = () => handleRequest(b.dataset.q); });
  $('composer').onsubmit = (ev) => { ev.preventDefault(); const t = $('inMsg').value; $('inMsg').value = ''; handleRequest(t); };

  if (await handleRedirect()) { fillSetup(); refreshNowPlaying(); return; }

  const s = settings();
  if (!s.clientId || !store.get('token', null)) {
    fillSetup();
    showSetup(true);
    addMessage('sofia', s.clientId ? '¡Hola! Soy Natalia, tu DJ. Toca "Conectar con Spotify" y listo.' : `¡Hola! Soy Natalia, tu DJ. Para empezar, pega tu Client ID de Spotify, toca Guardar y luego "Conectar con Spotify".\n\nEn Spotify for Developers, esta debe ser la Redirect URI:\n${REDIRECT_URI}`);
    return;
  }
  addMessage('sofia', '¡Hola! Abre Spotify y pídeme lo que quieras: "pon corridos", "pon Natanael Cano", "un género nuevo", "lo que se escucha en Puerto Rico", "organiza mis me gusta por géneros"…');
  const p = store.get('profile2', null);
  if (!p || !p.aliasOf) loadProfile(true).catch(() => {}); // primero que nada: leer tus gustos
  else {
    const sum = tasteSummary(p);
    if (sum) addMessage('sofia', 'Tus gustos ahora mismo:\n' + sum);
    if (Date.now() - p.at > 24 * 3600 * 1000) setTimeout(() => { if (!busy) loadProfile(true, true).catch(() => {}); }, 30000); // una vez al día, en segundo plano
  }
  refreshNowPlaying();
}

init();
