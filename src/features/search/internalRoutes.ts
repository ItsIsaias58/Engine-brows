// rutas que lyra sirve en su propio origen y que por eso no deben pasar por
// ningun proxy.
//
// /owngames son los juegos de lyra. metidos en el proxy, folio aborta con
// "attempted to fetch from same origin" en cuanto la pagina pide algo a su
// alrededor, y mochi reescribiria las urls relativas contra /!!/, rompiendo
// cada recurso que carga. /stream/anime es el reproductor, que tampoco necesita
// proxificarse.
//
// vive en su propio modulo (sin imports) por lo mismo que hotCache.ts: se
// prueba directamente, sin levantar store, iframe ni el resto del navegador.

const INTERNAL_ROUTES = [
  /^\/owngames(?:$|[/?#])/,
  /^\/stream\/anime(?:$|[/?#])/,
];

/**
 * la url tal cual hay que cargarla si es una ruta propia de lyra, o null si
 * tiene que pasar por el proxy como cualquier sitio externo.
 *
 * @param query lo que el usuario pidio abrir
 * @param origin el origen de la propia app
 */
export function getInternalRouteUrl(
  query: string,
  origin: string,
): string | null {
  const trimmed = query.trim();
  if (!trimmed || !origin) return null;
  try {
    const url = new URL(trimmed, origin);
    if (url.origin !== origin) return null;
    const target = url.pathname + url.search + url.hash;
    return INTERNAL_ROUTES.some((route) => route.test(target)) ? url.href : null;
  } catch {
    return null;
  }
}