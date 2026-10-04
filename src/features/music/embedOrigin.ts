// Por que vivia suelto y con includes(): el unico requisito era "que venga de
// youtube", y includes() lo cumple — por accidente. El embed que se carga es
// www.youtube-nocookie.com, que contiene la subcadena "youtube", asi que el
// chequeo pasaba... mientras tambien pasaban youtube.com.evil.example y
// notyoutube.com. No era una validacion: era una coincidencia.
//
// includes() no valida un dominio, busca una subcadena. Un origen es una
// propertyAD de seguridad: lo que decide si un mensaje de otro sitio puede
// empujarte a cambiar de cancion. Merece una comparacion exacta, no un Contains.
//
// Vive en su propio modulo (sin imports) por lo mismo que internalRoutes.ts y
// frameFocus.ts: se prueba sin DOM ni signals.

// los dominios que emite el widget API de youtube. nocookie es el que se carga
// realmente (youTubeEmbedUrl); los de www estan porque un embed puede redirigir
// de uno a otro y el que avisa del fin seria entonces el segundo.
const EMBED_ORIGIN_HOSTS = new Set([
  "www.youtube-nocookie.com",
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
]);

/**
 * El mensaje viene de un embed de youtube que podemos confiar.
 *
 * @param origin el event.origin del postMessage
 */
export function isTrustedEmbedOrigin(origin: unknown): boolean {
  if (typeof origin !== "string" || origin.length === 0) return false;
  try {
    return EMBED_ORIGIN_HOSTS.has(new URL(origin).hostname);
  } catch {
    // origin malformado: no es de nadie que nos interese
    return false;
  }
}

/**
 * El payload con el que el embed avisa de que el video se acabo.
 *
 * El widget API manda dos formas y llegan las dos en el mismo stream: la vieja
 * (event: "onStateChange", info: 0) y la de la entrega periodica de estado
 * (event: "infoDelivery", info: { playerState: 0 }). Solo 0 significa "terminado";
 * los demas son reproduciendo / pausado / cargando.
 */
export function isEndOfStreamMessage(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const message = data as { event?: unknown; info?: unknown };
  if (message.event === "onStateChange" && message.info === 0) return true;
  if (message.event !== "infoDelivery") return false;
  if (!message.info || typeof message.info !== "object") return false;
  return (message.info as { playerState?: unknown }).playerState === 0;
}