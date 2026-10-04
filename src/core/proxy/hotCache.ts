// Politica de la "hot cache" de assets acelerados: que respuestas se pueden
// reutilizar sin volver a preguntar al origin, durante cuanto y bajo que clave.
//
// vive aparte de folio.ts a proposito: no importa nada, asi que se puede testear
// sin levantar el proxy entero (ver src/core/proxy/hotCache.test.ts).

/** techo de vida de una entrada, pase lo que pase el origin */
const MAX_AGE_MS = 10 * 60 * 1000;

/**
 * Cabeceras de peticion cuyo valor se mete en la clave de la cache. Son las que
 * un origin nombra en `Vary` con mas frecuencia. Se incluyen SIEMPRE, no solo
 * cuando la respuesta declara `Vary`, porque en el momento de la peticion no se
 * sabe que campos dira el origin: si se anadieran despues, la clave guardada y
 * la clave buscada no coincidirian y la entrada quedaria inalcanzable.
 */
const VARIANT_FIELDS = ["accept-encoding", "accept-language"] as const;

/**
 * Campos que un origin puede nombrar en `Vary` sin que el cuerpo cambie, porque
 * mochi nunca se los enseña al upstream: los borra antes de pedir el asset (ver
 * `raw_proxy_handler` en services/mochi/src/proxy.rs). Los CDN de juegos los
 * mandan de verdad — crazygames responde `vary: Origin` + `vary: accept-encoding`
 * y jsdelivr tres cabeceras `vary`—, asi que rechazarlos sin mas dejaria la hot
 * cache vacia justo para los juegos que mas assets descargan.
 *
 * `access-control-request-*` solo decide el `Access-Control-Allow-*` de un
 * preflight, y por el acelerador solo pasan GET y HEAD.
 *
 * Es la misma lista que `RAW_NEUTRAL_VARY_FIELDS` en Rust: las dos caches
 * decisionan sobre las MISMAS cabeceras, las que van en `raw_headers`, asi que
 * si divergieran una cachearia lo que la otra prohibe.
 */
const NEUTRAL_VARY_FIELDS = new Set([
  "cookie",
  "authorization",
  "proxy-authorization",
  "origin",
  "referer",
  "access-control-request-method",
  "access-control-request-headers",
]);

export function rawHeaderValue(
  rawHeaders: [string, string][],
  name: string,
): string | null {
  const lowerName = name.toLowerCase();
  for (const [key, value] of rawHeaders) {
    if (key.toLowerCase() === lowerName) return value;
  }
  return null;
}

/**
 * Los campos que un origin declara en `Vary`, en minusculas y sin repetir, o
 * `null` si no declara ninguno.
 *
 * Se recorren TODAS las cabeceras `vary`, no solo la primera: una respuesta
 * puede traer varias (jsdelivr manda tres) y quedarse con la primera dejaria
 * pasar un `Vary: User-Agent` escondido detras de un `Vary: Accept-Encoding`.
 */
function varyFields(rawHeaders: [string, string][]): string[] | null {
  const values: string[] = [];
  for (const [key, value] of rawHeaders) {
    if (key.toLowerCase() === "vary") values.push(value);
  }
  if (values.length === 0) return null;
  const fields = values.flatMap((value) =>
    value
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean),
  );
  if (fields.includes("*")) return ["*"];
  return [...new Set(fields)];
}

/**
 * Si la respuesta se puede guardar en la hot cache y bajo que variante.
 *
 * - `cacheable: false` cuando el origin pide que no se reutilice sin
 *   revalidar (`no-store`, `no-cache`), cuando es privada, o cuando declara un
 *   `Vary` sobre un campo que esta cache no sabe distinguir.
 * - `cacheable: true` con `fields: []` cuando no hay `Vary`: la variante la
 *   decide solo la parte de la clave que ya incluye los valores de VARIANT_FIELDS.
 */
export function hotCacheVary(
  rawHeaders: [string, string][],
): { cacheable: boolean; fields: string[] } {
  const fields = varyFields(rawHeaders);
  if (!fields) return { cacheable: true, fields: [] };
  if (fields.includes("*")) return { cacheable: false, fields };
  const unsupported = fields.filter(
    (field) =>
      !VARIANT_FIELDS.includes(field as never) && !NEUTRAL_VARY_FIELDS.has(field),
  );
  if (unsupported.length > 0) return { cacheable: false, fields };
  return { cacheable: true, fields };
}

/**
 * Cuanto tiempo se puede reutilizar la respuesta, o 0 si no se puede reutilizar.
 *
 * `no-cache` se trata como `no-store` a proposito: `no-cache` permite guardar
 * pero obliga a revalidar antes de reutilizar, y esta cache no tiene camino de
 * revalidacion (no emite If-None-Match ni acepta un 304). Servirla fresco
 * durante su max-age seria exactamente lo que la cabecera prohibe.
 */
export function hotCacheMaxAgeMs(rawHeaders: [string, string][]): number {
  const cacheControl = rawHeaderValue(rawHeaders, "cache-control");
  if (cacheControl) {
    // se separa el nombre de la directiva de su valor porque hay dos que se
    // comparan por nombre y pueden llevar valor: no-cache y no-cache="Set-Cookie"
    // significan lo mismo para esta cache (obligan a revalidar).
    const directives = cacheControl
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .map((part) => ({
        name: part.split("=", 1)[0]!.trim(),
        value: part.split("=", 2)[1]?.replace(/^"|"$/g, ""),
      }));
    if (
      directives.some(
        (d) => d.name === "no-store" || d.name === "no-cache" || d.name === "private",
      )
    ) {
      return 0;
    }
    for (const directive of directives) {
      if (directive.name === "max-age" || directive.name === "s-maxage") {
        const seconds = Number.parseInt(directive.value ?? "", 10);
        if (Number.isFinite(seconds) && seconds > 0) {
          return Math.min(seconds * 1000, MAX_AGE_MS);
        }
      }
    }
    if (directives.some((d) => d.name === "immutable")) return MAX_AGE_MS;
  }

  const expires = rawHeaderValue(rawHeaders, "expires");
  if (expires) {
    const expiresAt = Date.parse(expires);
    if (Number.isFinite(expiresAt)) {
      return Math.max(0, Math.min(expiresAt - Date.now(), MAX_AGE_MS));
    }
  }

  return 0;
}

/** sufijo de variante de la clave, derivado de la peticion */
export function hotCacheVariant(requestHeaders: Headers): string {
  let variant = "";
  for (const name of VARIANT_FIELDS) {
    variant += `\n${name}=${requestHeaders.get(name) ?? ""}`;
  }
  return variant;
}

/** clave de una entrada: metodo, url y variante */
export function hotAssetKey(
  method: string,
  target: URL,
  variant: string,
): string {
  return `${method}\n${target.href}${variant}`;
}
