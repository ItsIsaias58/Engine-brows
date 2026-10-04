// persistent music: youtube (nocookie) lives in ONE hidden iframe owned by
// this module. the iframe is never moved or remounted - the host layer is just
// re-positioned over the active slot (expanded panel or mini bar) - so audio
// keeps playing while the user browses, plays games or watches anime.
//
// sources: TWO, conmutables desde el menu (boton youtube <-> spotify):
//   - youtube: embeds youtube-nocookie (sin scripts de youtube.com, que tambien
//     estan bloqueados). El auto-avance de la cola funciona porque el embed
//     avisa "onStateChange" por postMessage.
//   - spotify: embed oficial open.spotify.com/embed. NO hay busqueda propia
//     (el backend solo habla innertube) y NO hay evento de "cancion terminada",
//     asi que en modo spotify se reproduce lo que se pega o se elige de las
//     estaciones, y el avance es manual con los botones.
// ambos embeds van por la misma ventana persistente: cambiar de fuente solo
// cambia el src del iframe, nunca se remonta (remontar mataria el audio).
// youtube playback powers the search box: the browser cannot query youtube
// directly (CORS), so it calls the market service
// (/api/market/music/search) which proxies youtube's public innertube search.
// search results become a PLAY QUEUE: the player auto-advances to the next
// song when one ends (embed postMessage events, no youtube.com scripts needed
// - those are blocked too).
//
// resources: nothing music-related downloads until the first click on "music"
// in the topbar; the catalog chunk itself is hover-preloaded only.

import { signal } from "@preact/signals";
import {
  isEndOfStreamMessage,
  isTrustedEmbedOrigin,
} from "./embedOrigin.ts";
import {
  destroyInPlaceFrame,
  navigateInPlaceFrame,
} from "../../core/proxy/folio.ts";

// "player" es el embed de siempre; "page" es la web real de la fuente dentro
// del mismo panel. Dos vistas y no dos reprodutores porque el embed sigue
// sonando por debajo mientras se navega la web, igual que con el mini bar.
export type MusicView = "player" | "page";

export const musicSignal = signal<{
  open: boolean; // panel visible (expanded)
  mini: boolean; // collapsed to the mini bar
  active: string | null; // embed source currently loaded
  warm: boolean; // iframe already created
  embedStatus: "loading" | "ok" | "blocked"; // did the last embed mount?
  iframeKey: number; // bumps on every src swap so the panel can re-target
  view: MusicView; // embed o pagina completa
  pageStatus: "loading" | "ok" | "blocked"; // did the folio de la pagina montar?
}>({
  open: false,
  mini: false,
  active: null,
  warm: false,
  embedStatus: "loading",
  iframeKey: 0,
  view: "player",
  pageStatus: "loading",
});

// "unavailable" es un estado propio y no un "error" generico: significa que la
// fuente activa no puede buscar (hoy solo spotify, que necesita credenciales en
// el servicio de mercado). El menu dice exactamente qué falta; con "error" el
// usuario solo veria "no se pudo buscar" y no sabria que tocar.
export type SearchState =
  | "idle"
  | "loading"
  | "done"
  | "error"
  | "unavailable";
export const searchStateSignal = signal<SearchState>("idle");
export const searchResultsSignal = signal<SearchResult[]>([]);

export interface SearchResult {
  id: string;
  title: string;
  channel: string;
  source: MusicSource;
  kind?: SpotifyKind;
}

// ---------------------------------------------------------------- fuente
// youtube <-> spotify. Se recuerda entre sesiones y arranca en youtube, que es
// lo que funcionaba antes de existir el switch.
export const MUSIC_SOURCES = ["youtube", "spotify"] as const;
export type MusicSource = (typeof MUSIC_SOURCES)[number];
const MUSIC_SOURCE_KEY = "lyra-music-source";

function isMusicSource(value: unknown): value is MusicSource {
  return MUSIC_SOURCES.includes(value as MusicSource);
}

export const musicSourceSignal = signal<MusicSource>(readStoredMusicSource());

function readStoredMusicSource(): MusicSource {
  try {
    const stored = localStorage.getItem(MUSIC_SOURCE_KEY);
    return isMusicSource(stored) ? stored : "youtube";
  } catch {
    return "youtube";
  }
}

// tipos de contenido que el embed oficial de spotify sabe reproducir
const SPOTIFY_KINDS = [
  "track",
  "album",
  "playlist",
  "show",
  "episode",
] as const;
export type SpotifyKind = (typeof SPOTIFY_KINDS)[number];

export interface MusicPick {
  id: string;
  name: string;
  videoId?: string; // youtube: id de video (embeddable, sin bloqueo regional)
  spotifyId?: string; // spotify: id de playlist
}

// radios 24/7 del canal oficial Lofi Girl: ids estables, embedibles y
// reproducibles dentro de youtube-nocookie (que no bloquean los filtros).
const YOUTUBE_PICKS: MusicPick[] = [
  { id: "lofi", name: "lofi beats", videoId: "jfKfPfyJRdk" },
  { id: "chill", name: "sleep chill", videoId: "rUxyKA_-grg" },
  { id: "synthwave", name: "synthwave", videoId: "4xDzrJKXOOY" },
];

// equivalente en spotify. Los tres ids estan verificados contra el oEmbed
// publico de spotify (titulo correcto y embed 200), asi que no son inventados:
// el embed oficial no admite una pantalla de inicio, asi que sin una playlist
// por defecto el switch a spotify abriria un reproductor vacio.
const SPOTIFY_PICKS: MusicPick[] = [
  { id: "lofi", name: "lofi beats", spotifyId: "37i9dQZF1DWWQRwui0ExPn" },
  {
    id: "chill",
    name: "lofi girl (relajarse)",
    spotifyId: "0vvXsWCC9xrXsKd4FyS8kM",
  },
  { id: "synthwave", name: "lofi hip-hop radio", spotifyId: "2gb0qEVV8PSdt3M5Sc3CZF" },
];

// estaciones de la fuente activa (lo consume el menu para pintar la lista)
export function musicPicks(source: MusicSource = musicSourceSignal.value): MusicPick[] {
  return source === "spotify" ? SPOTIFY_PICKS : YOUTUBE_PICKS;
}

// radio por defecto de cada fuente: la que se carga al pulsar "empezar" sin
// cola, y la que carga el switch si no hay nada sonando.
function defaultMusicPick(
  source: MusicSource = musicSourceSignal.value,
): MusicPick | undefined {
  return musicPicks(source)[0];
}

// ---------------------------------------------------------------- play queue
// la cola SON los resultados de busqueda: al elegir una cancion se encola toda
// la busqueda y al terminar cada video salta al siguiente automaticamente.
// los presets (radios) quedan como cola de un elemento que se repite.
export interface QueueItem {
  id: string;
  title: string;
  channel: string;
  // de donde es el contenido: decide que embed lo reproduce. La cola mezcla
  // ambos (busqueda = youtube, link pegado = la fuente que sea).
  source: MusicSource;
  kind?: SpotifyKind; // solo spotify
}

let queue: QueueItem[] = [];
let queueIndex = -1;
let lastAdvanceAt = 0;
let extending = false;

export function currentTrack(): QueueItem | null {
  return queue[queueIndex] ?? null;
}

export function queueSnapshot(): { items: QueueItem[]; index: number } {
  return { items: queue, index: queueIndex };
}

// version reactiva de la cola para la UI (lista "up next" estilo youtube):
// refresca tras clicks y auto-avances.
export const queueSignal = signal<{ items: QueueItem[]; index: number }>({
  items: [],
  index: -1,
});

function syncQueueSignal(): void {
  queueSignal.value = { items: queue, index: queueIndex };
}

// fin-de-stream del embed via la widget API de postMessage (el embed avisa
// "onStateChange" info 0 cuando el video termina). sin scripts de youtube.com.
//
// el origen se compara por hostname exacto: includes("youtube") tambien hacia
// pasar youtube.com.evil.example y notyoutube.com, que pueden empujar la cola
// cuando quiera. el porque entero esta en embedOrigin.ts.
function handleEmbedMessage(event: MessageEvent): void {
  if (!isTrustedEmbedOrigin(event.origin)) return;
  if (isEndOfStreamMessage(event.data)) nextTrack(true);
}

export function nextTrack(auto = false): void {
  const now = Date.now();
  if (auto && now - lastAdvanceAt < 1500) return; // dedup de eventos repetidos
  lastAdvanceAt = now;
  if (queue.length === 0) return;
  if (queueIndex + 1 >= queue.length) {
    void extendQueue(); // se acabo la cola: trae los recomendados reales
  }
  queueIndex = (queueIndex + 1) % queue.length;
  loadQueueCurrent();
}

// pide a youtube los videos recomendados del actual y los agrega a la cola
// (reemplaza el bloque repetido del video anterior). fire-and-forget.
async function extendQueue(): Promise<void> {
  const current = queue[queueIndex];
  // los recomendados solo existen para youtube: el backend no tiene nada
  // equivalente para spotify, y pedirlo devolvernia una cola mezclada
  if (!current || current.source !== "youtube" || extending) return;
  const currentId = current.id;
  extending = true;
  try {
    const res = await fetch(`/api/market/music/related?v=${encodeURIComponent(currentId)}`);
    const data = (await res.json()) as { results?: QueueItem[] };
    const fresh = (data.results ?? [])
      .filter((item) => item.id && !queue.some((q) => q.id === item.id))
      .map((item) => ({ ...item, source: "youtube" as MusicSource }));
    if (fresh.length) {
      queue = queue.concat(fresh);
      // sin esto, los recomendados que llegan tarde se suman a la cola pero no
      // aparecen en "up next" hasta el siguiente avance
      syncQueueSignal();
    }
  } catch {
    // sin red: el modulo de la cola en bucle cubre el fallback
  } finally {
    extending = false;
  }
}

export function prevTrack(): void {
  if (queue.length === 0) return;
  queueIndex = (queueIndex - 1 + queue.length) % queue.length;
  loadQueueCurrent();
}

function loadQueueCurrent(): void {
  const item = queue[queueIndex];
  if (!item) return;
  syncQueueSignal();
  loadIntoFrame(embedUrlFor(item));
}

// la UI se entera de la cola por syncQueueSignal, no leyendo queue: por eso
// TODO camino que cambia queue o queueIndex tiene que pasar por aqui. antes solo
// lo hacia loadQueueCurrent, asi que playRevealed (busquedas y presets) y
// stopMusic cambiaban la cola sin avisar y "up next" mostraba la cola anterior.
// se centraliza en setQueueIndex / replaceQueue / queueLaClave: un setter nuevo
// sin pasar por aqui no puede olvidarse, que es justo como paso antes.
function playRevealed(index: number): void {
  const item = queue[index];
  if (!item) return;
  queueIndex = index;
  syncQueueSignal();
  loadIntoFrame(embedUrlFor(item), true);
}

// youtube -> youtube-nocookie; spotify -> embed oficial. Un item de la fuente
// equivocada se reproduce con su propio embed: es lo unico que hay, y evita
// que cambiar de fuente a mitad de cola deje el reproductor en negro.
function embedUrlFor(item: QueueItem): string {
  return item.source === "spotify"
    ? spotifyEmbedUrl(item.kind ?? "track", item.id)
    : youTubeEmbedUrl(item.id);
}

// click en un resultado: encola TODOS los resultados y arranca en el elegido
// (asi el auto-avance camina la lista que el usuario ya vio en la busqueda).
export function playSearchResult(index: number): void {
  const results = searchResultsSignal.value;
  if (!results.length) return;
  queue = results.map((r) => ({
    id: r.id,
    title: r.title,
    channel: r.channel,
    source: r.source,
    ...(r.kind ? { kind: r.kind } : {}),
  }));
  playRevealed(Math.max(0, Math.min(index, queue.length - 1)));
}

// click en un recomendado de la lista "up next": salta directo a ese video
// (la cola de recomendados ya esta alineada con la lista mostrada).
export function playQueueItem(index: number): void {
  if (index < 0 || index >= queue.length) return;
  playRevealed(index);
}

// preset/radio: cola de un elemento; al terminar se vuelve a reproducir.
export function playPreset(pick: MusicPick): void {
  if (pick.spotifyId) {
    queue = [
      {
        id: pick.spotifyId,
        title: pick.name,
        channel: "spotify",
        source: "spotify",
        kind: "playlist",
      },
    ];
  } else if (pick.videoId) {
    queue = [
      {
        id: pick.videoId,
        title: pick.name,
        channel: "lofi girl",
        source: "youtube",
      },
    ];
  } else {
    return;
  }
  playRevealed(0);
}

// youtube watch/short/link urls -> video id; null when the input is not one.
export function toYouTubeId(input: string): string | null {
  const value = (input || "").trim();
  if (!value) return null;
  // raw 11-char id
  if (/^[\w-]{11}$/.test(value)) return value;
  try {
    const url = new URL(value.startsWith("http") ? value : `https://${value}`);
    const host = url.hostname.replace(/^www\.|^m\./, "");
    if (host === "youtu.be") return url.pathname.slice(1).split("/")[0] || null;
    if (host === "youtube.com" || host === "youtube-nocookie.com") {
      if (url.pathname === "/watch") return url.searchParams.get("v") ?? null;
      const m = url.pathname.match(/^\/(?:embed|shorts|v)\/([\w-]{11})/);
      return m?.[1] ?? null;
    }
    return null;
  } catch {
    return null;
  }
}

// privacy-enhanced youtube embed of a single video. youtube-nocookie serves no
// X-Frame-Options, so it mounts fine inside the app iframe. `origin` habilita
// la widget API del embed (eventos postMessage onStateChange) y `playsinline`
// evita fullscreen forzado en moviles.
export function youTubeEmbedUrl(videoId: string): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?autoplay=1&rel=0&playsinline=1&origin=${encodeURIComponent(origin)}`;
}

// links y URIs de spotify -> { id, kind }; null cuando la entrada no es de
// spotify. Se aceptan las dos formas porque la gente copia las dos: la URL que
// sale de compartir y el URI "spotify:track:..." de las apps de escritorio.
export function toSpotifyLink(
  input: string,
): { id: string; kind: SpotifyKind } | null {
  const value = (input || "").trim();
  if (!value) return null;

  const isKind = (candidate: string): candidate is SpotifyKind =>
    (SPOTIFY_KINDS as readonly string[]).includes(candidate);

  // spotify:track:<id> (el prefijo de locale va aparte: spotify:intl-es:track:<id>)
  const uri = value.match(/^spotify:(?:intl-[a-z]{2}:)?([a-z]+):([A-Za-z0-9]+)$/i);
  const uriKind = uri?.[1]?.toLowerCase();
  const uriId = uri?.[2];
  if (uriKind && uriId) {
    return isKind(uriKind) ? { id: uriId, kind: uriKind } : null;
  }

  try {
    const url = new URL(value.startsWith("http") ? value : `https://${value}`);
    const host = url.hostname.replace(/^www\.|^m\.|^play\./, "");
    if (host !== "open.spotify.com" && host !== "spotify.com") return null;
    // /intl-es/track/<id>: el locale se salta, no es contenido
    const parts = url.pathname.split("/").filter(Boolean);
    const segments = parts[0]?.startsWith("intl-") ? parts.slice(1) : parts;
    const kind = segments[0];
    const id = segments[1];
    if (!kind || !isKind(kind) || !id) return null;
    if (!/^[A-Za-z0-9]+$/.test(id)) return null;
    return { id, kind };
  } catch {
    return null;
  }
}

// embed oficial de spotify. A diferencia de youtube, aqui no hay widget API
// por postMessage sin cargar el SDK de open.spotify.com (que manyas redes
// bloquean), asi que no hay evento de fin de cancion: el avance es manual.
export function spotifyEmbedUrl(kind: SpotifyKind, id: string): string {
  return `https://open.spotify.com/embed/${kind}/${encodeURIComponent(id)}`;
}

// the search itself runs server-side (youtube blocks cross-origin browser
// calls); this just talks to our bridge.
// La búsqueda va contra la fuente activa y el puente decide: youtube por
// innertube (sin credenciales), spotify por su Web API (con credenciales). Los
// resultados llevan su propia fuente para que al pulsarlos se reproduzca en el
// embed correcto, y no en el que esté marcado en ese momento.
export async function searchMusic(
  query: string,
  source: MusicSource = musicSourceSignal.value,
): Promise<void> {
  const q = query.trim();
  if (!q) return;
  searchStateSignal.value = "loading";
  try {
    const res = await fetch(
      `/api/market/music/search?source=${source}&q=${encodeURIComponent(q)}`,
    );
    const data = (await res.json()) as {
      configured?: boolean;
      failed?: boolean;
      results?: SearchResult[];
    };
    // tres desenlaces distintos y con remedio distinto: faltan (o son erroneas)
    // las credenciales, fallo pasajero, o no hay resultados. colapsarlos en un
    // "error" o en un "vacio" deja al usuario sin saber que hacer
    if (data.configured === false) {
      searchResultsSignal.value = [];
      searchStateSignal.value = "unavailable";
      return;
    }
    if (data.failed === true) {
      searchResultsSignal.value = [];
      searchStateSignal.value = "error";
      return;
    }
    searchResultsSignal.value = Array.isArray(data.results)
      ? data.results.slice(0, 8)
      : [];
    searchStateSignal.value = "done";
  } catch {
    searchResultsSignal.value = [];
    searchStateSignal.value = "error";
  }
}

export function clearSearchResults(): void {
  searchResultsSignal.value = [];
  searchStateSignal.value = "idle";
}

// ---------------------------------------------------------------- iframe host
// the player is ONE <iframe> that is NEVER moved in the DOM: re-inserting an
// iframe (or any of its ancestors) reloads the document and kills playback.// instead, the host div that owns it is a position:fixed layer aligned OVER
// the active slot (expanded panel or mini bar) by copying its bounding rect.
// parking = host goes offscreen but stays rendered, so audio keeps playing
// while the user browses other views.
const FRAME_ID = "music-iframe";
const HOST_ID = "music-frame-host";
let lastSlot: HTMLElement | null = null;

export function createPersistentFrame(): void {
  if (document.getElementById(HOST_ID)) return;
  const host = document.createElement("div");
  host.id = HOST_ID;
  host.className = "music-frame-host";
  const frame = document.createElement("iframe");
  frame.id = FRAME_ID;
  frame.title = "music player";
  frame.allow = "autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture";
  frame.addEventListener("load", () => markEmbedLoaded());
  host.appendChild(frame);
  document.body.appendChild(host);
  window.addEventListener("resize", () => {
    if (lastSlot) placeFrame(lastSlot); // keep the overlay glued to its slot
  });
  window.addEventListener("message", handleEmbedMessage);
}

// body zoom (media queries >=1600px) hace que getBoundingClientRect() devuelva
// pixeles ya escalados, pero al asignarlos a un elemento fixed dentro de body
// Chrome los vuelve a escalar -> el iframe cae desplazado de su slot (video
// "partido" en pantallas grandes). Medimos el zoom efectivo y lo dividimos.
//
// se exporta porque el panel necesita la misma conversion al sembrar su
// posicion a partir del rect: sin esto, arrastrar el panel con zoom lo
// desplazaria del raton justo cuando placeFrame ya lo-divide.
export function frameZoom(): number {
  return effectiveZoom();
}

function effectiveZoom(): number {
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;left:0;top:0;width:100px;height:100px;visibility:hidden;pointer-events:none;";
  document.body.appendChild(probe);
  const scale = probe.getBoundingClientRect().width / 100;
  probe.remove();
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

// align an always-alive iframe over `container`'s rect, or park it offscreen.
// `miniCrop` es lo unico que distingue a los dos hosts: el embed se recorta
// dentro del mini bar (mismo aspecto de antes) y la pagina no, porque una web
// recortada a 96x34 no sirve de nada.
function positionHost(
  host: HTMLElement,
  frame: HTMLElement,
  container: HTMLElement | null,
  miniCrop: boolean,
): void {
  if (!container || !container.isConnected) {
    host.classList.remove("is-active");
    host.style.left = "";
    host.style.top = "";
    host.style.width = "";
    host.style.height = "";
    return;
  }
  const rect = container.getBoundingClientRect();
  const zoom = effectiveZoom();
  host.classList.add("is-active");
  host.style.left = `${Math.round(rect.left / zoom)}px`;
  host.style.top = `${Math.round(rect.top / zoom)}px`;
  host.style.width = `${Math.round(rect.width / zoom)}px`;
  host.style.height = `${Math.round(rect.height / zoom)}px`;
  // the mini slot shows a cropped corner of the embed (same look as before):
  // resizing the frame inside the overflow-hidden host is pure css and never
  // reloads the document.
  const isMini = miniCrop && container.classList.contains("music-mini-frame");
  host.classList.toggle("is-mini-slot", isMini);
  frame.style.width = isMini ? "240px" : "100%";
  frame.style.height = isMini ? "80px" : "100%";
  frame.style.margin = isMini ? "-23px 0 0 -72px" : "0";
}

// align the always-alive iframe over `container`'s rect, or park it offscreen.
export function placeFrame(container: HTMLElement | null): void {
  createPersistentFrame();
  lastSlot = container;
  const host = document.getElementById(HOST_ID);
  const frame = document.getElementById(FRAME_ID);
  if (host && frame) positionHost(host, frame, container, true);
}

// ---------------------------------------------------------------- pagina
// El embed de spotify es un reproductor cerrado: no tiene buscador, no deja
// iniciar sesion y no se puede navegar como una web. La vista "pagina" mete la
// web real (open.spotify.com / m.youtube.com) DENTRO del panel, servida por el
// proxy de folio, que es la unica via para verla sin salir de la app: ahi si se
// puede iniciar sesion, buscar y abrir playlists.
//
// El embed no se desmonta al cambiar de vista: sigue sonando por debajo, que es
// la misma idea del mini bar. Por eso la vista pagina aparta el embed de su
// slot en vez de sustituirlo, y por eso minimize/expandir no tocan la pagina.
const PAGE_FRAME_ID = "music-page-frame";
const PAGE_HOST_ID = "music-page-host";
let lastPageSlot: HTMLElement | null = null;

// m.youtube.com y no youtube.com: el panel es estrecho y la version de
// escritorio no cabe. la movil responde bien al ancho que se le da.
export function musicPageUrl(
  source: MusicSource = musicSourceSignal.value,
): string {
  return source === "spotify"
    ? "https://open.spotify.com/"
    : "https://m.youtube.com/";
}

// la url que se esta viendo ahora mismo (puede haber navegado a una playlist),
// que es la que abre el boton de pantalla completa
export function currentPageUrl(): string {
  const frame = document.getElementById(PAGE_FRAME_ID);
  return frame?.dataset.manualUrl || musicPageUrl();
}

// no se exporta: la usan placePageFrame y openMusicPage, que son las dos
// formas legitimas de encenderla
function createPersistentPageFrame(): void {
  if (document.getElementById(PAGE_HOST_ID)) return;
  const host = document.createElement("div");
  host.id = PAGE_HOST_ID;
  host.className = "music-frame-host";
  const frame = document.createElement("iframe");
  frame.id = PAGE_FRAME_ID;
  frame.title = "music page";
  // el load lo dispara folio al terminar de componer la pagina, no al empezar
  frame.addEventListener("load", () => {
    musicSignal.value = { ...musicSignal.value, pageStatus: "ok" };
  });
  host.appendChild(frame);
  document.body.appendChild(host);
  window.addEventListener("resize", () => {
    if (lastPageSlot) placePageFrame(lastPageSlot);
  });
}

export function placePageFrame(container: HTMLElement | null): void {
  createPersistentPageFrame();
  lastPageSlot = container;
  const host = document.getElementById(PAGE_HOST_ID);
  const frame = document.getElementById(PAGE_FRAME_ID);
  if (host && frame) positionHost(host, frame, container, false);
}

export function markPageBlocked(): void {
  musicSignal.value = { ...musicSignal.value, pageStatus: "blocked" };
}

/**
 * Mete la web de la fuente en el panel. No recarga si ya estaba cargada: volver
 * a spotify cada vez que se abre el panel perderia la sesion y el scroll donde
 * lo dejaste, que es justo lo que se va a usar para loguearse.
 */
export function openMusicPage(): void {
  createPersistentPageFrame();
  const frame = document.getElementById(PAGE_FRAME_ID) as HTMLIFrameElement | null;
  const firstLoad = !frame?.dataset.manualUrl;
  musicSignal.value = {
    ...musicSignal.value,
    open: true,
    mini: false,
    warm: true,
    view: "page",
    pageStatus: firstLoad ? "loading" : musicSignal.value.pageStatus,
  };
  if (!frame || !firstLoad) return;
  // "ok" llega por dos caminos a proposito: el load del iframe (folio ya pintó
  // la pagina) y el promise resuelto (folio arranco y acepto la url). si solo
  // contourara el load y folio no lo emitiera, el panel marcaria la pagina como
  // caida estando perfectamente viva
  void navigateInPlaceFrame(frame, musicPageUrl())
    .then(() => {
      if (musicSignal.value.pageStatus === "loading") {
        musicSignal.value = { ...musicSignal.value, pageStatus: "ok" };
      }
    })
    .catch(() => {
      // aqui lo que falla es folio/proxy, no la web: el aviso lo dice
      markPageBlocked();
    });
}

// Vuelve al embed. El folio se destruye en vez de solo esconderse: una pagina de
// spotify viva con el panel en "reproductor" seguiria gastando red y CPU, y lo
// unico que haria es sonar de fondo sin que nadie la vea.
export function closeMusicPage(): void {
  const frame = document.getElementById(PAGE_FRAME_ID) as HTMLIFrameElement | null;
  if (frame) destroyInPlaceFrame(frame);
  placePageFrame(null);
  musicSignal.value = {
    ...musicSignal.value,
    view: "player",
    pageStatus: "loading",
  };
}

export function openMusic(): void {
  // nada activo y nada cargado: arranca el primer preset de la fuente activa
  const first = defaultMusicPick();
  if (queue.length === 0 && first && !document.getElementById(FRAME_ID)?.getAttribute("src")) {
    playPreset(first);
    return;
  }
  musicSignal.value = {
    ...musicSignal.value,
    open: true,
    mini: false,
    warm: true,
  };
}

export function minimizeMusic(): void {
  musicSignal.value = { ...musicSignal.value, open: false, mini: true };
}

export function expandMusic(): void {
  musicSignal.value = { ...musicSignal.value, open: true, mini: false };
}

// "close" keeps the music going: it just collapses to the mini bar, where the
// user can expand again, change the station or stop for real.
export function hideMusicPanel(): void {
  if (musicSignal.value.warm) {
    musicSignal.value = { ...musicSignal.value, open: false, mini: true };
  } else {
    musicSignal.value = { ...musicSignal.value, open: false };
  }
}

// stop playback entirely and drop the iframe (back to zero downloads)
export function stopMusic(): void {
  const frame = document.getElementById(FRAME_ID);
  if (frame) frame.removeAttribute("src"); // about:blank-less: no more requests
  placeFrame(null);
  // parar es parar: la pagina se cierra con el embed, no se queda escondida
  closeMusicPage();
  queue = [];
  queueIndex = -1;
  // parar vacia la cola: sin avisar, "up next" seguia listando las canciones
  // que ya no suenan
  syncQueueSignal();
  musicSignal.value = {
    open: false,
    mini: false,
    active: null,
    warm: false,
    embedStatus: "loading",
    iframeKey: 0,
    view: "player",
    pageStatus: "loading",
  };
  clearSearchResults();
}

function loadIntoFrame(source: string, reveal = false): void {
  createPersistentFrame();
  const frame = document.getElementById(FRAME_ID);
  if (!frame) return;
  frame.setAttribute("src", source);
  // reveal=true en clicks explicitos (abre el panel); el auto-avance respeta
  // el estado actual (si estaba minimizado, sigue sonando minimizado).
  musicSignal.value = {
    ...musicSignal.value,
    ...(reveal ? { open: true, mini: false } : {}),
    active: source,
    warm: true,
    embedStatus: "loading",
    iframeKey: musicSignal.value.iframeKey + 1,
  };
}

// pega un link de youtube suelto: cola de un elemento (los resultados de
// busqueda usan playSearchResult para encolar la lista completa).
export function playYouTubeVideo(videoId: string): void {
  queue = [
    { id: videoId, title: "youtube", channel: "youtube", source: "youtube" },
  ];
  playRevealed(0);
}

// pega un link de spotify suelto: cola de un elemento con su tipo (track,
// album, playlist, show o episode), que es lo que decide la url del embed.
export function playSpotifyLink(link: { id: string; kind: SpotifyKind }): void {
  queue = [
    {
      id: link.id,
      title: link.kind,
      channel: "spotify",
      source: "spotify",
      kind: link.kind,
    },
  ];
  playRevealed(0);
}

// ---------------------------------------------------------------- switch
// Cambiar de fuente NO remonta el iframe: solo le cambia el src, asi que la
// pestana de musica sigue sonando mientras se decide.
//
// Si lo que sonaba era de la fuente nueva se recarga (por ejemplo se ha
// pulsado "atras" y la cola ha dado la vuelta); si era de la otra, entra la
// radio por defecto de la nueva. La regla es "lo que ves es lo que esta
// marcado": un switch que se limitase a reponer el embed actual dejaria la
// pastilla en "spotify" con un video de youtube en pantalla.
export function setMusicSource(source: MusicSource): void {
  if (!isMusicSource(source) || source === musicSourceSignal.value) return;
  musicSourceSignal.value = source;
  try {
    localStorage.setItem(MUSIC_SOURCE_KEY, source);
  } catch {
    // modo privado / storage lleno: el switch sigue funcionando en sesion
  }
  // cambiar de fuente cierra la pagina: dejar cargada la web de spotify con la
  // pastilla en "youtube" seria la misma incoherencia que este mismo switch
  // evita en el embed. al volver a abrir "pagina" carga la de la fuente nueva.
  if (musicSignal.value.view === "page") closeMusicPage();
  if (queue[queueIndex]?.source === source && musicSignal.value.warm) {
    loadQueueCurrent();
    return;
  }
  // si no estaba sonando nada, entrar en una fuente la abre igualmente: es lo
  // que se pide al cambiar a spotify ("que me abra spotify aqui mismo"), y el
  // click es un gesto del usuario, asi que el navegador permite el audio
  const first = defaultMusicPick(source);
  if (first) playPreset(first);
}

// called by the panel when the iframe fires onLoad (it really mounted)
export function markEmbedLoaded(): void {
  if (musicSignal.value.embedStatus !== "ok") {
    musicSignal.value = { ...musicSignal.value, embedStatus: "ok" };
  }
}

// called a few seconds after a play attempt that never fired onLoad
export function markEmbedBlocked(): void {
  if (musicSignal.value.embedStatus === "loading") {
    musicSignal.value = { ...musicSignal.value, embedStatus: "blocked" };
  }
}

export function persistentFrameId(): string {
  return FRAME_ID;
}
export function persistentHostId(): string {
  return HOST_ID;
}
