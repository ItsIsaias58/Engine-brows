// client-side appearance customization for the lyra shell. everything lives on
// the player's machine: localStorage for the config, data URLs for uploaded
// wallpapers. the server never sees any of it.
//
//   accent     -> recolors the whole UI via --accent-color and derived tokens
//   wallpaper  -> url, uploaded image (data url) or a built-in gradient; drawn
//                 behind the home/catalog surfaces with adjustable dim+blur
//                 so text stays readable
//   display    -> how much chrome surrounds the wallpaper (subtle / normal /
//                 immersive); immersive also clears the home grid
//
// applied through one custom stylesheet (#wp-style) so a reset is a
// single textContent wipe, and everything survives reloads without FOUC (the
// entry script calls installCustomization() before first paint).

export const ACCENT_PRESETS = [
  { id: "default", name: "default", color: "#ffffff" },
  { id: "purple", name: "purple", color: "#8b5cf6" },
  { id: "violet", name: "violet", color: "#a855f7" },
  { id: "blue", name: "blue", color: "#3b82f6" },
  { id: "cyan", name: "cyan", color: "#22d3ee" },
  { id: "mint", name: "mint", color: "#34d399" },
  { id: "green", name: "green", color: "#4ade80" },
  { color: "#facc15", id: "gold", name: "gold" },
  { color: "#fb923c", id: "orange", name: "orange" },
  { color: "#f87171", id: "red", name: "red" },
  { color: "#f472b6", id: "pink", name: "pink" },
  { color: "#94a3b8", id: "gray", name: "gray" },
] as const;

export const WALLPAPER_GRADIENTS = [
  {
    id: "none",
    name: "none",
    css: "",
  },
  {
    id: "aurora",
    name: "aurora",
    css: "radial-gradient(1200px 700px at 20% -10%, rgba(139,92,246,.35), transparent 60%), radial-gradient(1000px 600px at 85% 15%, rgba(59,130,246,.28), transparent 60%), radial-gradient(900px 700px at 50% 110%, rgba(34,211,238,.22), transparent 60%)",
  },
  {
    id: "sunset",
    name: "sunset",
    css: "linear-gradient(160deg, rgba(251,146,60,.28) 0%, rgba(248,113,113,.20) 35%, rgba(139,92,246,.25) 100%)",
  },
  {
    id: "deep-ocean",
    name: "deep ocean",
    css: "linear-gradient(180deg, rgba(34,211,238,.16) 0%, rgba(59,130,246,.22) 45%, rgba(2,6,23,.6) 100%)",
  },
  {
    id: "nebula",
    name: "nebula",
    css: "radial-gradient(900px 600px at 75% 20%, rgba(244,114,182,.30), transparent 55%), radial-gradient(1100px 800px at 15% 80%, rgba(139,92,246,.30), transparent 60%)",
  },
  {
    id: "forest",
    name: "forest",
    css: "radial-gradient(1000px 700px at 25% 10%, rgba(52,211,153,.22), transparent 60%), radial-gradient(900px 600px at 80% 90%, rgba(20,83,45,.35), transparent 65%)",
  },
  {
    id: "carbon",
    name: "carbon",
    css: "radial-gradient(1200px 800px at 50% -20%, rgba(148,163,184,.18), transparent 60%)",
  },
] as const;

export type WallpaperSource = "none" | "url" | "upload" | "gradient";

export interface CustomizationConfig {
  accent: string; // 'default' or a preset id or 'custom'
  accentCustom: string; // hex when accent === 'custom'
  wallpaperSource: WallpaperSource;
  wallpaperUrl: string; // url mode
  wallpaperData: string; // upload mode (data url)
  wallpaperGradient: string; // gradient id
  wallpaperDim: number; // 0..0.85 darkness over the wallpaper
  wallpaperBlur: number; // 0..20 px
  display: "subtle" | "normal" | "immersive";
}

export const DEFAULT_CUSTOMIZATION: CustomizationConfig = {
  accent: "default",
  accentCustom: "#8b5cf6",
  wallpaperSource: "none",
  wallpaperUrl: "",
  wallpaperData: "",
  wallpaperGradient: "aurora",
  wallpaperDim: 0.45,
  wallpaperBlur: 0,
  display: "normal",
};

const STORAGE_KEY = "wp-customization-v1";
const STYLE_ID = "wp-style";
export const WALLPAPER_UPLOAD_MAX_BYTES = 2_500_000; // ~2.5MB data-url budget

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function safeGet(): Partial<CustomizationConfig> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Partial<CustomizationConfig>)
      : {};
  } catch {
    return {};
  }
}

export function loadCustomization(): CustomizationConfig {
  const stored = safeGet();
  const config: CustomizationConfig = {
    ...DEFAULT_CUSTOMIZATION,
    ...stored,
  };
  config.wallpaperDim = clamp(
    Number(config.wallpaperDim) || 0,
    0,
    0.85,
  );
  config.wallpaperBlur = clamp(Number(config.wallpaperBlur) || 0, 0, 20);
  if (config.wallpaperData && config.wallpaperData.length > WALLPAPER_UPLOAD_MAX_BYTES) {
    config.wallpaperData = ""; // too big to be useful: drop it
  }
  if (config.accent !== "custom") {
    const preset = ACCENT_PRESETS.find((p) => p.id === config.accent);
    if (!preset) config.accent = "default";
  }
  if (!WALLPAPER_GRADIENTS.some((g) => g.id === config.wallpaperGradient)) {
    config.wallpaperGradient = DEFAULT_CUSTOMIZATION.wallpaperGradient;
  }
  return config;
}

export function saveCustomization(config: CustomizationConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // quota exceeded (usually a huge wallpaper): drop the image and retry
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ ...config, wallpaperData: "" }),
      );
    } catch {
      /* nothing else to trade away */
    }
  }
}

export function resetCustomization(): CustomizationConfig {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
  return { ...DEFAULT_CUSTOMIZATION };
}

function hexToRgb(hex: string): [number, number, number] | null {
  const value = hex.replace("#", "").trim();
  const full =
    value.length === 3
      ? value
          .split("")
          .map((c) => c + c)
          .join("")
      : value;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function rgba([r, g, b]: [number, number, number], alpha: number): string {
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// every inline token applyAccent can set; used to undo a custom accent.
const ACCENT_TOKENS = [
  "--accent-color",
  "--selection-bg",
  "--hover-bg",
  "--hover-bg-light",
  "--hover-bg-faint",
  "--active-bg",
  "--active-bg-subtle",
  "--btn-primary-bg",
  "--btn-primary-bg-hover",
  "--btn-primary-text",
  "--btn-save-bg",
  "--btn-save-bg-hover",
  "--btn-save-text",
  "--checkbox-bg-checked",
  "--checkbox-knob",
  "--input-focus-search",
  "--search-glow-border",
  "--search-glow-bg",
  "--border-focus",
  "--split-focus-border",
  "--split-indicator",
  "--color-link",
  "--color-link-hover",
  "--color-tab-active",
  "--color-icon",
] as const;

// the accent recolor. "default" keeps the theme untouched; anything else maps
// the user color onto --accent-color plus the derived tokens the UI already
// reads (focus rings, toggles, highlights). with the stock near-white accent
// the derived colors are darkened so buttons/toggles stay readable.
export function applyAccent(config: CustomizationConfig): void {
  const root = document.documentElement;
  if (config.accent === "default") {
    root.removeAttribute("data-accent");
    // strip every inline token so the theme's own values shine again
    for (const token of ACCENT_TOKENS) root.style.removeProperty(token);
    return;
  }
  const hex =
    config.accent === "custom"
      ? config.accentCustom
      : (ACCENT_PRESETS.find((p) => p.id === config.accent)?.color ?? "");
  const rgb = hexToRgb(hex);
  if (!rgb) {
    root.removeAttribute("data-accent");
    for (const token of ACCENT_TOKENS) root.style.removeProperty(token);
    return;
  }
  const [r, g, b] = rgb;
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  // readable "primary button" pair derived from the same color
  const btnBg =
    luminance > 0.6
      ? `rgb(${Math.round(r * 0.35)}, ${Math.round(g * 0.35)}, ${Math.round(b * 0.35)})`
      : hex;
  const btnText =
    luminance > 0.6 ? "#ffffff" : luminance > 0.18 ? "#0a0e15" : "#ffffff";
  const style = root.style;
  style.setProperty("--accent-color", hex);
  style.setProperty("--selection-bg", hex);
  style.setProperty("--hover-bg", rgba(rgb, 0.14));
  style.setProperty("--hover-bg-light", rgba(rgb, 0.1));
  style.setProperty("--hover-bg-faint", rgba(rgb, 0.06));
  style.setProperty("--active-bg", rgba(rgb, 0.2));
  style.setProperty("--active-bg-subtle", rgba(rgb, 0.06));
  style.setProperty("--btn-primary-bg", btnBg);
  style.setProperty("--btn-primary-bg-hover", hex);
  style.setProperty("--btn-primary-text", btnText);
  style.setProperty("--btn-save-bg", btnBg);
  style.setProperty("--btn-save-bg-hover", hex);
  style.setProperty("--btn-save-text", btnText);
  style.setProperty("--checkbox-bg-checked", hex);
  style.setProperty("--checkbox-knob", "#ffffff");
  style.setProperty("--input-focus-search", rgba(rgb, 0.5));
  style.setProperty("--search-glow-border", rgba(rgb, 0.8));
  style.setProperty("--search-glow-bg", rgba(rgb, 0.14));
  style.setProperty("--border-focus", hex);
  style.setProperty("--split-focus-border", hex);
  style.setProperty("--split-indicator", rgba(rgb, 0.9));
  style.setProperty("--color-link", hex);
  style.setProperty("--color-link-hover", hex);
  style.setProperty("--color-tab-active", hex);
  style.setProperty("--color-icon", rgba(rgb, 0.95));
  root.dataset.accent = config.accent === "custom" ? "custom" : config.accent;
}

// the image (or gradient css) the wallpaper layer should paint, or "" for none.
function wallpaperImageOf(config: CustomizationConfig): string {
  if (config.wallpaperSource === "url" && config.wallpaperUrl.trim()) {
    return `url("${config.wallpaperUrl.trim().replace(/"/g, "%22")}")`;
  }
  if (config.wallpaperSource === "upload" && config.wallpaperData) {
    return `url("${config.wallpaperData}")`;
  }
  if (config.wallpaperSource === "gradient") {
    const gradient = WALLPAPER_GRADIENTS.find(
      (g) => g.id === config.wallpaperGradient,
    );
    if (gradient?.css) return gradient.css;
  }
  return "";
}

// wallpaper + display mode -> one stylesheet. a layer sits behind the shell
// (z-index 0, under everything that matters) with the image/gradient, dimmed
// and blurred per config.
//
// the stock shell is fully opaque (body, .sidebar and the iframe pane all
// paint solid colors), so with a wallpaper active those surfaces turn
// translucent via body[data-wp-layer="on"] and the layer shows through.
// no wallpaper -> the flag is off and the shell is 100% stock.
function wallpaperCss(config: CustomizationConfig): string {
  const image = wallpaperImageOf(config);
  const dim = clamp(config.wallpaperDim, 0, 0.85);
  const blur = clamp(config.wallpaperBlur, 0, 20);
  const rules: string[] = [];

  if (image) {
    rules.push(`#wp-layer{display:block;background-image:${image}}`);
    // the shell-opening rules (translucent body/sidebar/iframe pane) live in
    // the static stylesheet under body[data-wp-layer="on"]; setting the
    // flag here is what turns them on.
  } else {
    rules.push("#wp-layer{display:none}");
  }
  rules.push(
    `#wp-layer::after{background:rgba(0,0,0,${dim.toFixed(3)})}`,
  );
  rules.push(
    `#wp-layer{filter:blur(${blur.toFixed(1)}px) saturate(1.05)}`,
  );
  // pull the layer behind everything, but keep the dim veil above the image
  rules.push(`#wp-layer{z-index:-1}`);

  if (config.display === "immersive") {
    rules.push(`
body[data-display="immersive"] .main-container{margin-top:16vh}
body[data-display="immersive"] .footer{opacity:.55}
body[data-display="immersive"][data-wp-layer="on"] #iframe-container .iframe{background-color:transparent}
`);
  }
  if (config.display === "subtle") {
    rules.push(`
body[data-display="subtle"] .sidebar{background-color:color-mix(in srgb, var(--bg-surface-0) 88%, transparent)}
`);
  }
  return rules.join("\n");
}

// install once at boot: creates the wallpaper layer and the style element, and
// applies whatever was saved. safe to call again (idempotent).
export function installCustomization(): CustomizationConfig {
  const config = loadCustomization();
  if (!document.getElementById("wp-layer")) {
    const layer = document.createElement("div");
    layer.id = "wp-layer";
    layer.setAttribute("aria-hidden", "true");
    document.body.prepend(layer);
  }
  document.body.dataset.display = config.display;
  document.body.dataset.wp =
    wallpaperImageOf(config) ? "on" : "off";
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = wallpaperCss(config);
  applyAccent(config);
  return config;
}

// live update (settings sliders): re-writes only the generated stylesheet and
// the two DOM flags. never touches the theme system.
export function applyCustomization(config: CustomizationConfig): void {
  saveCustomization(config);
  document.body.dataset.display = config.display;
  document.body.dataset.wp = wallpaperImageOf(config) ? "on" : "off";
  const style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (style) style.textContent = wallpaperCss(config);
  applyAccent(config);
}

export function wallpaperLayer(): HTMLElement | null {
  return document.getElementById("wp-layer");
}
