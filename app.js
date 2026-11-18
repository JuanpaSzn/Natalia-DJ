/* SOFIA DJ — web app personal que conversa contigo y pone música en tu Spotify.
 * Todo corre en tu teléfono: las llaves y la memoria se guardan solo en este navegador.
 */
'use strict';

// ---------- Configuración y almacenamiento ----------
const SCOPES = [
  'user-top-read', 'user-read-recently-played', 'user-library-read', 'user-library-modify',
  'user-read-playback-state', 'user-modify-playback-state', 'user-read-currently-playing',
  'playlist-modify-private', 'playlist-modify-public',
].join(' ');
const DEFAULT_MODEL = 'gemini-flash-latest';
const DEFAULT_COUNT = 20;
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
  geminiKey: store.get('geminiKey', ''),
  model: store.get('model', DEFAULT_MODEL) || DEFAULT_MODEL,
  count: Number(store.get('count', DEFAULT_COUNT)) || DEFAULT_COUNT,
});

const memory = () => store.get('memory', { suggested: [], loved: [], disliked: [] });
const saveMemory = (m) => {
  m.suggested = m.suggested.slice(-400);
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

async function sp(path, { method = 'GET', body, query } = {}, retried = false) {
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
async function loadProfile(force) {
  const cached = store.get('profile', null);
  if (!force && cached && Date.now() - cached.at < 12 * 3600 * 1000) return cached;
  const calls = await Promise.allSettled([
    sp('/me/top/artists', { query: { time_range: 'medium_term', limit: 20 } }),
    sp('/me/top/artists', { query: { time_range: 'long_term', limit: 15 } }),
    sp('/me/top/tracks', { query: { time_range: 'short_term', limit: 20 } }),
    sp('/me/player/recently-played', { query: { limit: 30 } }),
    sp('/me/tracks', { query: { limit: 30 } }),
  ]);
  const val = (i) => (calls[i].status === 'fulfilled' && calls[i].value) || { items: [] };
  const artistsOf = (t) => (t.artists || []).map((a) => a.name).join(', ');
  const genres = {};
  [...val(0).items, ...val(1).items].forEach((a) => (a.genres || []).forEach((g) => { genres[g] = (genres[g] || 0) + 1; }));
  const uniq = (arr) => [...new Set(arr)];
  const profile = {
    at: Date.now(),
    artists: uniq([...val(0).items, ...val(1).items].map((a) => a.name)),
    genres: Object.entries(genres).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([g]) => g),
    topTracks: val(2).items.map((t) => `${artistsOf(t)} - ${t.name}`),
    recent: uniq(val(3).items.map((i) => i.track && `${artistsOf(i.track)} - ${i.track.name}`).filter(Boolean)).slice(0, 25),
    saved: val(4).items.map((i) => i.track && `${artistsOf(i.track)} - ${i.track.name}`).filter(Boolean),
  };
  store.set('profile', profile);
  if (force) {
    const top = profile.artists.slice(0, 6).join(', ') || 'todavía no tengo datos suficientes';
    const g = profile.genres.slice(0, 5).join(', ');
    addMessage('sofia', `Ya te conozco un poco: escuchas mucho a ${top}${g ? `, y tus géneros fuertes son ${g}` : ''}. ¿Qué quieres escuchar?`);
  }
  return profile;
}

// ---------- IA (Gemini, plan gratuito) ----------
const TREND_WORDS = /moda|tendenc|viral|pegando|nuev|actual|reciente|lanzamient|estren|top|popular|sonando/i;

function buildPrompt(userText, profile) {
  const m = memory();
  const { count } = settings();
  const lines = [
    `PERFIL DE ALEXIS`,
    `Artistas que más escucha: ${profile.artists.join('; ') || 'sin datos'}`,
    `Géneros detectados: ${profile.genres.join('; ') || 'sin datos'}`,
    `Canciones que más escucha últimamente: ${profile.topTracks.join('; ') || 'sin datos'}`,
    `Escuchó hace poco: ${profile.recent.join('; ') || 'sin datos'}`,
    `Guardó en favoritos hace poco: ${profile.saved.join('; ') || 'sin datos'}`,
    `Le encantaron (valoradas en SOFIA): ${m.loved.slice(-40).map((x) => x.label).join('; ') || 'ninguna aún'}`,
    `NO le gustaron (no las repitas, y evita lo muy parecido): ${m.disliked.slice(-60).map((x) => x.label).join('; ') || 'ninguna aún'}`,
    `Ya se las pusiste en sesiones anteriores (evita repetirlas): ${m.suggested.slice(-120).map((x) => x.label).join('; ') || 'ninguna aún'}`,
    '',
    'CONVERSACIÓN RECIENTE',
    ...chatHistory().slice(-6).map((h) => `${h.role === 'user' ? 'Alexis' : 'SOFIA'}: ${h.text}`),
    '',
    `PEDIDO AHORA: ${userText}`,
    '',
    `Responde SOLO con un objeto JSON, sin texto antes ni después, con esta forma exacta:`,
    `{"mensaje": "lo que le dices a Alexis, 1 a 3 frases, cálido y con onda de DJ", "nombre_sesion": "nombre corto de la sesión", "canciones": [{"artista": "Nombre", "titulo": "Título"}]}`,
    `Incluye ${count} canciones reales que existan en Spotify si el pedido es de música. Si solo está conversando, "canciones" va vacío.`,
  ];
  return lines.join('\n');
}

const SYSTEM = `Eres SOFIA, la DJ personal de Alexis. Hablas en español latino, cercana y breve, como una DJ que entiende el momento.
Reglas:
- Interpreta el pedido (género, ánimo, idioma, época, artista) y cruza con su perfil. "Que me guste" = sus artistas y otros muy parecidos. "Descubrir" o "nunca escuchado" = artistas que NO están en su perfil pero encajan con sus gustos. "Género nuevo" = un género vecino a los suyos que probablemente no escucha.
- "De moda" o "nuevo" = canciones recientes que están creciendo; si tienes búsqueda web, úsala para revisar qué está sonando ahora, y prioriza lo que encaje con sus gustos.
- Ordena la lista como un DJ: que fluya en energía y estilo, sin saltos bruscos de género o tempo; empieza enganchando y sube o baja la energía según el pedido.
- No repitas canciones que ya le pusiste ni las que no le gustaron. Varía artistas: máximo 2 canciones por artista salvo que pida un artista concreto.
- Solo nombra canciones que existan de verdad; escribe artista y título como aparecen en Spotify.
- Nunca inventes datos sobre Alexis que no estén en el perfil.`;

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('La IA no devolvió una lista válida.');
  return JSON.parse(text.slice(start, end + 1));
}

async function gemini(prompt, useSearch) {
  const { geminiKey, model } = settings();
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.9 },
  };
  if (useSearch) body.tools = [{ google_search: {} }];
  else body.generationConfig.responseMimeType = 'application/json';
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error((data.error && data.error.message) || ('Gemini respondió ' + res.status));
    e.status = res.status;
    throw e;
  }
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  return extractJson(parts.map((p) => p.text || '').join(''));
}

async function askDJ(userText) {
  const profile = store.get('profile', null) || await loadProfile(false);
  const prompt = buildPrompt(userText, profile);
  if (TREND_WORDS.test(userText)) {
    try { return await gemini(prompt, true); }
    catch (e) { if (e.status === 401 || e.status === 403) throw e; /* sin búsqueda web: seguimos sin ella */ }
  }
  return gemini(prompt, false);
}

// ---------- Buscar canciones en Spotify ----------
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

async function findTrack(song) {
  const artist = String(song.artista || '').trim();
  const title = String(song.titulo || '').trim();
  if (!title) return null;
  const tries = [
    `track:"${title.replace(/"/g, '')}" artist:"${artist.replace(/"/g, '')}"`,
    `${title} ${artist}`,
  ];
  for (const q of tries) {
    try {
      const r = await sp('/search', { query: { q, type: 'track', limit: 5 } });
      const items = (r && r.tracks && r.tracks.items) || [];
      const a = norm(artist).split(' ')[0];
      const pick = items.find((t) => !a || t.artists.some((x) => norm(x.name).includes(a))) || (q === tries[0] ? items[0] : null);
      if (pick) return { uri: pick.uri, id: pick.id, label: `${pick.artists.map((x) => x.name).join(', ')} - ${pick.name}` };
    } catch (e) {
      if (e.status === 429) await new Promise((r) => setTimeout(r, 1500));
    }
  }
  return null;
}

async function resolveSongs(songs) {
  const out = [];
  const queue = songs.slice();
  const workers = Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const song = queue.shift();
      const idx = songs.indexOf(song);
      const found = await findTrack(song);
      if (found) out.push({ idx, ...found });
    }
  });
  await Promise.all(workers);
  const m = memory();
  const banned = new Set([...m.disliked.map((x) => x.uri)]);
  const seen = new Set();
  return out.sort((a, b) => a.idx - b.idx).filter((t) => {
    if (banned.has(t.uri) || seen.has(t.uri)) return false;
    seen.add(t.uri); return true;
  });
}

// ---------- Reproducción ----------
async function pickDevice() {
  const r = await sp('/me/player/devices');
  const devices = (r && r.devices) || [];
  if (!devices.length) return null;
  return devices.find((d) => d.is_active) || devices.find((d) => d.type === 'Smartphone') || devices[0];
}

async function playUris(uris) {
  const device = await pickDevice();
  if (!device) {
    throw new Error('No encuentro Spotify abierto. Abre la app de Spotify en tu iPhone, pon cualquier canción un segundo y vuelve a pedírmelo.');
  }
  await sp('/me/player/play', { method: 'PUT', query: { device_id: device.id }, body: { uris } });
  setTimeout(refreshNowPlaying, 1500);
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

// ---------- Flujo principal: un pedido ----------
let busy = false;
let lastSpokenByVoice = false;

async function handleRequest(text) {
  text = text.trim();
  if (!text || busy) return;
  const s = settings();
  if (!s.clientId || !s.geminiKey) { showSetup(true); addMessage('error', 'Me falta configurarme: pega tus llaves en Ajustes.'); return; }
  if (!store.get('token', null)) { showSetup(true); addMessage('error', 'Primero conéctame a tu Spotify con el botón verde.'); return; }
  busy = true;
  addMessage('user', text);
  pushHistory('user', text);
  const thinking = addMessage('sofia thinking', 'Escogiendo canciones…');
  try {
    const answer = await askDJ(text);
    const songs = Array.isArray(answer.canciones) ? answer.canciones : [];
    const msg = String(answer.mensaje || '').trim() || 'Aquí va.';
    if (!songs.length) {
      thinking.remove();
      addMessage('sofia', msg);
      pushHistory('sofia', msg);
      speak(msg);
      return;
    }
    thinking.textContent = 'Buscando las canciones en Spotify…';
    const tracks = await resolveSongs(songs);
    thinking.remove();
    if (!tracks.length) throw new Error('No encontré esas canciones en Spotify. Pídemelo de otra forma.');
    const bubble = addMessage('sofia', msg);
    pushHistory('sofia', msg + ' [Puse: ' + tracks.slice(0, 8).map((t) => t.label).join('; ') + ']');
    const list = document.createElement('ol');
    list.className = 'tracklist';
    tracks.forEach((t) => { const li = document.createElement('li'); li.textContent = t.label; list.appendChild(li); });
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
    tracks.forEach((t) => m.suggested.push({ uri: t.uri, label: t.label, at: Date.now() }));
    saveMemory(m);
    speak(msg);
    await playUris(tracks.map((t) => t.uri));
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
  if (e.status === 403) return 'Spotify no me dejó hacer eso (403). Revisa que tu correo esté en "User Management" de tu app en Spotify for Developers.';
  if (e.status === 404 && /device/i.test(e.message)) return 'No encuentro Spotify activo. Abre Spotify en el iPhone, pon algo un segundo y vuelve a pedírmelo.';
  if (e.status === 400 && /api key/i.test(e.message)) return 'La llave de Gemini no es válida. Revísala en Ajustes ⚙︎.';
  return e.message || 'Algo falló.';
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
    current = { uri: item.uri, id: item.id, label: `${(item.artists || []).map((a) => a.name).join(', ')} - ${item.name}`, playing: r.is_playing };
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
  $('btnLove').onclick = act(async () => {
    await refreshNowPlaying();
    if (!current) return;
    await saveToLiked(current);
    const m = memory();
    m.loved.push({ uri: current.uri, label: current.label, at: Date.now() });
    m.disliked = m.disliked.filter((x) => x.uri !== current.uri);
    saveMemory(m);
    addMessage('sofia', `Anotado: te encantó "${current.label}". La guardé en tus favoritos de Spotify.`);
  });
  $('btnDislike').onclick = act(async () => {
    await refreshNowPlaying();
    if (!current) return;
    const m = memory();
    m.disliked.push({ uri: current.uri, label: current.label, at: Date.now() });
    saveMemory(m);
    addMessage('sofia', `Entendido, no te gustó "${current.label}". No te la vuelvo a poner.`);
    await sp('/me/player/next', { method: 'POST' });
  });
  setInterval(refreshNowPlaying, 5000);
  document.addEventListener('visibilitychange', refreshNowPlaying);
}

// ---------- Ajustes ----------
function fillSetup() {
  const s = settings();
  $('inClientId').value = s.clientId;
  $('inGeminiKey').value = s.geminiKey;
  $('inModel').value = s.model;
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
    store.set('geminiKey', $('inGeminiKey').value.trim());
    store.set('model', $('inModel').value.trim() || DEFAULT_MODEL);
    store.set('count', Math.min(40, Math.max(5, Number($('inCount').value) || DEFAULT_COUNT)));
    fillSetup();
    addMessage('sofia', store.get('token', null) ? 'Guardado.' : 'Guardado. Ahora toca "Conectar con Spotify".');
  };
  $('btnLogin').onclick = login;
  $('btnLogout').onclick = () => { store.del('token'); store.del('profile'); fillSetup(); addMessage('sofia', 'Desconecté tu Spotify.'); };
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
async function init() {
  setupSettings();
  setupPlayer();
  setupMic();
  document.querySelectorAll('#chips button').forEach((b) => { b.onclick = () => handleRequest(b.dataset.q); });
  $('composer').onsubmit = (ev) => { ev.preventDefault(); const t = $('inMsg').value; $('inMsg').value = ''; handleRequest(t); };

  if (await handleRedirect()) { fillSetup(); refreshNowPlaying(); return; }

  const s = settings();
  if (!s.clientId || !s.geminiKey || !store.get('token', null)) {
    fillSetup();
    showSetup(true);
    addMessage('sofia', `¡Hola! Soy SOFIA, tu DJ. Para empezar, pega tu Client ID de Spotify y tu llave de Gemini, toca Guardar y luego "Conectar con Spotify".\n\nEn Spotify for Developers, esta debe ser la Redirect URI:\n${REDIRECT_URI}`);
    return;
  }
  addMessage('sofia', '¡Hola de nuevo! Abre Spotify en el iPhone y dime qué quieres escuchar.');
  loadProfile(false).catch(() => {});
  refreshNowPlaying();
}

init();
