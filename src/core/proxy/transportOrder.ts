// Qué transporte intentar y en qué orden.
//
// La app deja elegir entre epoxy y libcurl, pero en algunos entornos uno de los
// dos no levanta (el caso reportado: epoxy no carga ninguna página y libcurl
// funciona). Antes, si el elegido fallaba, la app reintentaba EL MISMO en bucle
// hasta rendirse, dejando la pantalla sin cargar nada. El orden de intentos pone
// primero la elección del usuario y detrás el resto, para que un transporte roto
// no deje la app muerta.

export const TRANSPORT_CANDIDATES = ["epoxy", "libcurl"] as const;
export type ProxyTransportName = (typeof TRANSPORT_CANDIDATES)[number];

export function isProxyTransportName(value: unknown): value is ProxyTransportName {
  return (
    typeof value === "string" &&
    (TRANSPORT_CANDIDATES as readonly string[]).includes(value)
  );
}

// intenta primero `preferred` (si es un transporte conocido) y luego los demás.
// un valor desconocido no se pierde: simplemente cae al final tras los válidos,
// así un localStorage corrupto no impide conectar.
export function transportAttemptOrder(preferred: string): string[] {
  const known: string[] = [...TRANSPORT_CANDIDATES];
  const first = known.includes(preferred) ? [preferred] : [];
  return [...first, ...known.filter((name) => name !== preferred)];
}
