// Ajustes de accesibilidad. Van aparte de customization.ts a proposito: el
// "reset customization" de la pestaña de apariencia no debe borrar las
// preferencias de quien necesita alto contraste para leer la pagina.

export const ACCESSIBILITY_STORAGE_KEY = "lyra-accessibility-v1";

export interface AccessibilityConfig {
  // los paneles translucidos (con blur de fondo) son el problema real: el
  // texto compite con lo que se mueve detras, pierde contraste y aparece halo.
  reducedTransparency: boolean;
  // los tokens --text-muted y --border-subtle se comen el fondo en temas
  // oscuros; con alto contraste se suben para que nada quede en gris sobre
  // gris.
  highContrast: boolean;
}

export const DEFAULT_ACCESSIBILITY: AccessibilityConfig = {
  reducedTransparency: false,
  highContrast: false,
};

type StorageReaderWriter = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function toBoolean(value: unknown, fallback: boolean): boolean {
  if (value === true || value === false) return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

export function parseAccessibility(raw: string | null): AccessibilityConfig {
  if (!raw) return { ...DEFAULT_ACCESSIBILITY };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return { ...DEFAULT_ACCESSIBILITY };
    }
    const stored = parsed as Partial<Record<keyof AccessibilityConfig, unknown>>;
    return {
      reducedTransparency: toBoolean(
        stored.reducedTransparency,
        DEFAULT_ACCESSIBILITY.reducedTransparency,
      ),
      highContrast: toBoolean(
        stored.highContrast,
        DEFAULT_ACCESSIBILITY.highContrast,
      ),
    };
  } catch {
    // guardado corrupto (o de otra version): se empieza de los valores por
    // defecto en vez de dejar la pagina a medias
    return { ...DEFAULT_ACCESSIBILITY };
  }
}

export function loadAccessibility(
  storage: StorageReaderWriter = localStorage,
): AccessibilityConfig {
  try {
    return parseAccessibility(storage.getItem(ACCESSIBILITY_STORAGE_KEY));
  } catch {
    return { ...DEFAULT_ACCESSIBILITY };
  }
}

export function saveAccessibility(
  config: AccessibilityConfig,
  storage: StorageReaderWriter = localStorage,
): void {
  try {
    storage.setItem(ACCESSIBILITY_STORAGE_KEY, JSON.stringify(config));
  } catch {
    // modo privado sin cuota: el ajuste sigue activo en esta pestana
  }
}

export function resetAccessibility(
  storage: StorageReaderWriter = localStorage,
): AccessibilityConfig {
  try {
    storage.removeItem(ACCESSIBILITY_STORAGE_KEY);
  } catch {
    /* nada que limpiar */
  }
  return { ...DEFAULT_ACCESSIBILITY };
}

// Los atributos van en <html>, no en <body>: el CSS los consulta para
// reescribir tokens, y las variables tienen que caer antes de que se pinten
// los paneles, que se montan en el body.
export function applyAccessibility(
  config: AccessibilityConfig,
  root: Pick<HTMLElement, "dataset"> = document.documentElement,
): void {
  root.dataset.transparency = config.reducedTransparency ? "reduced" : "full";
  root.dataset.contrast = config.highContrast ? "high" : "normal";
}
