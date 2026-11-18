/* SOFIA DJ — web app personal que conversa contigo y pone música en tu Spotify.
 * Todo corre en tu teléfono, sin IA externa: entiende tu pedido al instante y arma sesiones de un solo género.
 */
'use strict';

// ---------- Configuración y almacenamiento ----------
const SCOPES = [
  'user-top-read', 'user-read-recently-played', 'user-library-read', 'user-library-modify',
  'user-read-playback-state', 'user-modify-playback-state', 'user-read-currently-playing',
  'playlist-modify-private', 'playlist-modify-public',
].join(' ');
const DEFAULT_COUNT = 15;
const REDIRECT_URI = location.origin + location.pathname.replace(/index\.html$/, '');

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

const settings = () => ({
  clientId: store.get('clientId', ''),
  count: Number(store.get('count', DEFAULT_COUNT)) || DEFAULT_COUNT,
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
  location.href = 'https://accounts.spotify.com/authorize?' + params;
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

async function sp(path, { method = 'GET', body, query } = {}, retried = false, waits = 0) {
  const token = await getAccessToken();
  const url = new URL('https://api.spotify.com/v1' + path);
  if (query) Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, {
    method,
    headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !retried) {
    const t = store.get('token', {}); t.expiresAt = 0; store.set('token', t);
    return sp(path, { method, body, query }, true);
  }
  if (res.status === 429 && waits < 2) {
    const secs = Math.min(5, Number(res.headers.get('Retry-After')) || 2);
    await new Promise((r) => setTimeout(r, secs * 1000));
    return sp(path, { method, body, query }, retried, waits + 1);
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
async function loadProfile(force) {
  const cached = store.get('profile2', null);
  if (!force && cached && Date.now() - cached.at < 12 * 3600 * 1000) return cached;
  const calls = await Promise.allSettled([
    sp('/me/top/artists', { query: { time_range: 'medium_term', limit: 50 } }),
    sp('/me/top/artists', { query: { time_range: 'long_term', limit: 50 } }),
    sp('/me/top/artists', { query: { time_range: 'short_term', limit: 50 } }),
    sp('/me/top/tracks', { query: { time_range: 'short_term', limit: 50 } }),
    sp('/me/top/tracks', { query: { time_range: 'medium_term', limit: 50 } }),
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
  store.set('profile2', profile);
  if (force) {
    const top = profile.artists.slice(0, 5).map((a) => a.name).join(', ') || 'todavía no tengo datos suficientes';
    const g = profile.genres.slice(0, 4).join(', ');
    addMessage('sofia', `Ya te conozco: escuchas mucho a ${top}${g ? `. Tus géneros fuertes: ${g}` : ''}. ¿Qué te pongo?`);
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
  };
}
const labelOf = (t) => `${t.artists.join(', ')} - ${t.name}`;

// ---------- Intérprete propio (instantáneo, sin IA) ----------
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9& ]/g, ' ').replace(/\s+/g, ' ').trim();

// Géneros que entiende SOFIA. "genres" son los nombres que usa Spotify (el primero es el principal),
// "fam" agrupa géneros parecidos y "pl" es el nombre de la playlist cuando organiza tus Me gusta.
// Van de lo más específico a lo más general.
const GENRE_ALIASES = [
  { re: /corridos? belicos?|belicos?/, label: 'corridos bélicos', genres: ['corridos belicos', 'corrido'], fam: 'mexicano', pl: 'Corridos' },
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

// A qué género de SOFIA pertenece un género de Spotify (por ejemplo "latin hip hop" -> rap en español).
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
const FILLER = /\b(sofia|sofi|ve|oye|hola|por favor|porfa|ponme|pon|ponga|pongas|reproduce|reproducir|quiero|quisiera|escuchar|oir|un|una|unos|unas|tema|temas|cancion|canciones|musica|de|del|la|el|los|las|algo|me|mi|mis|que|y|en|con|a|al|hoy|ahora|solo|puro|pura|puros|full|mas|otra|otras|otro|otros|bien|tipo|artistas?|parecid[oa]s?|similares?|estilo|como|recomiendame|recomienda|recomendar|dame|music|gente|esta|estan|estos|dias|escuchando|escucha|suena|sonando|pais)\b/g;
const STOP_STEM = /^(moda|nuev|tendenc|recient|estren|actual|momento|pegand|viral|lanzamient|viej|antigu|clasic|descubr|sorprend|nunca|conozc|escuchad|distint|genero|gust|favorit|relaj|tranquil|dormir|descans|motiv|energ|entren|ejercic|fiesta|rumba|prend|parche|parecid|similar|estilo|recomiend|ingles|espanol|siempre|sesion|playlist|ponme|sofia|gimnas|concentr|estudi|semana|escuch|oig)/;
const STOP_EXACT = new Set(['pon', 'no', 'nada', 'todo', 'esa', 'eso', 'este', 'lo', 'le', 'se', 'su', 'sus', 'para', 'haya', 'antes', 'old', 'school', 'dj', 'lista', 'calma', 'calmada', 'suave', 'chill', 'gym', 'activa', 'activo', 'activarme', 'totalmente', 'diferente', 'gym', 'pesas', 'correr', 'animo', 'top']);

function interpret(text) {
  const t = norm(text);
  let genre = null;
  let rest = t;
  for (const g of GENRE_ALIASES) {
    if (g.re.test(t)) { genre = g; rest = rest.replace(g.re, ' '); break; }
  }
  const country = COUNTRIES.find((c) => c.re.test(t)) || null;
  if (country) rest = rest.replace(country.re, ' ');
  const mode = {};
  Object.keys(RX).forEach((k) => { mode[k] = RX[k].test(t); });
  if (mode.newGenre) mode.discover = true;
  rest = rest.replace(FILLER, ' ').split(' ').filter((w) => w && !STOP_EXACT.has(w) && !STOP_STEM.test(w)).join(' ');
  const artistQuery = rest.length >= 2 && !mode.likes ? rest : '';
  return { t, genre, mode, country, artistQuery };
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

async function searchTracks(q, offset = 0, market) {
  const r = await spSearch(q, 'track', offset, market);
  return ((r && r.tracks && r.tracks.items) || []).filter(Boolean).map(simplify);
}

async function findArtist(name) {
  try {
    const r = await spSearch(name, 'artist', 0);
    const items = (r && r.artists && r.artists.items) || [];
    const n = norm(name);
    const exact = items.find((a) => norm(a.name) === n);
    const close = items.find((a) => norm(a.name).startsWith(n) || n.startsWith(norm(a.name)));
    const best = exact || close || items[0] || null;
    if (best) { rememberGenres(best.id, best.genres); best.exact = !!(exact || close); }
    return best;
  } catch { return null; }
}

// Junta varias búsquedas en paralelo (todas a la vez: así tarda lo que tarda la más lenta).
const gather = (queries, market) => Promise.all(queries.map(([q, off]) => searchTracks(q, off, market)));

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

// Géneros de artistas que SOFIA ya conoce (para clasificar y aprender sin volver a preguntarle a Spotify).
function rememberGenres(id, genres) {
  if (!id || !genres || !genres.length) return;
  const c = store.get('artistGenres', {});
  c[id] = genres.slice(0, 6);
  const keys = Object.keys(c);
  if (keys.length > 3000) keys.slice(0, keys.length - 3000).forEach((k) => delete c[k]);
  store.set('artistGenres', c);
}

// Cuánto escuchas cada género (según tus artistas) y cuánto te gustó con ❤ / 👎.
function tasteByGenre(profile) {
  const score = {};
  profile.artists.forEach((a) => {
    const al = aliasOfArtistGenres(a.genres);
    if (al) score[al.label] = (score[al.label] || 0) + a.score;
  });
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

function avoidFor(profile, strict) {
  const m = memory();
  const uris = new Set(m.disliked.map((x) => x.uri));
  if (strict) heardUris(profile).forEach((u) => uris.add(u));
  else m.suggested.slice(-80).forEach((x) => uris.add(x.uri));
  const artists = new Set(Object.entries(m.artists || {}).filter(([, s]) => s <= -2).map(([id]) => id));
  return { uris, artists };
}

// Sesión de un solo género.
async function genreSession(alias, mode, profile, { market, newGenre } = {}) {
  const count = settings().count;
  const discover = mode.discover || newGenre;
  const yf = yearFilter(mode);
  const known = new Set(profile.artists.map((a) => a.id));
  const base = discover ? 10 + rnd(4) * 10 : rnd(3) * 10;
  const [g1, g2] = alias.genres;
  const qs = [[`genre:"${g1}"${yf}`, base], [`genre:"${g1}"${yf}`, base + 10], [`genre:"${g1}"${yf}`, base + 20]];
  if (g2) qs.push([`genre:"${g2}"${yf}`, base], [`genre:"${g2}"${yf}`, base + 10]);
  if (discover) qs.push([`genre:"${g1}"${yf}`, 0]);
  let found = shuffle((await gather(qs, market)).flat());
  if (discover) found = found.filter((t) => !t.artistIds.some((id) => known.has(id)));
  if (found.length < 6) {
    const more = (await gather([[`genre:"${g1}"`, 0], [`genre:"${g1}"`, 10], [`${alias.label}${yf}`, 0]], market)).flat();
    found = found.concat(shuffle(more));
  }
  const mine = discover ? [] : shuffle(profile.tracks.filter((t) => t.artistIds.some((id) => {
    const a = profile.artists.find((x) => x.id === id);
    return a && aliasOfArtistGenres(a.genres) === alias;
  })));
  const mineShare = mode.likes ? Math.ceil(count * 0.6) : mode.fresh ? 0 : 4;
  let tracks = arrange([mine.slice(0, mineShare), found], count, avoidFor(profile, discover));
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
  const lists = await gather(c.artists.map((a) => [`artist:"${a}" year:${y - 1}-${y}`, 0]), c.market);
  const groups = lists.map((l, i) => l.filter((t) => t.artists.some((n) => norm(n) === norm(c.artists[i]))).slice(0, 3));
  return arrange(shuffle(groups), settings().count, avoidFor(profile, false));
}

async function motivationSession(profile) {
  const picks = shuffle(MOTIVATION).slice(0, settings().count + 3);
  const lists = await Promise.all(picks.map(([name, artist]) => searchTracks(`track:"${name}" artist:"${artist}"`, 0)));
  const tracks = lists.map((l, i) => l.find((t) => t.artists.some((a) => norm(a).includes(norm(picks[i][1])))) || null).filter(Boolean);
  const avoid = avoidFor(profile, false);
  avoid.uris = new Set(memory().disliked.map((x) => x.uri));
  return arrange(tracks.map((t) => [t]), settings().count, avoid);
}

// Arma la sesión. Siempre UN solo género, para que todo fluya.
async function buildSession(text) {
  const { genre, mode, country, artistQuery } = interpret(text);
  const profile = store.get('profile2', null) || await loadProfile(false);
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

  // Pidió un artista o algo que no reconocí: miro a la vez si es artista o género de Spotify.
  if (artistQuery) {
    const [artist, asGenre] = await Promise.all([
      findArtist(artistQuery),
      genre ? Promise.resolve([]) : searchTracks(`genre:"${artistQuery}"`, 0),
    ]);
    if (!genre && asGenre.length >= 5 && !(artist && artist.exact)) {
      const alias = { label: artistQuery, genres: [artistQuery], fam: artistQuery, pl: artistQuery };
      const tracks = await genreSession(alias, mode, profile);
      return { tracks, key: artistQuery, label: artistQuery, intro: `Sesión de ${artistQuery}, sin mezclar con otros géneros.` };
    }
    if (artist && (artist.exact || !genre)) {
      const al = aliasOfArtistGenres(artist.genres);
      const g = (artist.genres || [])[0];
      const yf = yearFilter(mode);
      const qs = [[`artist:"${artist.name}"`, 0], [`artist:"${artist.name}"`, 10]];
      if (g) qs.push([`genre:"${g}"${yf}`, rnd(2) * 10], [`genre:"${g}"${yf}`, 20], [`genre:"${g}"${yf}`, 30]);
      const lists = await gather(qs);
      const own = shuffle([...lists[0], ...lists[1]].filter((t) => t.artistIds.includes(artist.id)));
      const others = shuffle(lists.slice(2).flat().filter((t) => !t.artistIds.includes(artist.id)));
      const ownShare = mode.similar ? 2 : Math.ceil(count * 0.55);
      const tracks = arrange([own.slice(0, ownShare), others], count, avoidFor(profile, mode.discover));
      const label = mode.similar ? `parecidos a ${artist.name}` : artist.name;
      const intro = mode.similar ? `Artistas del estilo de ${artist.name}${g ? `, todo ${g}` : ''}.`
        : `Va ${artist.name}${g ? `, y para que fluya, más ${g} del mismo estilo` : ''}.`;
      return { tracks, key: al ? al.label : (g || artist.name), label, intro };
    }
    if (!genre) {
      const lists = await gather([[artistQuery, 0], [artistQuery, 10]]);
      return { tracks: arrange([lists.flat()], count, avoidFor(profile, false)), key: '', label: artistQuery, intro: `Esto encontré para "${artistQuery}".` };
    }
  }

  // Pidió un género: solo ese género.
  if (genre) {
    const tracks = await genreSession(genre, mode, profile);
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
  const alias = pickMyGenre(profile);
  if (!alias) {
    const y = new Date().getFullYear();
    const lists = await gather([[`year:${y}`, 0], [`year:${y}`, 10]]);
    return { tracks: arrange([lists.flat()], count, avoidFor(profile, false)), key: '', label: 'lo nuevo', intro: 'Aún no conozco tus géneros, así que va lo más nuevo. Dale ❤ a lo que te guste para aprender.' };
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

async function playUris(uris) {
  try {
    await sp('/me/player/play', { method: 'PUT', body: { uris } });
  } catch (e) {
    if (e.status !== 404 && e.status !== 403) throw e;
    const device = await pickDevice();
    if (!device) {
      throw new Error('No encuentro Spotify abierto. Abre la app de Spotify en tu iPhone, pon cualquier canción un segundo y vuelve a pedírmelo.');
    }
    await sp('/me/player/play', { method: 'PUT', query: { device_id: device.id }, body: { uris } });
  }
  setTimeout(refreshNowPlaying, 1200);
}

async function savePlaylist(name, uris) {
  let pl;
  try {
    pl = await sp('/me/playlists', { method: 'POST', body: { name, public: false, description: 'Creada por SOFIA, tu DJ' } });
  } catch (e) {
    const me = await sp('/me');
    pl = await sp(`/users/${encodeURIComponent(me.id)}/playlists`, { method: 'POST', body: { name, public: false, description: 'Creada por SOFIA, tu DJ' } });
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

// Géneros de cada artista (primero lo que SOFIA ya sabe, luego le pregunta a Spotify).
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

function plNameOf(trackArtistIds, cache) {
  for (const id of trackArtistIds) {
    const al = aliasOfArtistGenres(cache[id]);
    if (al) return al.pl;
  }
  return null;
}

async function createPlaylist(name) {
  const body = { name, public: false, description: 'Tus Me gusta de este género, ordenados por SOFIA' };
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
  const cache = await genresOf(fresh.flatMap((i) => i.track.artists.map((a) => a.id)));
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
    say('Spotify no me dio los géneros de tus artistas, así que no pude separarlos bien. No creé nada para no hacerte un desorden.');
    return;
  }
  let n = 0;
  for (const pl of names) {
    say(`Creando playlists… ${++n} de ${names.length} (${pl})`);
    if (!org.playlists[pl]) { const p = await createPlaylist('SOFIA · ' + pl); org.playlists[pl] = p.id; }
    await addToPlaylist(org.playlists[pl], groups[pl]);
  }
  org.at = Date.now();
  store.set('organizer', org);
  say(`¡Listo! Organicé ${fresh.length} canciones en ${names.length} playlists:\n` +
    names.map((pl) => `• SOFIA · ${pl} (${groups[pl].length})`).join('\n') +
    '\n\nDesde ahora, cada ❤ que des se guarda en tus Me gusta y también en la playlist de su género.');
}

// Cuando das ❤: también va a la playlist de su género (si ya organizaste tus Me gusta).
async function fileByGenre(track) {
  const org = store.get('organizer', null);
  if (!org || !org.at) return '';
  const cache = await genresOf(track.artistIds || []);
  const pl = plNameOf(track.artistIds || [], cache) || 'Otros';
  if (!org.playlists[pl]) { const p = await createPlaylist('SOFIA · ' + pl); org.playlists[pl] = p.id; store.set('organizer', org); }
  await addToPlaylist(org.playlists[pl], [track.uri]);
  const liked = store.get('likedUris', []); liked.push(track.uri); store.set('likedUris', liked.slice(-6000));
  return 'SOFIA · ' + pl;
}

// ---------- ❤ y 👎: SOFIA aprende ----------
function learn(track, delta) {
  const m = memory();
  m.genres = m.genres || {};
  m.artists = m.artists || {};
  const last = store.get('lastSession', null);
  let key = last && last.uris && last.uris.includes(track.uri) ? last.key : '';
  if (!key) {
    const cache = store.get('artistGenres', {});
    const al = (track.artistIds || []).map((id) => aliasOfArtistGenres(cache[id])).find(Boolean);
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
  await refreshNowPlaying();
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

async function handleRequest(text) {
  text = text.trim();
  if (!text || busy) return;
  if (!settings().clientId) { showSetup(true); addMessage('error', 'Me falta tu Client ID de Spotify en Ajustes.'); return; }
  if (!store.get('token', null)) { showSetup(true); addMessage('error', 'Primero conéctame a tu Spotify con el botón verde.'); return; }
  busy = true;
  addMessage('user', text);
  pushHistory('user', text);
  const t = norm(text).replace(/^(ve |oye )?(sofi|sofia)\b ?/, '').replace(/ (por favor|porfa)$/, '').trim();
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
  const thinking = addMessage('sofia thinking', 'Armando tu sesión…');
  try {
    const session = await buildSession(text);
    store.set('lastSession', { key: session.key, uris: session.tracks.map((x) => x.uri) });
    const tracks = session.tracks;
    if (!tracks.length) {
      if (lastSearchError) throw lastSearchError;
      throw new Error('No encontré canciones para eso. Dímelo de otra forma, por ejemplo "pon corridos" o "pon Natanael Cano".');
    }
    const playing = playUris(tracks.map((t) => t.uri));
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
        const name = 'SOFIA · ' + (answer.nombre_sesion || 'Sesión') + ' · ' + new Date().toLocaleDateString('es');
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
    addMessage('error', friendlyError(e));
  } finally {
    busy = false;
  }
}

function friendlyError(e) {
  if (e.message === 'NO_LOGIN') return 'Necesito que me conectes a Spotify (Ajustes ⚙︎).';
  if (e.status === 429) return 'Hay muchas peticiones seguidas. Espera un minuto y vuelve a intentarlo.';
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

async function refreshNowPlaying() {
  if (!store.get('token', null) || document.hidden) return;
  try {
    const r = await sp('/me/player');
    const item = r && r.item;
    if (!item) { current = null; $('npTitle').textContent = 'Nada sonando'; $('npArtist').textContent = 'Abre Spotify y pídele algo a SOFIA'; $('npArt').removeAttribute('src'); return; }
    current = { uri: item.uri, id: item.id, artistIds: (item.artists || []).map((a) => a.id), label: `${(item.artists || []).map((a) => a.name).join(', ')} - ${item.name}`, playing: r.is_playing };
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
  setInterval(refreshNowPlaying, 5000);
  document.addEventListener('visibilitychange', refreshNowPlaying);
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
    store.set('clientId', $('inClientId').value.trim());
    store.set('count', Math.min(40, Math.max(5, Number($('inCount').value) || DEFAULT_COUNT)));
    fillSetup();
    addMessage('sofia', store.get('token', null) ? 'Guardado.' : 'Guardado. Ahora toca "Conectar con Spotify".');
  };
  $('btnLogin').onclick = login;
  $('btnLogout').onclick = () => { store.del('token'); store.del('profile2'); fillSetup(); addMessage('sofia', 'Desconecté tu Spotify.'); };
  $('btnShowCode').onclick = () => {
    const t = store.get('token', null);
    $('inTransfer').value = t && t.refresh ? t.refresh : '';
    addMessage('sofia', t ? 'Ese es tu código de conexión. Cópialo y pégalo en Ajustes de SOFIA en la otra ventana.' : 'Aún no hay conexión con Spotify en esta ventana.');
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
  $('btnForget').onclick = () => { store.del('memory'); store.del('chat'); addMessage('sofia', 'Borré mi memoria de valoraciones y canciones sugeridas.'); };
}

// ---------- Arranque ----------
const VERSION = 'v4 · 18 nov';
async function init() {
  const v = document.getElementById('version'); if (v) v.textContent = VERSION;
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
    addMessage('sofia', `¡Hola! Soy SOFIA, tu DJ. Para empezar, pega tu Client ID de Spotify, toca Guardar y luego "Conectar con Spotify".\n\nEn Spotify for Developers, esta debe ser la Redirect URI:\n${REDIRECT_URI}`);
    return;
  }
  addMessage('sofia', '¡Hola! Abre Spotify y pídeme lo que quieras: "pon corridos", "pon Natanael Cano", "un género nuevo", "lo que se escucha en Puerto Rico", "organiza mis me gusta por géneros"…');
  const p = store.get('profile2', null);
  if (!p) loadProfile(false).catch(() => {});
  else if (Date.now() - p.at > 12 * 3600 * 1000) loadProfile(true).catch(() => {}); // se actualiza en segundo plano
  refreshNowPlaying();
}

init();
