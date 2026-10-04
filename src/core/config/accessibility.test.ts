import { describe, expect, test } from "bun:test";
import {
  ACCESSIBILITY_STORAGE_KEY,
  DEFAULT_ACCESSIBILITY,
  applyAccessibility,
  loadAccessibility,
  parseAccessibility,
  resetAccessibility,
  saveAccessibility,
  type AccessibilityConfig,
} from "./accessibility.ts";

/** almacenamiento en memoria: los tests no tocan el localStorage real */
function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    get size() {
      return map.size;
    },
  };
}

describe("parseAccessibility", () => {
  test("sin nada guardado devuelve los valores por defecto", () => {
    expect(parseAccessibility(null)).toEqual(DEFAULT_ACCESSIBILITY);
  });

  test("lee los dos interruptores", () => {
    expect(
      parseAccessibility('{"reducedTransparency":true,"highContrast":true}'),
    ).toEqual({ reducedTransparency: true, highContrast: true });
  });

  test("acepta los strings que deja localStorage a mano", () => {
    expect(
      parseAccessibility('{"reducedTransparency":"true","highContrast":"false"}'),
    ).toEqual({ reducedTransparency: true, highContrast: false });
  });

  test("un campo que no es booleano no pisa el valor por defecto", () => {
    expect(
      parseAccessibility('{"reducedTransparency":"si","highContrast":true}'),
    ).toEqual({ reducedTransparency: false, highContrast: true });
  });

  test("json corrupto no deja la pagina a medias", () => {
    expect(parseAccessibility("{roto")).toEqual(DEFAULT_ACCESSIBILITY);
    expect(parseAccessibility("[]")).toEqual(DEFAULT_ACCESSIBILITY);
  });
});

describe("guardado", () => {
  test("round-trip por almacenamiento", () => {
    const storage = memoryStorage();
    const config: AccessibilityConfig = {
      reducedTransparency: true,
      highContrast: false,
    };

    saveAccessibility(config, storage);

    expect(storage.getItem(ACCESSIBILITY_STORAGE_KEY)).toBe(
      JSON.stringify(config),
    );
    expect(loadAccessibility(storage)).toEqual(config);
  });

  test("reset borra el guardado y devuelve los valores por defecto", () => {
    const storage = memoryStorage();
    saveAccessibility(
      { reducedTransparency: true, highContrast: true },
      storage,
    );

    const fresh = resetAccessibility(storage);

    expect(fresh).toEqual(DEFAULT_ACCESSIBILITY);
    expect(storage.size).toBe(0);
  });

  test("un almacenamiento que lanza no rompe el arranque", () => {
    const roto = {
      getItem: () => {
        throw new Error("sin storage");
      },
      setItem: () => {
        throw new Error("sin storage");
      },
      removeItem: () => {
        throw new Error("sin storage");
      },
    };

    expect(loadAccessibility(roto)).toEqual(DEFAULT_ACCESSIBILITY);
    expect(() =>
      saveAccessibility(DEFAULT_ACCESSIBILITY, roto),
    ).not.toThrow();
    expect(() => resetAccessibility(roto)).not.toThrow();
  });
});

describe("applyAccessibility", () => {
  function fakeRoot() {
    const data: Record<string, string> = {};
    return { data, root: { dataset: data } as unknown as HTMLElement };
  }

  test("los atributos\reflejan los interruptores", () => {
    const { data, root } = fakeRoot();

    applyAccessibility(
      { reducedTransparency: true, highContrast: true },
      root,
    );

    expect(data.transparency).toBe("reduced");
    expect(data.contrast).toBe("high");
  });

  test("al desactivar vuelve al estado normal, no al atributo ausente", () => {
    const { data, root } = fakeRoot();

    applyAccessibility(DEFAULT_ACCESSIBILITY, root);

    // los dos valores por defecto se escriben siempre: el CSS necesita que el
    // atributo exista para poder distinguir los dos casos
    expect(data.transparency).toBe("full");
    expect(data.contrast).toBe("normal");
  });
});
