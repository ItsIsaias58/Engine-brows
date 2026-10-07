// puente de búsqueda de música para el reproductor de la bolsa.
//
// El navegador no puede llamar a youtube directamente (CORS), así que el
// servicio hace de puente: consulta la API pública innertube de youtube y
// devuelve los primeros vídeos como {id,title,channel}. Caché LRU de 10 min
// para no golpear a youtube con la misma búsqueda una y otra vez.
//
// La búsqueda de spotify SÍ necesita credenciales, y no es un capricho:
//   - el embed oficial no tiene vista de búsqueda (/embed/search/... devuelve
//     404), así que no se puede buscar desde el reproductor;
//   - el navegador no puede llamar a api.spotify.com (CORS) igual que pasaba
//     con youtube, y open.spotify.com no expone un endpoint público de búsqueda.
// Se usa el flujo oficial de client credentials: no pide cuenta de usuario, ni
// scopes de usuario, ni login. Sin credenciales la ruta responde
// `configured: false` en vez de fingir que no hay resultados, para que el menú
// pueda decir qué falta en vez de quedarse en silencio.

const MUSIC_SEARCH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const MUSIC_SEARCH_TTL_MS = 10 * 60 * 1000;
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';

// clave -> { t, results }. LRU simple: al pasar de 100 entradas se descarta la
// más antigua insertada.
function cachePut(cache, key, results) {
  cache.set(key, { t: Date.now(), results });
  if (cache.size > 100) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

function musicSearchResultsFromPayload(payload) {
  const contents =
    payload?.contents?.twoColumnSearchResultsRenderer?.primaryContents
      ?.sectionListRenderer?.contents || [];
  for (const section of contents) {
    const items = section?.itemSectionRenderer?.contents || [];
    const results = [];
    for (const item of items) {
      const v = item?.videoRenderer;
      const id = v?.videoId;
      if (!id) continue;
      const title =
        v?.title?.runs?.map((r) => r.text).join('') || v?.title?.simpleText || '';
      const channel = v?.ownerText?.runs?.[0]?.text || '';
      if (!title) continue;
      results.push({ id, title, channel });
      if (results.length >= 8) break;
    }
    if (results.length) return results;
  }
  return [];
}

// videos relacionados de un video ("up next"): el mismo innertube /next que
// usa la página de watch de youtube para su lista de recomendados.
// soporta el formato nuevo (lockupViewModel) y el viejo (compactVideoRenderer).
function musicRelatedFromPayload(payload) {
  const sec =
    payload?.contents?.twoColumnWatchNextResults?.secondaryResults?.secondaryResults;
  const items = sec?.results || sec?.items || [];
  const results = [];
  for (const item of items) {
    const lv = item?.lockupViewModel;
    if (lv && lv.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') {
      const id = lv.contentId;
      const title = lv?.metadata?.lockupMetadataViewModel?.title?.content || '';
      const parts =
        lv?.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel
          ?.metadataRows?.flatMap((r) => r.metadataParts || []) || [];
      const channel = parts[0]?.text?.content || '';
      if (!id || !title) continue;
      results.push({ id, title, channel });
      if (results.length >= 15) break;
      continue;
    }
    const v = item?.compactVideoRenderer;
    if (v) {
      const id = v.videoId;
      const title =
        v?.title?.simpleText || v?.title?.runs?.map((r) => r.text).join('') || '';
      const channel =
        v?.shortBylineText?.runs?.[0]?.text ||
        v?.longBylineText?.runs?.[0]?.text ||
        v?.author?.simpleText ||
        '';
      if (!id || !title) continue;
      results.push({ id, title, channel });
      if (results.length >= 15) break;
    }
  }
  return results;
}

function spotifyResultsFromPayload(payload) {
  const items = Array.isArray(payload?.tracks?.items) ? payload.tracks.items : [];
  const results = [];
  for (const track of items) {
    // el embed construye la url con este id: si no parece un id de spotify
    // (base62) mejor no devolverlo que abrir un embed roto
    if (!/^[A-Za-z0-9]{10,}$/.test(track?.id || '')) continue;
    const artists = (track.artists || [])
      .map((artist) => artist?.name)
      .filter(Boolean)
      .join(', ');
    results.push({ id: track.id, title: track.name || '', channel: artists, kind: 'track' });
    if (results.length >= 8) break;
  }
  return results;
}

export function createMusicBridge(options = {}) {
  const spotifyClientId = options.spotifyClientId ?? process.env.SPOTIFY_CLIENT_ID ?? '';
  const spotifyClientSecret =
    options.spotifyClientSecret ?? process.env.SPOTIFY_CLIENT_SECRET ?? '';
  const spotifyConfigured = Boolean(spotifyClientId && spotifyClientSecret);

  const cache = new Map();
  // credenciales que spotify ha rechazado. se recuerda porque un id malo no se
  // arregla reiniciando: sin esto, cada búsqueda volvería a fallar con un 401 y
  // el menú solo podría mostrar "sin resultados", que es justo la confusión que
  // este puente evita
  let spotifyAuthFailed = false;
  let spotifyToken = null; // { token, expiresAt }

  function spotifyUnconfigured() {
    return { configured: false, failed: false, results: [] };
  }

  // fallo transitorio (red, 429, 5xx): las credenciales pueden estar bien, así
  // que se distingue de "no hay nada que buscar"
  function spotifyFailed() {
    return { configured: true, failed: true, results: [] };
  }

  async function spotifyAccessToken() {
    if (!spotifyConfigured || spotifyAuthFailed) return null;
    // se renueva un minuto antes de expirar: un token que caduca en mitad de
    // una búsqueda devuelve un 401 que no se puede distinguir de un fallo real
    if (spotifyToken && spotifyToken.expiresAt > Date.now()) return spotifyToken.token;
    const basic = Buffer.from(`${spotifyClientId}:${spotifyClientSecret}`).toString('base64');
    const res = await globalThis.fetch(SPOTIFY_TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      // 400/401/403 es un rechazo de las credenciales; el resto (429, 5xx, red)
      // es pasajero y no dice nada del id del cliente
      if ([400, 401, 403].includes(res.status)) {
        spotifyAuthFailed = true;
        console.warn(
          `[spotify-search] spotify rechazo las credenciales (${res.status}); revisa SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET`,
        );
        return null;
      }
      console.warn(`[spotify-search] el token no se pudo pedir (${res.status})`);
      return null;
    }
    const payload = await res.json();
    if (!payload?.access_token) return null;
    spotifyToken = {
      token: payload.access_token,
      expiresAt: Date.now() + Number(payload.expires_in || 3600) * 1000 - 60_000,
    };
    return spotifyToken.token;
  }

  // videos relacionados de un video (público, sin auth)
  async function relatedYouTube(videoId) {
    if (!/^[\w-]{11}$/.test(videoId)) return [];
    const key = `related:${videoId}`;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.t < MUSIC_SEARCH_TTL_MS) return cached.results;
    try {
      const res = await globalThis.fetch('https://www.youtube.com/youtubei/v1/next?prettyPrint=false', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': MUSIC_SEARCH_UA,
          'Accept-Language': 'es-MX,es;q=0.9,en;q=0.7',
        },
        body: JSON.stringify({
          context: {
            client: { clientName: 'WEB', clientVersion: '2.20240101.00.00', hl: 'es', gl: 'MX' },
          },
          videoId,
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return [];
      const results = musicRelatedFromPayload(await res.json());
      if (results.length) cachePut(cache, key, results);
      return results;
    } catch (err) {
      console.warn('[music-related] fallo:', err?.message || err);
      return [];
    }
  }

  async function searchSpotify(query) {
    // sin id/clave, o con un id que spotify ya rechazo: falta configuración, y
    // eso lo puede arreglar el usuario poniendo las variables
    if (!spotifyConfigured || spotifyAuthFailed) return spotifyUnconfigured();
    // la clave incluye la fuente: sin el prefijo, buscar la misma cadena en
    // youtube y en spotify devolvería la caché de la otra
    const key = `spotify:${query.trim().toLowerCase()}`;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.t < MUSIC_SEARCH_TTL_MS) {
      return { configured: true, failed: false, results: cached.results };
    }
    const token = await spotifyAccessToken();
    if (!token) return spotifyAuthFailed ? spotifyUnconfigured() : spotifyFailed();
    try {
      const res = await globalThis.fetch(
        `${SPOTIFY_API_BASE}/search?type=track&limit=8&q=${encodeURIComponent(query.trim())}`,
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) },
      );
      if (!res.ok) {
        console.warn(`[spotify-search] la API respondio ${res.status}`);
        return spotifyFailed();
      }
      const results = spotifyResultsFromPayload(await res.json());
      if (results.length) cachePut(cache, key, results);
      return { configured: true, failed: false, results };
    } catch (err) {
      console.warn('[spotify-search] fallo la búsqueda:', err?.message || err);
      return spotifyFailed();
    }
  }

  async function searchYouTube(query) {
    if (!query.trim()) return [];
    const key = `youtube:${query.trim().toLowerCase()}`;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.t < MUSIC_SEARCH_TTL_MS) return cached.results;
    try {
      const res = await globalThis.fetch('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': MUSIC_SEARCH_UA,
          'Accept-Language': 'es-MX,es;q=0.9,en;q=0.7',
        },
        body: JSON.stringify({
          context: {
            client: { clientName: 'WEB', clientVersion: '2.20240101.00.00', hl: 'es', gl: 'MX' },
          },
          query: query.trim(),
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return [];
      const results = musicSearchResultsFromPayload(await res.json());
      if (results.length) cachePut(cache, key, results);
      return results;
    } catch (err) {
      console.warn('[music-search] fallo la búsqueda:', err?.message || err);
      return [];
    }
  }

  return { searchYouTube, searchSpotify, relatedYouTube };
}
