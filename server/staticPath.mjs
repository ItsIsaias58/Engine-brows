// unica implementacion de "resolver una ruta de peticion contra una raiz en
// disco sin salir de esa raiz". la usan dos procesos distintos (el server de
// lyra y el del mercado) y antes cada uno tenia su copia: un fix de traversal
// aplicado en uno no llegaba al otro, que es exactamente como se cuela un
// bypass de "..".
import path from "node:path";

/**
 * Resuelve `relativePath` bajo `root` o devuelve null si se sale de `root`.
 * Rechaza: percent-encoding invalido, bytes nul, segmentos "..", backslashes
 * (en POSIX un ".." con barra invertida no es un segmento valido pero en
 * Windows si lo seria) y el caso de `rel` vacio, que resuelve justo al root.
 *
 * @param {string} root
 * @param {string} relativePath
 * @returns {string | null}
 */
export function safeJoin(root, relativePath) {
  let rel = String(relativePath ?? "");
  try {
    rel = decodeURIComponent(rel);
  } catch {
    return null;
  }
  rel = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  if (rel.includes("\0") || rel.split("/").includes("..")) return null;

  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, rel);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    return null;
  }
  return resolved;
}
