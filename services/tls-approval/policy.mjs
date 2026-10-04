// Politica pura de tls-approval: que dominios merecen certificado on-demand.
//
// vive aparte de server.js (que tiene el Bun.serve) para poder testearlo sin
// levantar nada. Toda la logica de decision es determinista y sin estado: los
// limites y TTL viven en server.js.

// sufijos de servicios que no deben recibir certificado: túneles efímeros,
// wildcard DNS y endpoints OAST/exfil. el punto inicial es para que
// `example.nip.io` case con `example`, y el dominio entero para que el apex
// (`nip.io`) tambien case, que antes se colaba.
export const BLOCKED_SUFFIXES = [
  '.nip.io', '.nip.io.br', '.sslip.io', '.securly.cloud', '.traefik.me',
  '.myaddr.io', '.backname.io', '.tiktokv.us', '.localtest.me',
  '.lvh.me', '.xip.io', '.xip.name', '.vcap.me',
  '.redirectme.net', '.wildcard.run',
  '.duckdns.org', '.freedns.afraid.org',
  '.ngrok.io', '.ngrok.app', '.serveo.net', '.localhost.run', '.tunnelmole.com',
  '.loca.lt', '.telebit.cloud', '.trycloudflare.com',
  '.burpcollaborator.net', '.interact.sh',
  '.oast.fun', '.oast.live', '.oast.site', '.oast.me', '.oast.online', '.oastify.com',
  '.canarytokens.com',
];

const BLOCKED = new Set(BLOCKED_SUFFIXES);

const MAX_DOMAIN_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;

/**
 * Un literal IPv4 valido, o null.
 *
 * Antes el rechazo de IPs vivas en un apaño: "si son 3 puntos y el ultimo
 * grupo mide 3 o menos". Eso dejaba pasar `192.168.1.1000`, `10.0.0.12345` y
 * `1.2.3.4444`, que no son IPs validas pero se colaban igual. Aqui se parsea
 * de verdad: cuatro grupos, cada uno 0-255, sin ceros a la izquierda.
 */
export function parseIpv4Literal(domain) {
  const parts = domain.split('.');
  if (parts.length !== 4) return null;
  for (const part of parts) {
    if (part.length === 0 || part.length > 3) return null;
    if (!/^\d+$/.test(part)) return null;
    // 010 no es "10": un octeto con cero inicial es ambiguo y algunos parsers
    // lo interpretan en octal. no vale la pena discutirlo con eturnal.
    if (part.length > 1 && part[0] === '0') return null;
    if (Number.parseInt(part, 10) > 255) return null;
  }
  return parts.join('.');
}

/**
 * Sintaxis de nombre de dominio, sin opinar sobre la politica.
 * Rechaza mayusculas, guiones en los extremos y etiquetas vacias o largas.
 */
export function isDomainSyntaxValid(domain) {
  if (domain.length === 0 || domain.length > MAX_DOMAIN_LENGTH) return false;

  const first = domain.charCodeAt(0);
  const last = domain.charCodeAt(domain.length - 1);
  // no empezar ni terminar en "." ni en "-"
  if (first === 46 || first === 45 || last === 46 || last === 45) return false;

  let hasDot = false;
  let previousWasDot = false;
  let labelLength = 0;

  for (let i = 0; i < domain.length; i++) {
    const code = domain.charCodeAt(i);
    if (code === 46) {
      if (previousWasDot || labelLength > MAX_LABEL_LENGTH) return false;
      hasDot = true;
      previousWasDot = true;
      labelLength = 0;
      continue;
    }
    previousWasDot = false;
    labelLength++;
    if (code === 45) {
      // guion al final de la etiqueta, o justo despues de un punto
      if (i === domain.length - 1) return false;
      if (i > 0 && domain.charCodeAt(i - 1) === 46) return false;
      continue;
    }
    const isDigit = code >= 48 && code <= 57;
    const isLowercase = code >= 97 && code <= 122;
    if (!isDigit && !isLowercase) return false;
  }

  if (!hasDot || previousWasDot) return false;
  return true;
}

/** true si el dominio (o cualquier ancestro suyo) esta en la lista negra */
export function isBlockedDomain(domain) {
  if (BLOCKED.has(`.${domain}`)) return true;
  for (
    let index = domain.indexOf('.');
    index !== -1;
    index = domain.indexOf('.', index + 1)
  ) {
    if (BLOCKED.has(domain.slice(index))) return true;
  }
  return false;
}

/**
 * Decision final: null si el dominio puede recibir certificado, o un motivo.
 * El servidor usa el motivo solo para el log; la respuesta HTTP no lo filtra.
 */
export function domainPolicyRejection(domain) {
  if (!isDomainSyntaxValid(domain)) return 'invalid domain';
  // un literal IPv4 no es un dominio: emitir para el es justo el caso que
  // hay que evitar con on-demand TLS.
  if (parseIpv4Literal(domain) !== null) return 'ip literal';
  if (isBlockedDomain(domain)) return 'blocked domain';
  return null;
}
