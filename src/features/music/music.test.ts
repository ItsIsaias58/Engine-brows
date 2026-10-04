import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  searchMusic,
  searchResultsSignal,
  searchStateSignal,
  musicPageUrl,
  musicPicks,
  musicSourceSignal,
  nextTrack,
  playSearchResult,
  queueSnapshot,
  spotifyEmbedUrl,
  toSpotifyLink,
  toYouTubeId,
  youTubeEmbedUrl,
} from "./music.ts";

// los ids de spotify del menu están verificados contra el oEmbed público: si
// alguno se rompe, el embed abre un reproductor vacío, así que la prueba avisa
// antes de que lo descubra el usuario.
const SPOTIFY_STATION_IDS = [
  "37i9dQZF1DWWQRwui0ExPn",
  "0vvXsWCC9xrXsKd4FyS8kM",
  "2gb0qEVV8PSdt3M5Sc3CZF",
] as const;

describe("toSpotifyLink", () => {
  test("acepta las URLs de compartir de spotify", () => {
    expect(toSpotifyLink("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT")).toEqual({
      id: "4cOdK2wGLETKBW3PvgPWqT",
      kind: "track",
    });
    expect(
      toSpotifyLink("https://open.spotify.com/album/1ATL5GLyefJaxhQzSPVrLX"),
    ).toEqual({ id: "1ATL5GLyefJaxhQzSPVrLX", kind: "album" });
    expect(
      toSpotifyLink("https://open.spotify.com/playlist/37i9dQZF1DWWQRwui0ExPn"),
    ).toEqual({ id: "37i9dQZF1DWWQRwui0ExPn", kind: "playlist" });
  });

  test("acepta el prefijo de idioma y el www", () => {
    expect(
      toSpotifyLink("https://open.spotify.com/intl-es/track/4cOdK2wGLETKBW3PvgPWqT"),
    ).toEqual({ id: "4cOdK2wGLETKBW3PvgPWqT", kind: "track" });
    expect(
      toSpotifyLink("play.spotify.com/album/1ATL5GLyefJaxhQzSPVrLX"),
    ).toEqual({ id: "1ATL5GLyefJaxhQzSPVrLX", kind: "album" });
  });

  test("acepta el URI de las apps de escritorio", () => {
    expect(toSpotifyLink("spotify:track:4cOdK2wGLETKBW3PvgPWqT")).toEqual({
      id: "4cOdK2wGLETKBW3PvgPWqT",
      kind: "track",
    });
    expect(
      toSpotifyLink("spotify:intl-es:playlist:37i9dQZF1DWWQRwui0ExPn"),
    ).toEqual({ id: "37i9dQZF1DWWQRwui0ExPn", kind: "playlist" });
  });

  test("ignora lo que no es de spotify, aunque parezca una URL", () => {
    expect(toSpotifyLink("")).toBeNull();
    expect(toSpotifyLink("   ")).toBeNull();
    expect(toSpotifyLink("lofi beats")).toBeNull();
    expect(toSpotifyLink("https://www.youtube.com/watch?v=jfKfPfyJRdk")).toBeNull();
    // un tipo que el embed no sabe reproducir no vale: se pasaria por alto y
    // construiria una url /embed/<tipo>/<id> que spotify no sirve
    expect(toSpotifyLink("https://open.spotify.com/artist/0gxyHStUsqpMadRV0Di1Qt")).toBeNull();
    // y un id con caracteres raros es exactamente el caso donde no se debe
    // construir una url a ojo
    expect(
      toSpotifyLink("https://open.spotify.com/track/../../evil"),
    ).toBeNull();
  });
});

describe("embeds", () => {
  test("el de youtube mantiene nocookie, autoplay y el origin de la widget api", () => {
    const url = new URL(youTubeEmbedUrl("jfKfPfyJRdk"));
    expect(url.host).toBe("www.youtube-nocookie.com");
    expect(url.pathname).toBe("/embed/jfKfPfyJRdk");
    expect(url.searchParams.get("autoplay")).toBe("1");
    expect(url.searchParams.get("rel")).toBe("0");
    // sin origin, el embed no manda los eventos onStateChange y la cola nunca
    // avanza sola
    expect(url.searchParams.has("origin")).toBe(true);
  });

  test("el de spotify es el embed oficial con el tipo del contenido", () => {
    expect(spotifyEmbedUrl("playlist", "37i9dQZF1DWWQRwui0ExPn")).toBe(
      "https://open.spotify.com/embed/playlist/37i9dQZF1DWWQRwui0ExPn",
    );
    expect(spotifyEmbedUrl("track", "4cOdK2wGLETKBW3PvgPWqT")).toBe(
      "https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT",
    );
  });
});

describe("estaciones por fuente", () => {
  test("cada fuente tiene tres estaciones y solo las suyas", () => {
    const youtube = musicPicks("youtube");
    const spotify = musicPicks("spotify");
    expect(youtube).toHaveLength(3);
    expect(spotify).toHaveLength(3);
    expect(youtube.every((pick) => Boolean(pick.videoId))).toBe(true);
    expect(youtube.every((pick) => !pick.spotifyId)).toBe(true);
    expect(spotify.every((pick) => Boolean(pick.spotifyId))).toBe(true);
    expect(spotify.every((pick) => !pick.videoId)).toBe(true);
  });

  test("los ids de spotify son los verificados", () => {
    expect(musicPicks("spotify").map((pick) => pick.spotifyId)).toEqual([
      ...SPOTIFY_STATION_IDS,
    ]);
  });

  test("cada id de spotify es algo que el parser acepta como playlist", () => {
    for (const id of SPOTIFY_STATION_IDS) {
      expect(toSpotifyLink(`https://open.spotify.com/playlist/${id}`)).toEqual({
        id,
        kind: "playlist",
      });
    }
  });

  test("los ids de youtube son de 11 caracteres, como exige el embed", () => {
    for (const pick of musicPicks("youtube")) {
      const videoId = pick.videoId;
      expect(videoId).toMatch(/^[\w-]{11}$/);
      // el parser tiene que devolver exactamente el mismo id: si lo alterara al
      // ida y vuelta, la estacion sonaria un video que no es el de la lista
      expect(videoId && toYouTubeId(videoId)).toBe(videoId);
    }
  });
});

describe("la pagina de la fuente", () => {
  // la vista "page" no es un reproductor: es la web real metida en el panel
  // para poder iniciar sesion y buscar, que el embed no deja hacer
  test("cada fuente abre su web, no la del embed", () => {
    expect(musicPageUrl("spotify")).toBe("https://open.spotify.com/");
    // movil, no escritorio: el panel es estrecho y youtube.com no cabe
    expect(musicPageUrl("youtube")).toBe("https://m.youtube.com/");
  });

  test("sin argumento usa la fuente activa", () => {
    const before = musicSourceSignal.value;
    try {
      musicSourceSignal.value = "spotify";
      expect(musicPageUrl()).toBe("https://open.spotify.com/");
      musicSourceSignal.value = "youtube";
      expect(musicPageUrl()).toBe("https://m.youtube.com/");
    } finally {
      musicSourceSignal.value = before;
    }
  });

  test("las dos son paginas reales, no los urls del embed", () => {
    for (const source of ["youtube", "spotify"] as const) {
      const url = musicPageUrl(source);
      expect(url).toMatch(/^https:\/\//);
      expect(url).not.toContain("/embed/");
    }
  });
});

describe("searchMusic", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    searchResultsSignal.value = [];
    searchStateSignal.value = "idle";
  });

  // un fetch de mentira: solo se usa json(), asi que se implementa lo minimo y
  // se castea por unknown porque la firma real de fetch no encaja con un stub
  function setFetch(impl: (url: string) => Promise<unknown>): void {
    globalThis.fetch = ((input: RequestInfo | URL) =>
      impl(String(input))) as unknown as typeof fetch;
  }

  function stubJson(payload: unknown): void {
    setFetch(async () => ({ ok: true, json: async () => payload }));
  }

  test("le pasa la fuente activa al puente", async () => {
    let url = "";
    setFetch(async (requested) => {
      url = requested;
      return { ok: true, json: async () => ({ configured: true, results: [] }) };
    });

    await searchMusic("lofi beats", "spotify");
    expect(url).toContain("source=spotify");
    expect(url).toContain("q=lofi%20beats");
    expect(searchStateSignal.value).toBe("done");
  });

  // el caso que vera el usuario sin credenciales: tiene que ser distinguible
  // de "no hay resultados", porque el remedy es otro muy distinto
  test("configured:false deja el estado unavailable, no error", async () => {
    stubJson({ source: "spotify", configured: false, results: [] });
    await searchMusic("lofi", "spotify");
    expect(searchStateSignal.value).toBe("unavailable");
    expect(searchResultsSignal.value).toEqual([]);
  });

  test("conserva la fuente de cada resultado para reproducirlo en su embed", async () => {
    stubJson({
      source: "spotify",
      configured: true,
      results: [
        {
          id: "4cOdK2wGLETKBW3PvgPWqT",
          title: "lofi",
          channel: "someone",
          source: "spotify",
          kind: "track",
        },
      ],
    });
    await searchMusic("lofi", "spotify");
    expect(searchStateSignal.value).toBe("done");
    expect(searchResultsSignal.value).toHaveLength(1);
    expect(searchResultsSignal.value[0]?.source).toBe("spotify");
    expect(searchResultsSignal.value[0]?.kind).toBe("track");
  });

  // un 429 o un 5xx de spotify no son "credenciales malas": son pasajero, y el
  // menu debe poder decirlo ("intenta de nuevo") en vez de pedirle al usuario
  // que vaya a tocar el env
  test("failed:true (fallo pasajero) es error, no unavailable", async () => {
    stubJson({ source: "spotify", configured: true, failed: true, results: [] });
    await searchMusic("lofi", "spotify");
    expect(searchStateSignal.value).toBe("error");
  });

  test("una peticion que revienta es error, no unavailable", async () => {
    setFetch(() => {
      throw new Error("offline");
    });
    await searchMusic("lofi", "youtube");
    expect(searchStateSignal.value).toBe("error");
  });

  test("una consulta en blanco no toca la red", async () => {
    let called = false;
    setFetch(async () => {
      called = true;
      return { ok: true, json: async () => ({}) };
    });
    await searchMusic("   ", "youtube");
    expect(called).toBe(false);
  });

  // el buscador se dispara con cada tecla: si la respuesta de una consulta
  // vieja llega despues que la nueva, no puede pisarle los resultados
  test("una busqueda lenta no pisa a la ultima lanzada", async () => {
    const resolvers: Array<(payload: unknown) => void> = [];
    setFetch(
      () =>
        new Promise((resolve) => {
          resolvers.push((payload) =>
            resolve({ ok: true, json: async () => payload }),
          );
        }),
    );
    const vieja = searchMusic("vieja", "youtube");
    const nueva = searchMusic("nueva", "youtube");
    // la nueva responde primero y gana
    resolvers[1]?.({
      results: [
        { id: "nueva1", title: "nueva", channel: "c", source: "youtube" },
      ],
    });
    await nueva;
    // la vieja responde despues: debe descartarse
    resolvers[0]?.({
      results: [
        { id: "vieja1", title: "vieja", channel: "c", source: "youtube" },
      ],
    });
    await vieja;
    expect(searchResultsSignal.value.map((r) => r.id)).toEqual(["nueva1"]);
    expect(searchStateSignal.value).toBe("done");
  });
});

describe("cola de musica", () => {
  const realDocument = (globalThis as Record<string, unknown>).document;
  const realWindow = (globalThis as Record<string, unknown>).window;
  const realFetch = globalThis.fetch;

  beforeAll(() => {
    // stub minimo: bun test no trae DOM y nextTrack/playSearchResult tocan el
    // iframe persistente. basta con el host (para que createPersistentFrame
    // salga sin construir nada) y el frame (para el setAttribute del src).
    (globalThis as Record<string, unknown>).window = {
      location: { origin: "http://localhost" },
    };
    (globalThis as Record<string, unknown>).document = {
      getElementById: (id: string) => {
        if (id === "music-frame-host") return {};
        if (id === "music-iframe") {
          return { setAttribute: () => {}, getAttribute: () => null };
        }
        return null;
      },
    };
  });

  afterAll(() => {
    (globalThis as Record<string, unknown>).document = realDocument;
    (globalThis as Record<string, unknown>).window = realWindow;
    globalThis.fetch = realFetch;
  });

  // al acabar la cancion deben sonar los RECOMENDADOS: antes el auto-avance
  // hacia el modulo de inmediato y volvia al primer resultado, asi que la
  // busqueda entera se repetia antes de llegar a lo que traia extendQueue
  test("al acabar la cola (auto) suenan los recomendados, no se repite", async () => {
    searchResultsSignal.value = [
      { id: "aaaaaaaaaaa", title: "a", channel: "c", source: "youtube" },
    ];
    playSearchResult(0); // cola = [a], suena a

    globalThis.fetch = (async () => ({
      json: async () => ({
        results: [
          { id: "ccccccccccc", title: "rec", channel: "ch", source: "youtube" },
        ],
      }),
    })) as unknown as typeof fetch;

    nextTrack(true); // fin de cola: pide recomendados y salta al primero nuevo
    await new Promise((resolve) => setTimeout(resolve, 20));

    const snap = queueSnapshot();
    expect(snap.items.map((item) => item.id)).toEqual(["aaaaaaaaaaa", "ccccccccccc"]);
    expect(snap.index).toBe(1); // el primer recomendado, no un rewind al 0
  });

  // sin red (o sin recomendados nuevos) el fallback sigue siendo el bucle
  test("sin recomendados nuevos, el auto-avance da la vuelta", async () => {
    // el dedup de eventos repetidos ignora otro auto-avance dentro de 1500ms
    await new Promise((resolve) => setTimeout(resolve, 1550));
    searchResultsSignal.value = [
      { id: "ddddddddddd", title: "d", channel: "c", source: "youtube" },
    ];
    playSearchResult(0);

    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;

    nextTrack(true); // fin de cola, fetch revienta
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(queueSnapshot().index).toBe(0);
  });
});
