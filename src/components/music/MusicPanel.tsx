import { useCallback, useEffect } from "preact/hooks";
import { useRef, useState } from "preact/hooks";
import {
  MUSIC_SOURCES,
  musicSignal,
  musicSourceSignal,
  searchStateSignal,
  searchResultsSignal,
  musicPicks,
  openMusic,
  minimizeMusic,
  expandMusic,
  hideMusicPanel,
  setMusicSource,
  stopMusic,
  playPreset,
  playSearchResult,
  playQueueItem,
  playSpotifyLink,
  playYouTubeVideo,
  queueSignal,
  searchMusic,
  nextTrack,
  prevTrack,
  currentTrack,
  clearSearchResults,
  frameZoom,
  markEmbedBlocked,
  markPageBlocked,
  placeFrame,
  placePageFrame,
  openMusicPage,
  closeMusicPage,
  currentPageUrl,
  toSpotifyLink,
  toYouTubeId,
  type MusicPick,
  type MusicSource,
  type MusicView,
  type QueueItem,
  type SearchResult,
} from "../../features/music/music.ts";
import {
  fitBoxToViewport,
  isSameBox,
  maximizedBox,
  resizeBox,
  type PanelBox,
} from "../../features/music/panelBox.ts";
import {
  RESIZE_HANDLES,
  type ResizeEdge,
  type ResizeHandle,
} from "../../features/music/resizeHandles.ts";
import { musicViewSignal } from "../../core/ui/uiSignals.ts";
import { toast } from "../../core/ui/toast.ts";
import { useMenuView } from "../../hooks/useMenuView.ts";
import { openInApp } from "../../core/browser/openInApp.ts";
import {
  IconAudio,
  IconDownsize,
  IconFullScreen,
  IconMagnifyingGlass2,
} from "../icons";
import { svgIcon } from "../../core/ui/svgIcon.ts";
import "../../assets/styles/music/music.css";

// NOTE: svgIcon() returns an HTML *string* - it is only safe for innerHTML
// sinks (useMenuView's icon swap below). Inside JSX, icons must be rendered
// as components (<IconAudio />), otherwise the markup shows up as text.
const SVG_SEARCH = svgIcon("IconMagnifyingGlass2");
const SVG_MUSIC = svgIcon("IconAudio", { solid: true });

// search result row: clicking it enqueues the WHOLE search and starts here,
// so playback auto-advances down the list when each track/video ends. Cada
// resultado lleva su fuente, asi que la lista puede ser de youtube o de
// spotify segun lo que este marcado en el switch.
function SearchResultRow({
  result,
  index,
}: {
  result: SearchResult;
  index: number;
}) {
  return (
    <button
      type="button"
      class="music-search-result"
      onClick={() => playSearchResult(index)}
    >
      <span class="music-search-result-icon" aria-hidden="true">
        <IconAudio solid size={14} />
      </span>
      <span class="music-search-result-text">
        <strong>{result.title}</strong>
        <em>{result.channel}</em>
      </span>
    </button>
  );
}

// station list shown inside the expanded panel
function StationButton({
  pick,
  activeId,
  source,
}: {
  pick: MusicPick;
  activeId: string | null;
  source: MusicSource;
}) {
  const isActive = activeId === (pick.spotifyId ?? pick.videoId);
  return (
    <button
      type="button"
      class={`music-station${isActive ? " is-active" : ""}`}
      onClick={() => {
        setMusicSource(source);
        playPreset(pick);
      }}
    >
      <span class="music-station-art" aria-hidden="true">
        <IconAudio solid />
      </span>
      <span class="music-station-name">{pick.name}</span>
      {isActive && <span class="music-station-live">playing</span>}
    </button>
  );
}

// ---- ventana movible -------------------------------------------------------
// se guarda en localStorage para que la ventana se quede donde el usuario la
// dejo entre recargas; si no, cada recarga la devuelve a su esquina y hay que
// volver a arrastrarla. La geometria (que no pueda salirse de la pantalla y
// cuanto puede ocupar) vive en panelBox.ts, con sus pruebas.
const PANEL_BOX_KEY = "lyra-music-panel-box";
const PANEL_MAXIMIZED_KEY = "lyra-music-panel-maximized";

type DragMode = "move" | "resize";
interface DragState extends PanelBox {
  mode: DragMode;
  // que bordes mueve este gesto: el grow por lados desplaza tambien la posicion,
  // y es lo que distingue agrandar por la esquina de hacerlo por el lateral
  edges: readonly ResizeEdge[];
  zoom: number;
  pointerX: number;
  pointerY: number;
}

function readStoredPanelBox(): PanelBox | null {
  try {
    const stored = localStorage.getItem(PANEL_BOX_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored) as Partial<PanelBox>;
    const box: PanelBox = {
      left: Number(parsed.left),
      top: Number(parsed.top),
      width: Number(parsed.width),
      height: Number(parsed.height),
    };
    if (
      !Number.isFinite(box.left) ||
      !Number.isFinite(box.top) ||
      !Number.isFinite(box.width) ||
      !Number.isFinite(box.height) ||
      box.width <= 0 ||
      box.height <= 0
    ) {
      return null;
    }
    // la caja guardada puede venir de una pantalla mas grande: se reencaja
    // antes de usarla o el panel apareceria fuera del area visible
    return fitBoxToViewport(box, window.innerWidth, window.innerHeight);
  } catch {
    return null;
  }
}

// maximizada se recuerda aparte de la caja: al restaurar hay que volver al
// tamano que el usuario eligio, no al de maximizada
function readStoredMaximized(): boolean {
  try {
    return localStorage.getItem(PANEL_MAXIMIZED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeStoredMaximized(maximized: boolean): void {
  try {
    localStorage.setItem(PANEL_MAXIMIZED_KEY, maximized ? "1" : "0");
  } catch {
    // storage lleno o modo privado: maximizada solo dura esta sesion
  }
}

function writeStoredPanelBox(box: PanelBox): void {
  try {
    localStorage.setItem(PANEL_BOX_KEY, JSON.stringify(box));
  } catch {
    // storage lleno o modo privado: el arrastre sigue funcionando en sesion
  }
}

// boton de switch youtube <-> spotify. Es una pastilla segmentada y no un
// toggle suelto porque las dos opciones son equivalentes: un toggle obligaria
// a inventarse cual de las dos es "la buena".
function SourceSwitch({ source }: { source: MusicSource }) {
  return (
    <div class="music-source-switch" role="group" aria-label="music source">
      {MUSIC_SOURCES.map((option) => (
        <button
          key={option}
          type="button"
          class={option === source ? "is-active" : ""}
          aria-pressed={option === source}
          onClick={() => setMusicSource(option)}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

const MUSIC_VIEWS: { view: MusicView; label: string }[] = [
  { view: "player", label: "player" },
  { view: "page", label: "page" },
];

// Reproductor o pagina de la fuente. "page" no es un reproductor: es la web
// real dentro del panel (iniciar sesion, buscar, playlists), que el embed no
// puede hacer.
function ViewSwitch({ view }: { view: MusicView }) {
  return (
    <div class="music-source-switch" role="group" aria-label="player or page">
      {MUSIC_VIEWS.map(({ view: option, label }) => (
        <button
          key={option}
          type="button"
          class={option === view ? "is-active" : ""}
          aria-pressed={option === view}
          title={
            option === "page"
              ? "open the real site (log in, search, browse)"
              : "embedded player"
          }
          onClick={() => (option === "page" ? openMusicPage() : closeMusicPage())}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export default function MusicPanel({ openOnMount = false }: { openOnMount?: boolean }) {
  const menu = useMenuView({
    bodyClass: "music-view",
    signal: musicViewSignal,
    iconId: "music-icon",
    inactiveIcon: SVG_MUSIC, // was "" - wiped the button icon on close
    activeIcon: SVG_SEARCH,
    openedStorageKey: "music-opened",
    oppositeBodyClass: "anime-view",
    hideOpposite: () => window.hideAnimeMenu?.(),
    onShowFrame: () => window.hideGameMenu?.(),
  });
  // music must also push the games menu out (useMenuView only takes one
  // opposite); an effect keeps all three views mutually exclusive.
  useEffect(() => {
    if (menu.visible) window.hideGameMenu?.();
  }, [menu.visible]);

  useEffect(() => {
    const musicIcon = document.getElementById("music-icon");
    if (musicIcon && !musicIcon.innerHTML) {
      musicIcon.innerHTML = SVG_MUSIC;
    }
    if (openOnMount) menu.show();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    window.showMusicMenu = menu.show;
    window.hideMusicMenu = menu.hide;
    window.toggleMusicMenu = menu.toggle;
    // probe/diag hook (also handy in devtools)
    (window as unknown as Record<string, unknown>).__musicDebug = () => ({
      ...musicSignal.value,
      frameSrc: document.getElementById("music-iframe")?.getAttribute("src") ?? null,
      frameParent: document.getElementById("music-iframe")?.parentElement?.className ?? null,
    });
    return () => {
      if (window.showMusicMenu === menu.show) delete window.showMusicMenu;
      if (window.hideMusicMenu === menu.hide) delete window.hideMusicMenu;
      if (window.toggleMusicMenu === menu.toggle) delete window.toggleMusicMenu;
    };
  }, [menu.show, menu.hide, menu.toggle]);

  // guard timer: if the iframe never fires onLoad (CSP/DNS/ad-block/COEP),
  // surface a "blocked" hint instead of an eternal blank frame.
  const open = musicSignal.value.open;
  const active = musicSignal.value.active;
  useEffect(() => {
    if (!open || !active) return;
    const timer = window.setTimeout(() => markEmbedBlocked(), 7000);
    return () => window.clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active]);


  const mini = musicSignal.value.mini;
  const warm = musicSignal.value.warm;
  const embedStatus = musicSignal.value.embedStatus;
  const searchState = searchStateSignal.value;
  const results = searchResultsSignal.value;
  const source = musicSourceSignal.value;
  const picks = musicPicks(source);
  const track = currentTrack();
  const activeTrackId = track?.id ?? null;
  // Las dos fuentes aceptan nombre de cancion y link. El placeholder solo
  // cambia para recordar que el link pegado tiene que ser de la fuente
  // activa (un link de spotify en modo youtube se resuelve igualmente, el menu
  // cambia solo, pero asi no hay sorpresas).
  const searchPlaceholder =
    source === "spotify"
      ? "song name or spotify link..."
      : "song name, spotify or youtube link...";
  const queue = queueSignal.value;
  // "up next" estilo youtube: los siguientes en orden de reproduccion
  const upcoming =
    queue.index >= 0 && queue.items.length > 1
      ? Array.from({ length: queue.items.length - 1 }, (_, off) => {
          const idx = (queue.index + 1 + off) % queue.items.length;
          const item = queue.items[idx];
          return item ? { item, idx } : null;
        }).filter((entry): entry is { item: QueueItem; idx: number } => entry !== null)
      : [];

  const view = musicSignal.value.view;
  const pageStatus = musicSignal.value.pageStatus;

  // mismo guard que el del embed pero para la pagina: si folio no logra
  // componerla en 7s (proxy caido, DNS, la web cambio a algo que ya no cruza)
  // el panel lo dice en vez de quedarse en negro sin explicacion
  useEffect(() => {
    if (!open || view !== "page" || pageStatus !== "loading") return;
    const timer = window.setTimeout(() => markPageBlocked(), 7000);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, view, pageStatus]);

  // persistent frame plumbing: one iframe for the whole app. when expanded it
  // lives in the panel; when minimized in the mini bar slot; otherwise it is
  // parked hidden. moving (not recreating) keeps playback alive.
  const panelFrameRef = useRef<HTMLDivElement | null>(null);
  const miniFrameRef = useRef<HTMLDivElement | null>(null);
  // slot de la pagina: mismo truco que el del embed (el iframe vive en un host
  // fijo y se coloca encima del rect del slot), porque mover un iframe en el
  // DOM recarga el documento
  const pageSlotRef = useRef<HTMLDivElement | null>(null);
  const [panelBox, setPanelBox] = useState<PanelBox | null>(() =>
    readStoredPanelBox(),
  );
  const dragRef = useRef<DragState | null>(null);
  const [dragging, setDragging] = useState(false);
  // el redimensionado se marca aparte del arrastre: sin esto las dos acciones se
  // sentian igual (mover es grab -> grabbing, redimensionar una flecha estatica)
  const [resizing, setResizing] = useState(false);
  // el tamano de la ventana va en estado porque de el dependen las dos medidas
  // que hay que recalcular cuando cambia: la caja del panel y la de maximizada
  const [viewport, setViewport] = useState(() => ({
    w: window.innerWidth,
    h: window.innerHeight,
  }));
  const [maximized, setMaximized] = useState(readStoredMaximized);

  // la caja vigente en un ref, no en el estado: applyPanelBox se usa dentro de
  // un manejador de arrastre que se creo una vez al empezar el gesto, y si
  // leyera del estado se quedaria con la caja de hace cien pixeles
  const panelBoxRef = useRef<PanelBox | null>(panelBox);

  // Todo cambio de la ventana del panel pasa por aqui y sale siempre encajada
  // en la pantalla. Que sea el unico punto es lo que hace fiable el invariante:
  // no depende de acordarse de encajarla en cada sitio.
  const applyPanelBox = useCallback((box: PanelBox) => {
    const fitted = fitBoxToViewport(box, window.innerWidth, window.innerHeight);
    const current = panelBoxRef.current;
    // sin esta comparacion se guardaria la misma caja en cada movimiento del
    // raton, decenas de veces por segundo, sin que nada haya cambiado
    if (current && isSameBox(fitted, current)) return;
    panelBoxRef.current = fitted;
    setPanelBox(fitted);
    writeStoredPanelBox(fitted);
    // el overlay se coloca en el siguiente frame, cuando el navegador ya ha
    // aplicado el nuevo rect al panel
    requestAnimationFrame(() => {
      placeFrame(panelFrameRef.current);
      placePageFrame(pageSlotRef.current);
    });
  }, []);

  // La ventana del navegador cambia de tamano: el panel se reencaja en vez de
  // quedarse colgando fuera del area visible (que es lo que pasaba al pasar de
  // un monitor grande a uno pequeno, sin ninguna forma de recuperarlo).
  useEffect(() => {
    const onResize = () =>
      setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (maximized) return;
    const current = panelBoxRef.current;
    if (!current) return;
    const fitted = fitBoxToViewport(current, viewport.w, viewport.h);
    if (isSameBox(fitted, current)) return;
    panelBoxRef.current = fitted;
    setPanelBox(fitted);
    // a proposito no se guarda: reencajar porque la ventana se ha quedado
    // pequena un momento no debe reescribir el tamano que eligio el usuario
  }, [maximized, viewport]);

  const toggleMaximized = useCallback(() => {
    setMaximized((was) => {
      const next = !was;
      writeStoredMaximized(next);
      return next;
    });
  }, []);

  // mientras esta maximizada la geometria la manda la ventana, no la caja
  // guardada: asi sigue ocundo todo lo disponible aunque se encoja la pantalla
  const panelGeometry = maximized
    ? maximizedBox(viewport.w, viewport.h)
    : panelBox;

  useEffect(() => {
    if (open) placeFrame(panelFrameRef.current);
    else if (mini && warm && active) placeFrame(miniFrameRef.current);
    else placeFrame(null);
  }, [open, mini, warm, active]);
  // con la vista pagina el embed se aparata (sigue sonando, fuera de pantalla)
  // y la pagina toma el slot. al minimizar tambien se aparata: la pagina vuelve
  // intacta al expandir, con la sesion y donde se estaba
  useEffect(() => {
    placePageFrame(open && view === "page" ? pageSlotRef.current : null);
  }, [open, view]);
  // re-seat after the panel settles (fonts/layout async); the effect above runs
  // before the panel reaches final geometry, and placeFrame must land the
  // overlay on the FINAL rect or the video shows offset/cropped (bug report).
  useEffect(() => {
    if (!open) return;
    const settle = () => {
      placeFrame(panelFrameRef.current);
      placePageFrame(pageSlotRef.current);
    };
    const frames = [0, 50, 150].map((ms) =>
      window.setTimeout(settle, ms),
    );
    const onResize = settle;
    window.addEventListener("resize", onResize);
    return () => {
      frames.forEach(clearTimeout);
      window.removeEventListener("resize", onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, view, panelGeometry?.left, panelGeometry?.top, panelGeometry?.width, panelGeometry?.height]);

  const runSearch = (input: HTMLInputElement) => {
    const value = input.value.trim();
    if (!value) return;

    // spotify link (o URI spotify:track:...) -> cambia al embed de spotify y
    // reproduce. el switch se mueve solo porque un link de spotify en un embed
    // de youtube no suena, y el usuario veria el frame en negro sin saber por
    // que.
    const spotify = toSpotifyLink(value);
    if (spotify) {
      if (source !== "spotify") {
        toast.info("sonando desde spotify");
      }
      setMusicSource("spotify");
      playSpotifyLink(spotify);
      clearSearchResults();
      input.value = "";
      return;
    }

    // youtube link (or raw id) -> play that video
    const ytId = toYouTubeId(value);
    if (ytId) {
      if (source !== "youtube") {
        toast.info("sonando desde youtube");
      }
      setMusicSource("youtube");
      playYouTubeVideo(ytId);
      clearSearchResults();
      input.value = "";
      return;
    }

    // texto libre -> busqueda contra la fuente activa (youtube por innertube,
    // spotify por su Web API). si a spotify le faltan credenciales en el
    // servicio, el estado "unavailable" de abajo lo explica.
    void searchMusic(value, source);
  };

  // ---- ventana movible y redimensionable -----------------------------------
  // El panel es un fixed anclado abajo a la derecha por CSS. En cuanto se
  // arrastra o se redimensiona pasa a llevar left/top/width/height en linea y a
  // recordarlos, porque el iframe persistente se coloca encima copiando el
  // rect del slot: si el panel se moviera sin avisar a placeFrame, el video
  // se quedaria quieto mientras la ventana se va.

  const beginDrag = useCallback(
    (event: PointerEvent, mode: DragMode, edges: readonly ResizeEdge[] = []) => {
      const panel = event.currentTarget as HTMLElement | null;
      const shell = panel?.closest(".music-panel") as HTMLElement | null;
      if (!shell) return;
      // el boton izquierdo es el unico que arrastra; el derecho abre el menu
      // contextual del navegador y no debe mover la ventana
      if (event.button !== 0) return;
      // la cabecera contiene el switch y los botones de accion: si el puntero
      // nacio en uno de ellos, el gesto es un click, no arrastrar la ventana
      if ((event.target as HTMLElement | null)?.closest("button, a, input") ) {
        return;
      }
      // maximizada la ventana ocupa lo que hay: moverla o agrandarla solo
      // produciria un salto al primer pixel. se sale de ese estado con el
      // boton o con doble clic en la cabecera
      if (maximized) return;
      const zoom = frameZoom();
      const rect = shell.getBoundingClientRect();
      const start: DragState = {
        mode,
        edges,
        zoom,
        pointerX: event.clientX,
        pointerY: event.clientY,
        // se siembra desde el rect (pixeles ya escalados) -> se divide por el
        // zoom, igual que hace placeFrame con el slot
        left: rect.left / zoom,
        top: rect.top / zoom,
        width: rect.width / zoom,
        height: rect.height / zoom,
      };
      dragRef.current = start;
      setDragging(true);
      setResizing(mode === "resize");
      // pointer capture en el elemento: aunque el raton salga del panel, los
      // eventos siguen llegando y la ventana no se queda pegada a mitad
      (panel as HTMLElement).setPointerCapture?.(event.pointerId);
      event.preventDefault();
    },
    [maximized],
  );

  useEffect(() => {
    if (!dragging) return;
    const onMove = (event: PointerEvent) => {
      const start = dragRef.current;
      if (!start) return;
      // los deltas de pointer ya vienen en pixeles de layout, que es
      // justamente la unidad de style: no se vuelven a dividir por el zoom
      const dx = event.clientX - start.pointerX;
      const dy = event.clientY - start.pointerY;
      if (start.mode === "move") {
        applyPanelBox({
          left: start.left + dx,
          top: start.top + dy,
          width: start.width,
          height: start.height,
        });
        return;
      }
      // la aritmetica del grow vive en resizeBox (panelBox.ts): un lado que se
      // MUEVE (norte u oeste) desplaza tambien su posicion para que el borde
      // contrario se quede quieto, y uno que solo CRECE (sur y este) no mueve
      // nada. asi las ocho zonas de agarre se comportan como una ventana de verdad
      applyPanelBox(
        resizeBox(
          start,
          start.edges,
          dx,
          dy,
          window.innerWidth,
          window.innerHeight,
        ),
      );
    };
    const onUp = () => {
      dragRef.current = null;
      setDragging(false);
      setResizing(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [dragging, applyPanelBox]);

  return (
    <>
      <section
        id="music-page"
        class={`music-page${menu.visible ? " is-visible" : ""}${menu.active ? " is-active" : ""}`}
        aria-hidden={!menu.active}
      >
        <div class="music-topbar">
          <div class="search-bar catalog-search-bar music-search-bar" ref={menu.searchBarRef}>
            <div class="light"></div>
            <div class="light-border"></div>
            <div class="light-inset-bg"></div>
            <span class="music-search-icon" aria-hidden="true">
              <IconMagnifyingGlass2 />
            </span>
            <input
              type="text"
              id="music-search-input"
              placeholder={searchPlaceholder}
              autocomplete="off"
              spellcheck={false}
              onKeyDown={(e: KeyboardEvent) => {
                if (e.key !== "Enter") return;
                runSearch(e.currentTarget as HTMLInputElement);
              }}
            />
          </div>
        </div>

        {searchState !== "idle" && (
          <div class="music-search-results" id="music-search-results">
            {searchState === "loading" && <p class="music-search-status">buscando…</p>}
            {searchState === "error" && (
              <p class="music-search-status">no se pudo buscar (intenta de nuevo)</p>
            )}
            {searchState === "unavailable" && (
              <p class="music-search-status music-search-unavailable">
                la busqueda en spotify necesita credenciales: pon{" "}
                <code>SPOTIFY_CLIENT_ID</code> y <code>SPOTIFY_CLIENT_SECRET</code> en
                el servicio de mercado y reincialo (si estan puestos pero no
                sirven, spotify los rechazo y tambien acabas aqui). mientras tanto
                puedes pegar un link de spotify o volver a youtube.
              </p>
            )}
            {searchState === "done" && results.length === 0 && (
              <p class="music-search-status">sin resultados</p>
            )}
            {results.map((r, i) => (
              <SearchResultRow key={`${r.source}-${r.id}`} result={r} index={i} />
            ))}
          </div>
        )}

        <div class="music-grid-container">
          <div class="music-header">
            <div class="music-header-art" aria-hidden="true">
              <IconAudio solid size={30} />
            </div>
            <div class="music-header-copy">
              <h2>music</h2>
              <p>
                search a song, paste a spotify/youtube link or pick a station - it keeps
                playing while you play, browse or watch, minimized in the corner.
              </p>
              <SourceSwitch source={source} />
            </div>
          </div>

          <div class="music-stations">
            {picks.map((pick) => (
              <StationButton
                pick={pick}
                activeId={activeTrackId}
                source={source}
              />
            ))}
          </div>

          <div class="music-launch">
            <button type="button" class="music-launch-btn" onClick={() => openMusic()}>
              {warm ? "open player" : "start listening"}
            </button>
            {warm && (
              <button
                type="button"
                class="music-launch-btn secondary"
                onClick={() => stopMusic()}
              >
                stop playback
              </button>
            )}
            {/* entrada a la vista pagina desde el menu: si solo existiera el
                conmutador de la cabecera, llegar a el exigiria haber abierto
                antes el reproductor */}
            <button
              type="button"
              class="music-launch-btn secondary"
              onClick={() => openMusicPage()}
            >
              open the {source} site
            </button>
          </div>
        </div>
      </section>

      {/* persistent player: expanded panel - lives outside the menu section so
          it survives closing the music menu */}
      {open && (
        <div
          class={`music-panel${dragging ? " is-dragging" : ""}${resizing ? " is-resizing" : ""}${maximized ? " is-maximized" : ""}`}
          role="dialog"
          aria-label="music player"
          style={
            panelGeometry
              ? {
                  left: `${panelGeometry.left}px`,
                  top: `${panelGeometry.top}px`,
                  width: `${panelGeometry.width}px`,
                  height: `${panelGeometry.height}px`,
                  right: "auto",
                  bottom: "auto",
                }
              : undefined
          }
        >
          {/* ocho zonas de agarre: las cuatro esquinas y los cuatro laterales.
              antes solo habia una esquina (arriba-izquierda, la opuesta al ancla),
              y con 18px de zona era casi imposible acertar — de ahi que
              redimensionar se sintiera raro. */}
          {RESIZE_HANDLES.map(({ handle, edges }) => (
            <div
              key={handle}
              class={`music-panel-resize music-panel-resize-${handle}`}
              role="separator"
              aria-label={`resize player from ${handle}`}
              onPointerDown={(event) => beginDrag(event, "resize", edges)}
            />
          ))}
          <div
            class="music-panel-head"
            onPointerDown={(event) => beginDrag(event, "move")}
            onDblClick={(event) => {
              // doble clic en la barra de titulo, como en cualquier ventana:
              // la via corta para hacerla grande sin buscar el boton
              if ((event.target as HTMLElement | null)?.closest("button, a, input")) {
                return;
              }
              toggleMaximized();
            }}
          >
            <span class="music-panel-title">{source}</span>
            <SourceSwitch source={source} />
            <ViewSwitch view={view} />
            <div class="music-panel-actions">
              <button type="button" title="anterior" onClick={() => prevTrack()}>
                ⏮
              </button>
              <button type="button" title="siguiente" onClick={() => nextTrack()}>
                ⏭
              </button>
              {/* separa "lo que suena" de "lo que hace la ventana": sin esta
                  linea los ocho controles de la cabecera son una fila homogenea
                  y no se distingue donde acaba la musica y empieza la ventana */}
              <span class="music-panel-actions-sep" aria-hidden="true" />
              {(active || view === "page") && (
                <button
                  type="button"
                  title="abrir en la app"
                  onClick={() =>
                    // en la vista pagina se abre la pagina que se esta viendo
                    // (puede ser una playlist a la que se navego dentro), no la
                    // home: el enlace tiene que llevar a donde estabas
                    openInApp(view === "page" ? currentPageUrl() : (active ?? ""))
                  }
                >
                  ↗
                </button>
              )}
              <button
                type="button"
                title={maximized ? "restore size" : "maximize"}
                aria-pressed={maximized}
                onClick={() => toggleMaximized()}
              >
                {maximized ? (
                  <IconDownsize size={16} />
                ) : (
                  <IconFullScreen size={16} />
                )}
              </button>
              <button type="button" title="minimize" onClick={() => minimizeMusic()}>
                —
              </button>
              <button
                type="button"
                title="minimize and keep playing"
                onClick={() => hideMusicPanel()}
              >
                ✕
              </button>
            </div>
          </div>
          {view === "page" ? (
            <div class="music-page-slot" ref={pageSlotRef}></div>
          ) : (
            <div class="music-panel-frame" ref={panelFrameRef}></div>
          )}
          {upcoming.length > 0 && (
            <div class="music-upnext">
              <div class="music-upnext-title">up next</div>
              {upcoming.map(({ item, idx }) => (
                <button
                  key={`${item.id}-${idx}`}
                  type="button"
                  class="music-upnext-item"
                  onClick={() => playQueueItem(idx)}
                >
                  <span class="music-upnext-name">{item.title}</span>
                  <em>{item.channel}</em>
                </button>
              ))}
            </div>
          )}
          {view === "page" && pageStatus === "blocked" && (
            <p class="music-embed-hint">
              la página no cargó (proxy caído, DNS o bloqueo de red). ábrela a
              pantalla completa:
              <button type="button" onClick={() => openInApp(currentPageUrl())}>
                abrir ↗
              </button>
            </p>
          )}
          {view === "player" && embedStatus === "blocked" && (
            <p class="music-embed-hint">
              el reproductor no cargó (bloqueo de red/adblock/DNS). ábrelo en la app,
              que usa el proxy:
              <button type="button" onClick={() => openInApp(active ?? "")}>
                abrir reproductor ↗
              </button>
            </p>
          )}
        </div>
      )}

      {/* persistent player: mini bar (stays while browsing/playing) */}
      {mini && !open && (
        <div class="music-mini" role="region" aria-label="mini player">
          <div class="music-mini-frame" ref={miniFrameRef}></div>
          <button
            type="button"
            class="music-mini-expand"
            title="expand"
            onClick={() => expandMusic()}
          >
            <IconAudio solid size={16} />
          </button>
          <button
            type="button"
            class="music-mini-skip"
            title="anterior"
            onClick={() => prevTrack()}
          >
            ⏮
          </button>
          <button
            type="button"
            class="music-mini-skip"
            title="siguiente"
            onClick={() => nextTrack()}
          >
            ⏭
          </button>
          <button
            type="button"
            class="music-mini-close"
            title="stop music"
            onClick={() => stopMusic()}
          >
            ✕
          </button>
        </div>
      )}
    </>
  );
}
