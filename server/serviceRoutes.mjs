// rutas que lyra reenvia al servicio "owngames" (market). antes estas tres
// comprobaciones estaban escritas a mano en server/dev.mjs y server/prod.mjs:
// dos listas que tienen que coincidir y que nadie mas que grep recordaba.
//
// ojo con /ws/market: dev lo compara por prefijo y prod por igualdad exacta.
// es a proposito (en dev llega /ws/market?session=... sin parsear) y por eso el
// predicado del websocket lo elige cada servidor, no se comparte.

export const MARKET_WS_PATH = "/ws/market";

/** el arbol de juegos owngames: "/owngames" y "/owngames/..." */
export function isOwnGamesPath(url) {
  return url === "/owngames" || url.startsWith("/owngames/");
}

/** la api http del mercado: "/api/market..." */
export function isMarketApiPath(url) {
  return url.startsWith("/api/market");
}

// prefijo con frontera: "/api/auth" o "/api/auth/..." y nada mas. Un
// startsWith a pelo se comia "/api/authenticado", que es una ruta de lyra, y
// mandarle a la base de datos de las cuentas la peticion de otra cosa.
function isApiFamily(url, family) {
  return url === family || url.startsWith(`${family}/`);
}

/**
 * las cuentas de lyra y la nube: "/api/auth..." y "/api/sync...".
 *
 * Predicado propio y no un "lo demas va a cloudsync" a proposito: estas dos
 * familias son la unica parte de la api que NO es de lyra, y mandarlas por
 * defecto haria que un 404 por typo acabara en la base de datos de las cuentas.
 */
export function isCloudSyncPath(url) {
  return isApiFamily(url, "/api/auth") || isApiFamily(url, "/api/sync");
}
