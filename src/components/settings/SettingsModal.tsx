import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "preact/hooks";
import {
  IconSettingsSliderHor,
  IconColorPalette,
  IconPaintBrush,
  IconGhost,
  IconHeart,
  IconPuzzle,
  IconSushi,
  IconCrossMedium,
  IconChevronBottom,
  IconHammer2,
} from "../icons";
import type { IconProps } from "../icons/IconBase";
import { useManagedModal } from "../../core/ui/modal.ts";
import { toast } from "../../core/ui/toast.ts";
import { SEARCH_ENGINE_OPTIONS } from "../../core/config/config.ts";
import {
  ADVANCED_SETTING_KEYS,
  MOTION_OPTIONS,
  applyMotionPreference,
  readAdvancedToggle,
  readMotionPreference,
  type MotionPreference,
} from "../../core/config/advancedSettings.ts";
import { warmProxyRuntime } from "../../core/proxy/proxyRuntime.ts";
import { getRivet } from "../../core/proxy/rivetBridge.ts";
import { NEGATIVE } from "../../core/runtime/messages.ts";
import type { InstalledExtensionSummary } from "../../../packages/rivet/src/index";
import { HISTORY_STORAGE_KEY } from "../../core/browser/history.ts";
import "../../assets/styles/settings/settings-modal.css";
import {
  ANIME_QUALITY_KEY,
  ANIME_QUALITY_OPTIONS,
  ANIME_SETTING_KEYS,
  readAnimeQuality,
  readAnimeSetting,
  type AnimeQuality,
} from "../../core/media/animeSettings.ts";
import {
  DEFAULT_SETTINGS,
  GAME_SOURCE_OPTIONS,
  LINK_CLOAKING_OPTIONS,
  SITE_CLOAKING_OPTIONS,
  THEME_OPTIONS,
  TRANSPORT_OPTIONS,
  resolveTheme,
  resolveGameSource,
} from "../../core/config/settingsOptions.ts";
import {
  ACCENT_PRESETS,
  DEFAULT_CUSTOMIZATION,
  WALLPAPER_GRADIENTS,
  WALLPAPER_UPLOAD_MAX_BYTES,
  applyCustomization,
  loadCustomization,
  resetCustomization,
  type CustomizationConfig,
} from "../../core/config/customization.ts";
import {
  applyAccessibility,
  loadAccessibility,
  resetAccessibility,
  saveAccessibility,
  type AccessibilityConfig,
} from "../../core/config/accessibility.ts";

const iconMap: Record<
  string,
  (props: IconProps) => any
> = {
  IconSettingsSliderHor,
  IconColorPalette,
  IconPaintBrush,
  IconSushi,
  IconGhost,
  IconHammer2,
  IconPuzzle,
  IconHeart,
};

const SETTINGS_TABS: readonly {
  id: string;
  icon: string;
  label: string;
}[] = [
  { id: "preferences", icon: "IconSettingsSliderHor", label: "preferences" },
  { id: "appearance", icon: "IconPaintBrush", label: "appearance" },
  { id: "anime", icon: "IconSushi", label: "anime" },
  { id: "cloaking", icon: "IconGhost", label: "cloaking" },
  { id: "extensions", icon: "IconPuzzle", label: "extensions" },
  { id: "advanced", icon: "IconHammer2", label: "advanced" },
] as const;

interface SelectorProps {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (v: string) => void;
  isOpen: string | null;
  onOpen: (label: string) => void;
  onClose: () => void;
}

function Selector({
  label,
  value,
  options,
  onChange,
  isOpen,
  onOpen,
  onClose,
}: SelectorProps) {
  const open = isOpen === label;
  const ref = useRef<HTMLDivElement>(null);
  const availableOptions = useMemo(
    () => options.filter((o) => o !== value),
    [options, value],
  );

  useEffect(() => {
    if (!open) return;
    const handler = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", handler);
    return () => window.removeEventListener("pointerdown", handler);
  }, [open, onClose]);

  return (
    <div class={`settings-selector ${label}-selector`} ref={ref}>
      <div
        class={`settings-selector-selected ${label}-selected${
          open ? ` settings-selector-open ${label}-arrow-active` : ""
        }`}
        onClick={(e: MouseEvent) => {
          e.stopPropagation();
          if (open) {
            onClose();
          } else {
            onOpen(label);
          }
        }}
      >
        <span>{value}</span>
        <IconChevronBottom size={16} class="selector-chevron" />
      </div>
      <div
        class={`settings-selector-options ${label}-options${
          open ? ` settings-selector-show ${label}-show` : ""
        }`}
        aria-hidden={!open}
      >
        {availableOptions.map((opt) => (
          <div
            key={opt}
            onClick={(e: MouseEvent) => {
              e.stopPropagation();
              onChange(opt);
              onClose();
            }}
          >
            {opt}
          </div>
        ))}
      </div>
    </div>
  );
}

interface ToggleProps {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}

function Toggle({ id, checked, onChange }: ToggleProps) {
  const onToggle = (e: Event) => {
    const el = e.currentTarget as HTMLInputElement;
    const isChecked = el.checked;
    el.classList.remove("animate-on", "animate-off");
    requestAnimationFrame(() => {
      el.classList.add(isChecked ? "animate-on" : "animate-off");
    });
    onChange(isChecked);
  };

  return (
    <input type="checkbox" id={id} checked={checked} onChange={onToggle} />
  );
}

export default function SettingsModal({
  openOnMount = false,
}: {
  openOnMount?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(openOnMount);
  const [isClosing, setIsClosing] = useState(false);
  const [activeTab, setActiveTab] = useState("preferences");
  const [openSelector, setOpenSelector] = useState<string | null>(null);
  const [settingsQuery, setSettingsQuery] = useState("");
  const searching = settingsQuery.trim() !== "";
  const [visibleItems, setVisibleItems] = useState<number | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const themeTransitionVersion = useRef(0);

  const [transport, setTransport] = useState(
    () => localStorage.getItem("transport") || DEFAULT_SETTINGS.transport,
  );
  const [searchEngine, setSearchEngine] = useState(
    () => localStorage.getItem("searchEngine") || DEFAULT_SETTINGS.searchEngine,
  );
  const [gameSource, setGameSource] = useState<string>(
    () => resolveGameSource(localStorage.getItem("gameSource")),
  );
  const [theme, setTheme] = useState<string>(
    () => resolveTheme(localStorage.getItem("theme")),
  );
  const [siteCloaking, setSiteCloaking] = useState(() => {
    const storedValue =
      localStorage.getItem("siteCloaking") || DEFAULT_SETTINGS.siteCloaking;
    return storedValue === "default" ? DEFAULT_SETTINGS.siteCloaking : storedValue;
  });
  const [linkCloaking, setLinkCloaking] = useState(
    () => localStorage.getItem("linkCloaking") || DEFAULT_SETTINGS.linkCloaking,
  );
  const [preventClosing, setPreventClosing] = useState(
    () => localStorage.getItem("preventClosing") !== "false",
  );
  const [focusCloaking, setFocusCloaking] = useState(
    () => localStorage.getItem("focusCloaking") !== "false",
  );
  const [saveHistory, setSaveHistory] = useState(() =>
    readAdvancedToggle("saveHistory"),
  );
  const [preloadProxy, setPreloadProxy] = useState(() =>
    readAdvancedToggle("preloadProxy"),
  );
  const [motionPreference, setMotionPreference] = useState<MotionPreference>(
    () => readMotionPreference(),
  );
  // personalización de apariencia (acento + wallpaper): se carga una vez y se
  // aplica en vivo con applyCustomization() — nada de esto toca al tema
  const [custom, setCustom] = useState<CustomizationConfig>(
    () => loadCustomization(),
  );
  // accesibilidad (transparencia y contraste): vive aparte de la
  // personalizacion para que "reset customization" no la borre
  const [accessibility, setAccessibilityState] =
    useState<AccessibilityConfig>(() => loadAccessibility());
  const [autoPlayNextEpisode, setAutoPlayNextEpisode] = useState(() =>
    readAnimeSetting("autoPlayNextEpisode"),
  );
  const [autoSkipIntroOutro, setAutoSkipIntroOutro] = useState(() =>
    readAnimeSetting("autoSkipIntroOutro"),
  );
  const [animeQuality, setAnimeQuality] = useState<AnimeQuality>(() =>
    readAnimeQuality(),
  );
  const [versionInfo, setVersionInfo] = useState("");
  const [extensions, setExtensions] = useState<InstalledExtensionSummary[]>([]);
  const [extensionBusy, setExtensionBusy] = useState(false);
  const closeSelector = useCallback(() => setOpenSelector(null), []);

  useEffect(() => {
    const appWindow = window as Record<string, any>;
    if (!appWindow.__lyraStuffData) {
      appWindow.__lyraStuffData = fetch("/api/stuff", { cache: "no-store" })
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null);
    }
    appWindow.__lyraStuffData.then((serviceMetadata: any) => {
      if (serviceMetadata && typeof serviceMetadata.version === "string") {
        const build =
          typeof serviceMetadata.build === "string" ? `~${serviceMetadata.build}` : "";
        setVersionInfo(`v${serviceMetadata.version}${build}`);
      }
    });
  }, []);

  const finishClose = useCallback(() => {
    setIsOpen(false);
    setIsClosing(false);
  }, []);

  const requestClose = useCallback(() => {
    if (!isOpen || isClosing) return;
    setIsClosing(true);
  }, [isOpen, isClosing]);

  useEffect(() => {
    if (!isOpen || activeTab !== "extensions") return;
    warmProxyRuntime();
    let unsubscribe: (() => void) | undefined;
    const refresh = () => {
      const rivet = getRivet();
      if (!rivet) return;
      setExtensions(rivet.getInstalledExtensions());
      unsubscribe ??= rivet.onChange(refresh);
    };
    refresh();
    window.addEventListener("rivet-ready", refresh);
    return () => {
      window.removeEventListener("rivet-ready", refresh);
      unsubscribe?.();
    };
  }, [isOpen, activeTab]);

  const installExtensionFile = async (file: File) => {
    const rivet = getRivet();
    if (!rivet) {
      toast.error("rivet is still connecting");
      return;
    }
    setExtensionBusy(true);
    try {
      await rivet.installExtension(await file.arrayBuffer(), file.name);
      toast.success("extension installed");
      setExtensions(rivet.getInstalledExtensions());
    } catch (error) {
      console.error("extension install failed:", error, NEGATIVE);
      toast.error("extension install failed");
    } finally {
      setExtensionBusy(false);
    }
  };

  const { modalStateClass, onAnimationEnd } = useManagedModal({
    visible: isOpen,
    isClosing,
    onRequestClose: requestClose,
    onCloseComplete: finishClose,
  });

  const toggleSettingsModal = useCallback(() => {
    if (isOpen) {
      requestClose();
    } else {
      setIsClosing(false);
      setIsOpen(true);
    }
  }, [isOpen, requestClose]);

  useEffect(() => {
    window.toggleSettingsModal = toggleSettingsModal;
    return () => {
      delete window.toggleSettingsModal;
    };
  }, [toggleSettingsModal]);

  useEffect(() => {
    const icon = document.querySelector("#settings .settings");
    if (icon) {
      icon.classList.toggle("active-icon", isOpen && !isClosing);
    }
  }, [isOpen, isClosing]);

  const save = (key: string, value: string) => {
    localStorage.setItem(key, value);
    toast.success("settings saved");
  };

  const handleSetting = (
    key: string,
    value: string,
    setter: (v: string) => void,
  ) => {
    setter(value);
    save(key, value);

    if (key === "theme") {
      const applyTheme = () => {
        if (value === "default")
          document.documentElement.removeAttribute("data-theme");
        else document.documentElement.setAttribute("data-theme", value);
      };

      if (!document.startViewTransition) {
        applyTheme();
      } else {
        const transitionVersion = ++themeTransitionVersion.current;
        document.documentElement.classList.add("theme-transitioning");
        const transition = document.startViewTransition(() => {
          applyTheme();
        });
        const cleanup = () => {
          if (themeTransitionVersion.current === transitionVersion) {
            document.documentElement.classList.remove("theme-transitioning");
          }
        };
        transition.finished.then(cleanup, cleanup);
      }
    } else if (key === "gameSource") {
      document.dispatchEvent(
        new CustomEvent("gameSourceUpdated", { detail: value }),
      );
    } else if (key === "transport") {
      document.dispatchEvent(
        new CustomEvent("newTransport", { detail: value }),
      );
    } else if (key === "siteCloaking") {
      document.dispatchEvent(
        new CustomEvent("siteCloakingUpdated", { detail: value }),
      );
    } else if (key === "linkCloaking") {
      const siteCloakName =
        localStorage.getItem("siteCloaking") || DEFAULT_SETTINGS.siteCloaking;
      document.dispatchEvent(
        new CustomEvent("linkCloakingUpdated", {
          detail: { linkCloaking: value, siteCloaking: siteCloakName },
        }),
      );
    } else if (key === ANIME_QUALITY_KEY) {
      document.dispatchEvent(
        new CustomEvent("animeSettingUpdated", {
          detail: { key, value },
        }),
      );
    } else if (key === ADVANCED_SETTING_KEYS.motion) {
      applyMotionPreference(value as MotionPreference);
      document.dispatchEvent(new CustomEvent("motionPreferenceUpdated"));
    }
  };

  const handleToggle = (
    key: string,
    value: boolean,
    setter: (v: boolean) => void,
  ) => {
    setter(value);
    save(key, String(value));

    if (key === "focusCloaking") {
      document.dispatchEvent(
        new CustomEvent("focusCloakingUpdated", { detail: value }),
      );
    } else if (
      key === ANIME_SETTING_KEYS.autoPlayNextEpisode ||
      key === ANIME_SETTING_KEYS.autoSkipIntroOutro
    ) {
      document.dispatchEvent(
        new CustomEvent("animeSettingUpdated", {
          detail: { key, value },
        }),
      );
    } else if (key === ADVANCED_SETTING_KEYS.saveHistory && !value) {
      localStorage.removeItem(HISTORY_STORAGE_KEY);
    } else if (key === ADVANCED_SETTING_KEYS.preloadProxy && value) {
      warmProxyRuntime();
    }
  };

  // accesibilidad: un solo manejador para los dos interruptores, que guardan y
  // re-aplican (los atributos van en <html>, no en estado de Preact)
  const setAccessibility = useCallback((next: AccessibilityConfig) => {
    setAccessibilityState(next);
    saveAccessibility(next);
    applyAccessibility(next);
  }, []);

  // Filtro del buscador. Se recorre el DOM ya pintado en vez de marcar cada
  // ajuste a mano: asi el buscador cubre tambien lo que se anada en el futuro
  // sin que nadie se acuerde de mantener una lista de nombres aparte.
  // Mientras hay texto se montan TODOS los paneles (ver `searching`), que si no
  // searching "contraste" desde preferences responderia "nada aqui" con el
  // ajuste a la vista en la pestaña de al lado.
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    const term = settingsQuery.trim().toLowerCase();
    const panels = root.querySelectorAll<HTMLElement>(".tab-content");
    let totalShown = 0;
    let firstMatch: string | null = null;
    panels.forEach((panel) => {
      let shown = 0;
      panel.querySelectorAll<HTMLElement>(".settings-item").forEach((item) => {
        const haystack = `${item.dataset.search ?? ""} ${item.textContent ?? ""}`;
        const matches = !term || haystack.toLowerCase().includes(term);
        item.classList.toggle("settings-item-hidden", !matches);
        if (matches) shown += 1;
      });
      panel.classList.toggle("tab-content-empty", term !== "" && shown === 0);
      totalShown += shown;
      if (term && shown > 0 && !firstMatch) firstMatch = panel.dataset.tab ?? null;
    });
    if (term && firstMatch && firstMatch !== activeTab) setActiveTab(firstMatch);
    setVisibleItems(term ? totalShown : null);
  }, [settingsQuery, activeTab, isOpen]);

  const onTabKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
      if (!keys.includes(event.key)) return;
      const index = SETTINGS_TABS.findIndex((tab) => tab.id === activeTab);
      if (index < 0) return;
      event.preventDefault();
      const last = SETTINGS_TABS.length - 1;
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? last
            : event.key === "ArrowDown"
              ? Math.min(last, index + 1)
              : Math.max(0, index - 1);
      const target = event.currentTarget as HTMLElement;
      const buttons = target.querySelectorAll<HTMLButtonElement>(".tab-button");
      const nextTab = SETTINGS_TABS[next];
      if (!nextTab) return;
      setActiveTab(nextTab.id);
      buttons[next]?.focus();
    },
    [activeTab],
  );

  if (!isOpen) return null;

  const modalClass = `settings-modal ${modalStateClass}${isClosing ? " close" : ""}${!isClosing ? " open" : ""}`;

  return (
    <div
      id="settings-modal"
      class={modalClass}
      ref={modalRef}
      onAnimationEnd={onAnimationEnd}
    >
      <h2>settings</h2>
      <div class="settings-container">
        <div
          class="settings-tabs"
          role="tablist"
          aria-orientation="vertical"
          onKeyDown={onTabKeyDown}
        >
          {SETTINGS_TABS.map((t) => (
            <button
              key={t.id}
              class={`tab-button${activeTab === t.id ? " active" : ""}`}
              role="tab"
              aria-selected={activeTab === t.id}
              // roving tabindex: el grupo de pestañas es un solo punto de tab
              // y las flechas se mueven dentro, como manda el patron
              tabIndex={activeTab === t.id ? 0 : -1}
              onClick={() => setActiveTab(t.id)}
            >
              {(() => {
                const IconComp = iconMap[t.icon];
                if (!IconComp) return null;
                return <IconComp />;
              })()}{" "}
              {t.label}
            </button>
          ))}
          <div class="settings-bottom">{versionInfo || "≽^•⩊•^≼"}</div>
        </div>
        <div
          class="settings-content-wrapper"
          ref={contentRef}
          data-searching={searching ? "true" : undefined}
        >
          <div class="settings-search-row">
            <input
              class="settings-search"
              type="search"
              value={settingsQuery}
              placeholder="search settings"
              aria-label="search settings"
              spellcheck={false}
              onInput={(e) =>
                setSettingsQuery((e.currentTarget as HTMLInputElement).value)
              }
            />
            {visibleItems !== null && (
              <span class="settings-search-count mono">
                {visibleItems === 0
                  ? "no settings match"
                  : `${visibleItems} shown`}
              </span>
            )}
          </div>
          {(searching || activeTab === "preferences") && (
          <div
            class={`tab-content${searching || activeTab === "preferences" ? " active" : ""}`}
            data-tab="preferences"
            role="tabpanel"
            aria-label="preferences"
          >
            <div class="settings-item">
              <label>search engine</label>
              <p>the engine that is used for your search queries.</p>
              <Selector
                label="search-engine"
                value={searchEngine}
                options={SEARCH_ENGINE_OPTIONS}
                isOpen={openSelector}
                onOpen={setOpenSelector}
                onClose={closeSelector}
                onChange={(v) =>
                  handleSetting("searchEngine", v, setSearchEngine)
                }
              />
            </div>
            <div class="settings-item">
              <label>game source</label>
              <p>where all the games are fetched from.</p>
              <Selector
                label="game-source"
                value={gameSource}
                options={GAME_SOURCE_OPTIONS}
                isOpen={openSelector}
                onOpen={setOpenSelector}
                onClose={closeSelector}
                onChange={(v) => handleSetting("gameSource", v, setGameSource)}
              />
            </div>
            <div class="settings-item">
              <label>prevent closing</label>
              <p>prevent the tab from being closed.</p>
              <Toggle
                id="prevent-closing-toggle"
                checked={preventClosing}
                onChange={(v) =>
                  handleToggle("preventClosing", v, setPreventClosing)
                }
              />
            </div>
          </div>
          )}

          {(searching || activeTab === "anime") && (
          <div
            class={`tab-content${searching || activeTab === "anime" ? " active" : ""}`}
            data-tab="anime"
            role="tabpanel"
            aria-label="anime"
          >
            <div class="settings-item">
              <label>preferred quality</label>
              <p>choose the quality used when an anime starts.</p>
              <Selector
                label="anime-quality"
                value={animeQuality}
                options={ANIME_QUALITY_OPTIONS}
                isOpen={openSelector}
                onOpen={setOpenSelector}
                onClose={closeSelector}
                onChange={(value) =>
                  handleSetting(
                    ANIME_QUALITY_KEY,
                    value,
                    (next) => setAnimeQuality(next as AnimeQuality),
                  )
                }
              />
            </div>
            <div class="settings-item">
              <label>auto play next episode</label>
              <p>
                automatically start the next episode.
              </p>
              <Toggle
                id="anime-auto-play-next-episode-toggle"
                checked={autoPlayNextEpisode}
                onChange={(value) =>
                  handleToggle(
                    ANIME_SETTING_KEYS.autoPlayNextEpisode,
                    value,
                    setAutoPlayNextEpisode,
                  )
                }
              />
            </div>
            <div class="settings-item">
              <label>auto skip intro and outro</label>
              <p>
                auto skip intro and outro when
                available.
              </p>
              <Toggle
                id="anime-auto-skip-intro-outro-toggle"
                checked={autoSkipIntroOutro}
                onChange={(value) =>
                  handleToggle(
                    ANIME_SETTING_KEYS.autoSkipIntroOutro,
                    value,
                    setAutoSkipIntroOutro,
                  )
                }
              />
            </div>
          </div>
          )}

          {(searching || activeTab === "appearance") && (
          <div
            class={`tab-content${searching || activeTab === "appearance" ? " active" : ""}`}
            data-tab="appearance"
            role="tabpanel"
            aria-label="appearance"
          >
            <div class="settings-item">
              <label>theme</label>
              <p>change the look and feel of lyra.</p>
              <Selector
                label="theme"
                value={theme}
                options={THEME_OPTIONS}
                isOpen={openSelector}
                onOpen={setOpenSelector}
                onClose={closeSelector}
                onChange={(v) => handleSetting("theme", v, setTheme)}
              />
            </div>

            <div class="settings-item customization-block">
              <label>accent color</label>
              <p>recolor buttons, toggles and highlights across the site.</p>
              <div class="accent-grid" role="radiogroup" aria-label="accent color">
                {ACCENT_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    role="radio"
                    aria-checked={custom.accent === preset.id}
                    class={`accent-swatch${custom.accent === preset.id ? " is-active" : ""}`}
                    style={`background:${preset.color}`}
                    title={preset.name}
                    onClick={() => {
                      const next = { ...custom, accent: preset.id };
                      setCustom(next);
                      applyCustomization(next);
                      toast.success("settings saved");
                    }}
                  />
                ))}
                <label
                  class={`accent-swatch accent-custom${custom.accent === "custom" ? " is-active" : ""}`}
                  title="custom color"
                  style={`background: conic-gradient(#f87171, #facc15, #4ade80, #22d3ee, #3b82f6, #a855f7, #f87171)`}
                >
                  <input
                    type="color"
                    value={custom.accentCustom}
                    aria-label="custom accent color"
                    onInput={(e) => {
                      const value = (e.currentTarget as HTMLInputElement).value;
                      const next = { ...custom, accent: "custom", accentCustom: value };
                      setCustom(next);
                      applyCustomization(next);
                    }}
                  />
                </label>
              </div>
            </div>

            <div class="settings-item customization-block">
              <label>wallpaper</label>
              <p>a background of your own: upload an image, paste a url, or use a gradient.</p>
              <div class="wallpaper-modes" role="radiogroup" aria-label="wallpaper source">
                {([
                  ["none", "none"],
                  ["gradient", "gradient"],
                  ["url", "url"],
                  ["upload", "upload"],
                ] as const).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={custom.wallpaperSource === id}
                    class={`wallpaper-mode${custom.wallpaperSource === id ? " is-active" : ""}`}
                    onClick={() => {
                      const next = { ...custom, wallpaperSource: id };
                      setCustom(next);
                      applyCustomization(next);
                      toast.success("settings saved");
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {custom.wallpaperSource === "gradient" && (
                <div class="wallpaper-gradients">
                  {WALLPAPER_GRADIENTS.filter((g) => g.css).map((g) => (
                    <button
                      key={g.id}
                      type="button"
                      class={`wallpaper-thumb${custom.wallpaperGradient === g.id ? " is-active" : ""}`}
                      style={`background:${g.css}, #0b0b0b`}
                      title={g.name}
                      aria-label={`gradient ${g.name}`}
                      onClick={() => {
                        const next = { ...custom, wallpaperGradient: g.id };
                        setCustom(next);
                        applyCustomization(next);
                      }}
                    />
                  ))}
                </div>
              )}

              {custom.wallpaperSource === "url" && (
                <input
                  class="wallpaper-url-input"
                  type="url"
                  placeholder="https://example.com/image.jpg"
                  value={custom.wallpaperUrl}
                  spellcheck={false}
                  onInput={(e) => {
                    const next = { ...custom, wallpaperUrl: (e.currentTarget as HTMLInputElement).value };
                    setCustom(next);
                    applyCustomization(next);
                  }}
                />
              )}

              {custom.wallpaperSource === "upload" && (
                <div class="wallpaper-upload">
                  <label class="wallpaper-upload-btn">
                    {custom.wallpaperData ? "replace image" : "choose image"}
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(e) => {
                        const input = e.currentTarget as HTMLInputElement;
                        const file = input.files?.[0];
                        input.value = "";
                        if (!file) return;
                        if (file.size > WALLPAPER_UPLOAD_MAX_BYTES / 1.37) {
                          // the data url inflates ~4/3 over the raw bytes
                          toast.error("image too large (max ~1.8 mb)");
                          return;
                        }
                        const reader = new FileReader();
                        reader.onload = () => {
                          const next = { ...custom, wallpaperData: String(reader.result || "") };
                          setCustom(next);
                          applyCustomization(next);
                          toast.success("settings saved");
                        };
                        reader.readAsDataURL(file);
                      }}
                    />
                  </label>
                  {custom.wallpaperData && (
                    <button
                      type="button"
                      class="wallpaper-clear-btn"
                      onClick={() => {
                        const next = { ...custom, wallpaperData: "" };
                        setCustom(next);
                        applyCustomization(next);
                      }}
                    >
                      remove
                    </button>
                  )}
                  {custom.wallpaperData && (
                    <img class="wallpaper-preview" src={custom.wallpaperData} alt="wallpaper preview" />
                  )}
                </div>
              )}

              {custom.wallpaperSource !== "none" && (
                <>
                  <div class="customization-slider">
                    <span>dim</span>
                    <input
                      type="range"
                      min="0"
                      max="85"
                      value={Math.round(custom.wallpaperDim * 100)}
                      onInput={(e) => {
                        const next = { ...custom, wallpaperDim: Number((e.currentTarget as HTMLInputElement).value) / 100 };
                        setCustom(next);
                        applyCustomization(next);
                      }}
                    />
                    <em class="mono">{Math.round(custom.wallpaperDim * 100)}%</em>
                  </div>
                  <div class="customization-slider">
                    <span>blur</span>
                    <input
                      type="range"
                      min="0"
                      max="20"
                      value={custom.wallpaperBlur}
                      onInput={(e) => {
                        const next = { ...custom, wallpaperBlur: Number((e.currentTarget as HTMLInputElement).value) };
                        setCustom(next);
                        applyCustomization(next);
                      }}
                    />
                    <em class="mono">{custom.wallpaperBlur}px</em>
                  </div>
                </>
              )}
            </div>

            <div class="settings-item customization-block">
              <label>display</label>
              <p>how much the wallpaper blends into the page.</p>
              <div class="wallpaper-modes" role="radiogroup" aria-label="display mode">
                {([
                  ["subtle", "subtle"],
                  ["normal", "normal"],
                  ["immersive", "immersive"],
                ] as const).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={custom.display === id}
                    class={`wallpaper-mode${custom.display === id ? " is-active" : ""}`}
                    onClick={() => {
                      const next = { ...custom, display: id };
                      setCustom(next);
                      applyCustomization(next);
                      toast.success("settings saved");
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div class="settings-item customization-block">
              <div class="customization-reset-row">
                <button
                  type="button"
                  class="customization-reset-btn"
                  onClick={() => {
                    const fresh = resetCustomization();
                    setCustom(fresh);
                    applyCustomization(fresh);
                    toast.success("customization reset");
                  }}
                >
                  reset customization
                </button>
              </div>
            </div>

            <div class="settings-item">
              <label>reduced transparency</label>
              <p>
                drop the blur behind the panels and make their backgrounds
                solid.
              </p>
              <Toggle
                id="reduced-transparency-toggle"
                checked={accessibility.reducedTransparency}
                onChange={(value) =>
                  setAccessibility({
                    ...accessibility,
                    reducedTransparency: value,
                  })
                }
              />
            </div>

            <div class="settings-item">
              <label>high contrast</label>
              <p>
                lift the dimmed text and the faint borders so nothing reads grey
                on grey.
              </p>
              <Toggle
                id="high-contrast-toggle"
                checked={accessibility.highContrast}
                onChange={(value) =>
                  setAccessibility({ ...accessibility, highContrast: value })
                }
              />
            </div>

            <div class="settings-item customization-block">
              <div class="customization-reset-row">
                <button
                  type="button"
                  class="customization-reset-btn"
                  onClick={() => {
                    setAccessibility(resetAccessibility());
                    toast.success("accessibility reset");
                  }}
                >
                  reset accessibility
                </button>
              </div>
            </div>

            <div class="settings-item">
              <label>motion effects</label>
              <p>
                follow the device setting, reduce motion, or allow full effects.
              </p>
              <Selector
                label="motion-preference"
                value={motionPreference}
                options={MOTION_OPTIONS}
                isOpen={openSelector}
                onOpen={setOpenSelector}
                onClose={closeSelector}
                onChange={(value) =>
                  handleSetting(
                    ADVANCED_SETTING_KEYS.motion,
                    value,
                    (next) => setMotionPreference(next as MotionPreference),
                  )
                }
              />
            </div>
          </div>
          )}

          {(searching || activeTab === "cloaking") && (
          <div
            class={`tab-content${searching || activeTab === "cloaking" ? " active" : ""}`}
            data-tab="cloaking"
            role="tabpanel"
            aria-label="cloaking"
          >
            <div class="settings-item">
              <label>site cloaking</label>
              <p>cloak the site title and favicon as a different site.</p>
              <Selector
                label="site-cloaking"
                value={siteCloaking}
                options={SITE_CLOAKING_OPTIONS}
                isOpen={openSelector}
                onOpen={setOpenSelector}
                onClose={closeSelector}
                onChange={(v) =>
                  handleSetting("siteCloaking", v, setSiteCloaking)
                }
              />
            </div>
            <div class="settings-item">
              <label>link cloaking</label>
              <p>cloak the site link in the url bar.</p>
              <Selector
                label="link-cloaking"
                value={linkCloaking}
                options={LINK_CLOAKING_OPTIONS}
                isOpen={openSelector}
                onOpen={setOpenSelector}
                onClose={closeSelector}
                onChange={(v) =>
                  handleSetting("linkCloaking", v, setLinkCloaking)
                }
              />
            </div>
            <div class="settings-item">
              <label>focus cloaking</label>
              <p>cloak the title and favicon when clicking off the tab.</p>
              <Toggle
                id="focus-cloaking-toggle"
                checked={focusCloaking}
                onChange={(v) =>
                  handleToggle("focusCloaking", v, setFocusCloaking)
                }
              />
            </div>
          </div>
          )}

          {(searching || activeTab === "advanced") && (
          <div
            class={`tab-content${searching || activeTab === "advanced" ? " active" : ""}`}
            data-tab="advanced"
            role="tabpanel"
            aria-label="advanced"
          >
            <div class="settings-item">
              <label>other transport</label>
              <p>
                our transport handles http requests; this handles websockets and
                fallback traffic.
              </p>
              <Selector
                label="transport"
                value={transport}
                options={TRANSPORT_OPTIONS}
                isOpen={openSelector}
                onOpen={setOpenSelector}
                onClose={closeSelector}
                onChange={(v) => handleSetting("transport", v, setTransport)}
              />
            </div>
            <div class="settings-item">
              <label>preload engine</label>
              <p>
                load the browser engine early so the first page opens faster.
              </p>
              <Toggle
                id="preload-proxy-toggle"
                checked={preloadProxy}
                onChange={(value) =>
                  handleToggle(
                    ADVANCED_SETTING_KEYS.preloadProxy,
                    value,
                    setPreloadProxy,
                  )
                }
              />
            </div>
            <div class="settings-item">
              <label>save browsing history</label>
              <p>
                keep visited urls between launches; turning this off removes
                saved history.
              </p>
              <Toggle
                id="save-history-toggle"
                checked={saveHistory}
                onChange={(value) =>
                  handleToggle(
                    ADVANCED_SETTING_KEYS.saveHistory,
                    value,
                    setSaveHistory,
                  )
                }
              />
            </div>
          </div>
          )}

          {(searching || activeTab === "extensions") && (
          <div
            class={`tab-content${searching || activeTab === "extensions" ? " active" : ""}`}
            data-tab="extensions"
            role="tabpanel"
            aria-label="extensions"
          >
            <div class="settings-item rivet-manager-header">
                <label>extensions</label>
                <p>install chrome extensions into the browser.</p>
              <div class="rivet-manager-actions">
                <label class="rivet-file-button rivet-action-primary">
                  {extensionBusy ? "working…" : "upload extension"}
                  <input
                    type="file"
                    accept=".zip,.crx,application/zip"
                    disabled={extensionBusy}
                    onChange={(event) => {
                      const input = event.currentTarget as HTMLInputElement;
                      const file = input.files?.[0];
                      if (file) void installExtensionFile(file);
                      input.value = "";
                    }}
                  />
                </label>
              </div>
            </div>
            {extensions.length === 0 ? (
              <div class="settings-item">
                <p>no extensions installed.</p>
              </div>
            ) : (
              extensions.map((extension) => (
                <div class="settings-item rivet-extension" key={extension.id}>
                  <div class="rivet-extension-copy">
                    {extension.iconUrl ? (
                      <img src={extension.iconUrl} alt="" />
                    ) : null}
                    <div>
                      <label>{extension.name}</label>
                      <p>
                        {extension.version || "unknown version"} ·{" "}
                        {extension.id}
                      </p>
                    </div>
                  </div>
                  <div class="rivet-manager-actions">
                    {extension.hasPopup ? (
                      <button
                        type="button"
                        class="rivet-action-secondary"
                        onClick={() => {
                          const rivet = getRivet();
                          const page = rivet?.getExtensionPopupPage(
                            extension.id,
                          );
                          if (page && rivet) {
                            rivet.host.openExtensionTab?.(
                              extension.id,
                              page,
                              null,
                            );
                          }
                        }}
                      >
                        open
                      </button>
                    ) : null}
                    <button
                      type="button"
                      class="rivet-action-secondary"
                      onClick={() =>
                        void getRivet()?.setExtensionEnabled(
                          extension.id,
                          !extension.enabled,
                        )
                      }
                    >
                      {extension.enabled ? "disable" : "enable"}
                    </button>
                    <button
                      type="button"
                      class="rivet-action-secondary"
                      onClick={() =>
                        void getRivet()?.uninstallExtension(extension.id)
                      }
                    >
                      uninstall
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
          )}

        </div>
      </div>
      <button
        id="close-settings-modal"
        class="modal-close-btn"
        aria-label="close settings"
        onClick={toggleSettingsModal}
      >
        <IconCrossMedium />
      </button>
    </div>
  );
}
