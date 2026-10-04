import { describe, expect, test } from "bun:test";
import {
  hotAssetKey,
  hotCacheMaxAgeMs,
  hotCacheVary,
  hotCacheVariant,
  rawHeaderValue,
} from "./hotCache.ts";

/** atajo: ["nombre: valor", ...] -> [[nombre, valor], ...] */
function headers(...pairs: string[]): [string, string][] {
  return pairs.map((pair) => {
    const index = pair.indexOf(":");
    return [pair.slice(0, index), pair.slice(index + 1).trim()] as [string, string];
  });
}

describe("rawHeaderValue", () => {
  test("busca sin distinguir mayusculas", () => {
    expect(rawHeaderValue(headers("Cache-Control: max-age=60"), "cache-control")).toBe(
      "max-age=60",
    );
  });

  test("devuelve null si no esta", () => {
    expect(rawHeaderValue(headers("ETag: x"), "vary")).toBeNull();
  });
});

describe("hotCacheMaxAgeMs", () => {
  test("usa max-age", () => {
    expect(hotCacheMaxAgeMs(headers("Cache-Control: max-age=60"))).toBe(60_000);
  });

  test("usa s-maxage", () => {
    expect(hotCacheMaxAgeMs(headers("Cache-Control: s-maxage=30"))).toBe(30_000);
  });

  test("acota a 10 minutos un max-age enorme", () => {
    expect(hotCacheMaxAgeMs(headers("Cache-Control: max-age=86400"))).toBe(
      600_000,
    );
  });

  test("quita comillas del valor", () => {
    expect(hotCacheMaxAgeMs(headers('Cache-Control: max-age="120"'))).toBe(
      120_000,
    );
  });

  test("immutable sin max-age da el techo", () => {
    expect(hotCacheMaxAgeMs(headers("Cache-Control: immutable"))).toBe(600_000);
  });

  test("no-store da 0", () => {
    expect(hotCacheMaxAgeMs(headers("Cache-Control: no-store"))).toBe(0);
  });

  test("private da 0", () => {
    expect(hotCacheMaxAgeMs(headers("Cache-Control: private, max-age=60"))).toBe(
      0,
    );
  });

  // este es el bug: no-cache permite guardar pero obliga a revalidar, y esta
  // cache no revalida. servirla fresca durante su max-age incumple la cabecera.
  test("no-cache da 0 aunque venga con max-age", () => {
    expect(
      hotCacheMaxAgeMs(headers("Cache-Control: no-cache, max-age=60")),
    ).toBe(0);
  });

  test("no-cache con campo (no-cache=\"Set-Cookie\") tambien da 0", () => {
    expect(
      hotCacheMaxAgeMs(headers('Cache-Control: no-cache="Set-Cookie", max-age=60')),
    ).toBe(0);
  });

  test("cae a Expires cuando no hay Cache-Control", () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    const ms = hotCacheMaxAgeMs(headers(`Expires: ${future}`));
    expect(ms).toBeGreaterThan(55_000);
    expect(ms).toBeLessThanOrEqual(60_000);
  });

  test("un Expires en pasado da 0", () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(hotCacheMaxAgeMs(headers(`Expires: ${past}`))).toBe(0);
  });

  test("sin directivas utilizables da 0", () => {
    expect(hotCacheMaxAgeMs(headers("Cache-Control: max-age=abc"))).toBe(0);
    expect(hotCacheMaxAgeMs(headers("Content-Type: image/png"))).toBe(0);
  });
});

describe("hotCacheVary", () => {
  test("sin Vary es cacheable sin campos", () => {
    expect(hotCacheVary(headers("Cache-Control: max-age=60"))).toEqual({
      cacheable: true,
      fields: [],
    });
  });

  test("Vary: Accept-Encoding es cacheable (lo lleva la clave)", () => {
    expect(
      hotCacheVary(
        headers("Vary: Accept-Encoding", "Cache-Control: max-age=60"),
      ),
    ).toEqual({ cacheable: true, fields: ["accept-encoding"] });
  });

  test("normaliza, quita repetidos y comas sobrantes", () => {
    expect(
      hotCacheVary(headers("Vary: accept-encoding, Accept-Language ,Accept-Encoding")),
    ).toEqual({ cacheable: true, fields: ["accept-encoding", "accept-language"] });
  });

  // los campos que mochi borra antes de pedir el asset al upstream no pueden
  // hacer variar la respuesta: upstream nunca los ve. Antes esta cache los
  // rechazaba y por eso no guardaba NADA de crazygames ni de jsdelivr, que los
  // declaran en casi todas sus respuestas.
  test("Vary sobre campos que mochi no reenvia al upstream es cacheable", () => {
    expect(
      hotCacheVary(headers("Vary: Cookie", "Cache-Control: max-age=60")),
    ).toEqual({ cacheable: true, fields: ["cookie"] });
    expect(
      hotCacheVary(headers("Vary: Origin, Accept-Encoding")),
    ).toEqual({ cacheable: true, fields: ["origin", "accept-encoding"] });
  });

  // crazygames: cloudflare + cloudfront, dos cabeceras vary
  test("los Vary que mandan los CDN de juegos son cacheables", () => {
    expect(
      hotCacheVary([
        ["vary", "Origin"],
        ["vary", "accept-encoding"],
        ["cache-control", "public,max-age=31536000,immutable,no-transform"],
      ]),
    ).toEqual({ cacheable: true, fields: ["origin", "accept-encoding"] });
  });

  // jsdelivr manda tres cabeceras vary: quedarse con la primera dejaria pasar
  // un Vary: User-Agent escondido detras de un Vary: Accept-Encoding inocuo
  test("se miran TODAS las cabeceras vary, no solo la primera", () => {
    expect(
      hotCacheVary([
        ["vary", "Accept-Encoding"],
        ["vary", "accept-encoding"],
        [
          "vary",
          "origin, access-control-request-method, access-control-request-headers",
        ],
      ]),
    ).toEqual({
      cacheable: true,
      fields: [
        "accept-encoding",
        "origin",
        "access-control-request-method",
        "access-control-request-headers",
      ],
    });
    expect(
      hotCacheVary([
        ["vary", "Accept-Encoding"],
        ["vary", "User-Agent"],
      ]),
    ).toEqual({ cacheable: false, fields: ["accept-encoding", "user-agent"] });
  });

  test("Vary con un campo desconocido NO es cacheable", () => {
    expect(
      hotCacheVary(headers("Vary: User-Agent", "Cache-Control: max-age=60")),
    ).toEqual({ cacheable: false, fields: ["user-agent"] });
  });

  test("Vary: * no es cacheable", () => {
    expect(hotCacheVary(headers("Vary: *"))).toEqual({
      cacheable: false,
      fields: ["*"],
    });
  });
});

describe("hotAssetKey", () => {
  const url = new URL("https://cdn.example.com/img.png");

  test("distingue metodos", () => {
    expect(hotAssetKey("GET", url, "")).not.toBe(hotAssetKey("HEAD", url, ""));
  });

  test("distingue urls", () => {
    const other = new URL("https://cdn.example.com/other.png");
    expect(hotAssetKey("GET", url, "")).not.toBe(hotAssetKey("GET", other, ""));
  });

  test("distingue variantes", () => {
    const br = hotAssetKey("GET", url, "\naccept-encoding=br");
    const gzip = hotAssetKey("GET", url, "\naccept-encoding=gzip");
    expect(br).not.toBe(gzip);
  });
});

describe("hotCacheVariant", () => {
  test("incluye accept-encoding y accept-language", () => {
    const headers = new Headers({
      "accept-encoding": "gzip, deflate, br",
      "accept-language": "es-ES",
    });
    const variant = hotCacheVariant(headers);
    expect(variant).toContain("accept-encoding=gzip, deflate, br");
    expect(variant).toContain("accept-language=es-ES");
  });

  test("una peticion sin esas cabeceras sigue produciendo variante estable", () => {
    expect(hotCacheVariant(new Headers())).toBe(
      hotCacheVariant(new Headers()),
    );
  });

  test("cabeceras ausentes y vacias dan la misma variante", () => {
    expect(hotCacheVariant(new Headers())).toBe(
      hotCacheVariant(new Headers({ "accept-encoding": "" })),
    );
  });

  // la clave se construye igual en el camino de peticion y en el de guardado:
  // si divergieran, la entrada guardada seria inalcanzable.
  test("la variante es estable entre peticiones equivalentes", () => {
    const a = new Headers({ "accept-encoding": "br" });
    const b = new Headers({ "accept-encoding": "br", "user-agent": "otro" });
    // user-agent no esta en VARIANT_FIELDS, asi que no debe affectar
    expect(hotCacheVariant(a)).toBe(hotCacheVariant(b));
  });
});
