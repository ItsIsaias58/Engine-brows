// utilidades compartidas por todos los scripts del juego.
//
// vive en su propio fichero y se carga el primero (ver index.html) porque los
// <script> clasicos sin bundler comparten el ambito global: cualquier script
// posterior puede llamar a escapeHtml().
//
// antes solo habia un escapeHtml, dentro de profile.js, para la bio. El resto
// del juego metia texto del servidor en innerHTML sin escapar, entre ellos el
// broadcast del admin (title y msg son texto libre) y las notificaciones, que
// ademas se guardan y se vuelven a pintar cada vez que se abre el panel.
function escapeHtml(value){
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// una clase de CSS solo admite un conjunto concreto de caracteres. escapar no
// sirve para un valor que va dentro de class="...", asi que el "kind" de una
// notificacion o de un toast se filtra aparte.
function safeClassToken(value, fallback){
  const token = String(value == null ? '' : value).replace(/[^A-Za-z0-9_-]/g, '');
  return token || fallback;
}

// Token de sesion del mercado en una cookie en vez de en la URL del WebSocket.
//
// La API de WebSocket del navegador no permite poner cabeceras, pero el socket
// del mercado es same-origin, asi que la cookie viaja sola en el handshake. La
// alternativa era mandar el token como query, y prod.mjs escribe
// requestUrl.search en el access log: la sesion acababa escrita en disco.
//
// SameSite=Strict porque el token solo tiene que llegar al mercado, que es el
// mismo origen; no hace falta que viaje a terceros. El servidor acepta ademas
// el token por cabecera Authorization y por query, para clientes que no sean
// navegador (sondas de consola, tests).
const MARKET_COOKIE_NAME = "lyra_market_token";

function setMarketTokenCookie(token){
  const value = String(token || "");
  if (!value){
    document.cookie = MARKET_COOKIE_NAME + "=; Path=/; Max-Age=0; SameSite=Strict";
    return;
  }
  document.cookie =
    MARKET_COOKIE_NAME + "=" + encodeURIComponent(value) +
    "; Path=/; Max-Age=2592000; SameSite=Strict";
}
