import { describe, expect, test } from "bun:test";
import { webRequestType } from "./webRequestType.ts";

/**
 * La implementacion original, copiada literalmente de rivet.ts. Sirve de
 * referencia: el test diferencial de abajo compara ambas en TODOS los destinos
 * posibles para demostrar que la tabla no cambio ni un caso.
 */
function original(parsed: any): string {
  const destination = String(parsed?.destination || "");
  if (destination === "document") return parsed?.isIframe ? "sub_frame" : "main_frame";
  if (destination === "iframe" || destination === "frame") return "sub_frame";
  if (destination === "style") return "stylesheet";
  if (destination === "script") return "script";
  if (destination === "image") return "image";
  if (destination === "font") return "font";
  if (destination === "audio" || destination === "video" || destination === "track") return "media";
  if (destination === "worker" || destination === "sharedworker" || destination === "serviceworker") return "other";
  if (destination === "report") return "ping";
  if (parsed?.fetchMode) return "xmlhttprequest";
  return "other";
}

describe("webRequestType", () => {
  test("document sin isIframe es main_frame", () => {
    expect(webRequestType({ destination: "document" })).toBe("main_frame");
  });

  test("document con isIframe es sub_frame", () => {
    expect(webRequestType({ destination: "document", isIframe: true })).toBe("sub_frame");
  });

  test("iframe y frame son sub_frame", () => {
    expect(webRequestType({ destination: "iframe" })).toBe("sub_frame");
    expect(webRequestType({ destination: "frame" })).toBe("sub_frame");
  });

  test("object y embed son object", () => {
    expect(webRequestType({ destination: "object" })).toBe("object");
    expect(webRequestType({ destination: "embed" })).toBe("object");
    // antes caia en el fallback y con fetchMode era "xmlhttprequest"
    expect(webRequestType({ destination: "object", fetchMode: "cors" })).toBe("object");
  });

  test("manifest y websocket son other, no xmlhttprequest", () => {
    expect(webRequestType({ destination: "manifest", fetchMode: "cors" })).toBe("other");
    expect(webRequestType({ destination: "websocket", fetchMode: "cors" })).toBe("other");
  });

  test("csp_report conserva su tipo", () => {
    expect(webRequestType({ destination: "csp_report" })).toBe("csp_report");
  });

  test("los subrecursos se mapean uno a uno", () => {
    expect(webRequestType({ destination: "style" })).toBe("stylesheet");
    expect(webRequestType({ destination: "script" })).toBe("script");
    expect(webRequestType({ destination: "image" })).toBe("image");
    expect(webRequestType({ destination: "font" })).toBe("font");
    expect(webRequestType({ destination: "report" })).toBe("ping");
  });

  test("audio, video y track son media", () => {
    expect(webRequestType({ destination: "audio" })).toBe("media");
    expect(webRequestType({ destination: "video" })).toBe("media");
    expect(webRequestType({ destination: "track" })).toBe("media");
  });

  // los workers se resuelven a "other" ANTES de mirar fetchMode: una peticion de
  // worker con fetchMode sigue siendo "other", no "xmlhttprequest".
  test("los workers ganan al fallback de fetchMode", () => {
    for (const destination of ["worker", "sharedworker", "serviceworker"]) {
      expect(webRequestType({ destination, fetchMode: "cors" })).toBe("other");
    }
  });

  test("un destino desconocido con fetchMode es xmlhttprequest", () => {
    expect(webRequestType({ destination: "", fetchMode: "cors" })).toBe("xmlhttprequest");
    expect(webRequestType({ destination: "desconocido", fetchMode: "no-cors" })).toBe(
      "xmlhttprequest",
    );
  });

  test("un destino desconocido sin fetchMode es other", () => {
    expect(webRequestType({ destination: "" })).toBe("other");
    expect(webRequestType({})).toBe("other");
    expect(webRequestType(undefined)).toBe("other");
  });

  test("un fetchMode falsy no cuenta", () => {
    expect(webRequestType({ destination: "", fetchMode: "" })).toBe("other");
    expect(webRequestType({ destination: "", fetchMode: undefined })).toBe("other");
  });

  // el motivo de usar un Map: con un objeto literal, estos nombres heredarian
  // una funcion del prototipo y se devolveria eso en vez de un type.
  test("destinos que son claves del prototipo no devuelven el prototipo", () => {
    for (const destination of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      expect(webRequestType({ destination })).toBe("other");
    }
  });

  test("un parsed no-objeto no rompe", () => {
    // un string no tiene .destination, asi que cae al fallback igual que la
    // cascada original: no se lee "document" del valor, sino de la propiedad
    expect(webRequestType("document")).toBe("other");
    expect(webRequestType(42)).toBe("other");
    expect(webRequestType(null)).toBe("other");
    expect(webRequestType({ destination: "document" })).toBe("main_frame");
  });

  // el type tiene que ser siempre uno de los que acepta declarativeNetRequest,
  // porque va directo a las extensiones sin validar.
  test("solo devuelve types validos de webRequest", () => {
    const valid = new Set([
      "main_frame",
      "sub_frame",
      "stylesheet",
      "script",
      "image",
      "font",
      "object",
      "xmlhttprequest",
      "ping",
      "csp_report",
      "media",
      "webtransport",
      "webbundle",
      "other",
    ]);
    const destinations = [
      "document", "iframe", "frame", "style", "script", "image", "font",
      "audio", "video", "track", "worker", "sharedworker", "serviceworker",
      "report", "", "object", "embed", "manifest", "websocket", "csp_report",
      "xslt", "prefetch", "unknown",
    ];
    for (const destination of destinations) {
      for (const isIframe of [false, true]) {
        for (const fetchMode of [undefined, "cors", "no-cors"]) {
          const type = webRequestType({ destination, isIframe, fetchMode });
          expect(valid.has(type)).toBe(true);
        }
      }
    }
  });
});

describe("destinos con tipo propio anadido", () => {
  // cambio deliberado: estos destinos tienen tipo en Chrome y antes se
  // clasificaban por el fallback de fetchMode, no por su naturaleza.
  const cases: [string, string][] = [
    ["object", "object"],
    ["embed", "object"],
    ["manifest", "other"],
    ["websocket", "other"],
    ["csp_report", "csp_report"],
  ];
  for (const [destination, expected] of cases) {
    test(`${destination} es ${expected}`, () => {
      expect(webRequestType({ destination })).toBe(expected);
      expect(webRequestType({ destination, fetchMode: "cors" })).toBe(expected);
    });
  }
});

describe("webRequestType es equivalente a la cascada original", () => {
  // destinos cuyo mapeo NO se cambio: la cascada y la tabla tienen que coincidir
  // en todos los casos, incluidos los degenerados.
  //
  // los de abajo quedan fuera a proposito porque se les anadio tipo propio en
  // la tabla (ver "destinos con tipo propio anadido"): antes caian al fallback
  // por fetchMode y se clasificaban mal.
  const intentionallyChanged = ["object", "embed", "manifest", "websocket", "csp_report"];
  const destinations = [
    "document", "iframe", "frame", "style", "script", "image", "font",
    "audio", "video", "track", "worker", "sharedworker", "serviceworker",
    "report", "", "xslt", "prefetch", "unknown", "DOCUMENT", "toString", "__proto__",
    "constructor", "hasOwnProperty", "valueOf", "  ", "image ",
  ];
  const iframeValues = [undefined, true, false, 0, 1, "", "si"];
  const fetchModes = [undefined, "cors", "no-cors", "navigate", "", 0, null];

  test("ninguno de los destinos de la tabla quedo fuera sin querer", () => {
    for (const destination of intentionallyChanged) {
      expect(destinations).not.toContain(destination);
    }
  });

  test("coinciden en todas las combinaciones", () => {
    for (const destination of destinations) {
      for (const isIframe of iframeValues) {
        for (const fetchMode of fetchModes) {
          const parsed = { destination, isIframe, fetchMode };
          const before = original(parsed);
          const after = webRequestType(parsed);
          expect(after).toBe(before);
        }
      }
    }
  });

  test("coinciden con parsed ausente o vacio", () => {
    for (const parsed of [undefined, null, {}, { destination: null }]) {
      expect(webRequestType(parsed)).toBe(original(parsed));
    }
  });
});
