// utilidad compartida por los <script> clásicos del juego (sin bundler): el
// token de sesión del mercado viaja en una cookie, no en la URL del WebSocket.
//
// La API de WebSocket del navegador no permite poner cabeceras, pero el socket
// del mercado es same-origin, así que la cookie viaja sola en el handshake. La
// alternativa era mandar el token como query, y prod.mjs escribe
// requestUrl.search en el access log: la sesión acababa escrita en disco.
//
// SameSite=Strict porque el token solo tiene que llegar al mercado, que es el
// mismo origen. El servidor acepta además el token por cabecera Authorization y
// por query, para clientes que no sean navegador (sondas de consola, tests).
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
