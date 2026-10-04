// Traduccion del `destination` de una peticion de folio al `type` que las
// extensiones de Chrome esperan en webRequest.
//
// Antes era una cascada de `if` dentro de rivet.ts, entrelazada con el resto del
// plugin de DNR y sin ninguna forma de testearla. Aqui es una tabla.
//
// vive en su propio modulo (sin imports) por lo mismo que hotCache.ts: se
// prueba directamente, sin levantar la extension.

/**
 * destino de la peticion -> type de webRequest.
 *
 * `document` no esta en la tabla a proposito: depende de `isIframe`, se resuelve
 * aparte. Los workers tampoco: caen a "other" pero ANTES que el `fetchMode` de
 * mas abajo, y la tabla mantiene ese orden porque se consulta antes que el
 * fallback.
 */
const DESTINATION_TYPES = new Map<string, string>([
  ["iframe", "sub_frame"],
  ["frame", "sub_frame"],
  ["style", "stylesheet"],
  ["script", "script"],
  ["image", "image"],
  ["font", "font"],
  ["audio", "media"],
  ["video", "media"],
  ["track", "media"],
  ["worker", "other"],
  ["sharedworker", "other"],
  ["serviceworker", "other"],
  ["report", "ping"],
  // destinos que el fallback clasificaba como "xmlhttprequest" solo porque
  // fetchMode venia informado, y como "other" si no. Chrome los tiene como
  // tipo propio y las extensiones filtran por el.
  ["object", "object"],
  ["embed", "object"],
  ["manifest", "other"],
  ["websocket", "other"],
  ["csp_report", "csp_report"],
]);

/**
 * @param parsed el `context.parsed` de folio
 * @returns el type de webRequest correspondiente
 */
export function webRequestType(parsed: any): string {
  const destination = String(parsed?.destination || "");

  // un documento es la ventana principal o un iframe segun quien lo pidio
  if (destination === "document") {
    return parsed?.isIframe ? "sub_frame" : "main_frame";
  }

  // Map y no un objeto literal: con `obj[destination]` un destination como
  // "toString" o "__proto__" devolveria algo heredado del prototipo en vez de
  // caer al fallback.
  const mapped = DESTINATION_TYPES.get(destination);
  if (mapped !== undefined) return mapped;

  // sin destino reconocible, una peticion con fetchMode es un XHR
  if (parsed?.fetchMode) return "xmlhttprequest";
  return "other";
}
