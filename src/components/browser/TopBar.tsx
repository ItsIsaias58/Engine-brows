import { useCallback, useEffect } from "preact/hooks";
import { gamesViewSignal, animeViewSignal, musicViewSignal } from "../../core/ui/uiSignals.ts";
import { IconCloud, IconSettingsGear4 } from "../icons";
import { svgIcon } from "../../core/ui/svgIcon";
import { invokeWindowAction } from "../../core/browser/windowActions.ts";
import { closeStage } from "../../core/browser/stageOverlay.ts";
import {
  preloadAnimeCatalog,
  preloadMusicCatalog,
  loadCloudSync,
  preloadGamesCatalog,
  loadSettingsModal,
} from "../../app/loaders.ts";

export default function TopBar() {
  useEffect(() => {
    const user = JSON.parse(localStorage.getItem("auth_user") || "{}");
    if (user.username) {
      const statusEl = document.getElementById("auth-status");
      if (statusEl) statusEl.textContent = user.username;
    }
    const choiIcon = document.getElementById("games-icon");
    if (choiIcon && !choiIcon.innerHTML) {
      choiIcon.innerHTML = svgIcon("IconGamecontroller", { solid: true });
    }
    const animeIcon = document.getElementById("anime-icon");
    if (animeIcon && !animeIcon.innerHTML) {
      animeIcon.innerHTML = svgIcon("IconSushi", { size: 22, solid: true });
    }
    const musicIcon = document.getElementById("music-icon");
    if (musicIcon && !musicIcon.innerHTML) {
      musicIcon.innerHTML = svgIcon("IconAudio", { size: 22, solid: true });
    }
  }, []);

  const handleBrandClick = useCallback((e: MouseEvent) => {
    e.preventDefault();
    // volver a la portada es "salir" del visor: la marca es la unica forma de
    // pedir la pantalla completa de la app sin tener que buscar el boton de
    // cerrar, que esta abajo a la derecha
    closeStage();
    window.hideGameMenu?.();
    window.hideAnimeMenu?.();
    window.hideMusicMenu?.();
  }, []);

  const handleGamesClick = useCallback((e: MouseEvent) => {
    e.preventDefault();
    invokeWindowAction("toggleGameMenu");
  }, []);

  const handleAnimeClick = useCallback((e: MouseEvent) => {
    e.preventDefault();
    invokeWindowAction("toggleAnimeMenu");
  }, []);

  const handleMusicClick = useCallback((e: MouseEvent) => {
    e.preventDefault();
    invokeWindowAction("toggleMusicMenu");
  }, []);

  const handleSettingsClick = useCallback((e: MouseEvent) => {
    e.preventDefault();
    invokeWindowAction("toggleSettingsModal");
  }, []);

  return (
    <>
      <div id="top-left-stuff">
        <div
          id="branding-container"
          class="icon-btn"
          onClick={handleBrandClick}
        >
          <span id="brand">lyraaaa</span>
          <div id="oneko"></div>
        </div>
        <a
          href="#"
          id="choi"
          class="icon-btn"
          data-tooltip={gamesViewSignal.value ? "search" : "games"}
          onPointerEnter={preloadGamesCatalog}
          onFocus={preloadGamesCatalog}
          onClick={handleGamesClick}
        >
          <span id="games-icon" />
        </a>
        <a
          href="#"
          id="media-catalog"
          class="icon-btn"
          data-tooltip={animeViewSignal.value ? "search" : "anime"}
          onPointerEnter={preloadAnimeCatalog}
          onFocus={preloadAnimeCatalog}
          onClick={handleAnimeClick}
        >
          <span id="anime-icon" />
        </a>
        <a
          href="#"
          id="music-catalog-btn"
          class="icon-btn"
          data-tooltip={musicViewSignal.value ? "close music" : "music"}
          onPointerEnter={preloadMusicCatalog}
          onFocus={preloadMusicCatalog}
          onClick={handleMusicClick}
        >
          <span id="music-icon" />
        </a>
      </div>
      <div id="top-right-stuff">
        <div
          id="auth-container"
          class="text-icon-btn"
          onPointerEnter={() => void loadCloudSync()}
          onFocus={() => void loadCloudSync()}
          onClick={() =>
            document.dispatchEvent(new CustomEvent("toggleCloudSyncModal"))
          }
        >
          <IconCloud solid />
          <span id="auth-status">cloud sync</span>
        </div>
        <a
          href="#"
          id="settings"
          class="icon-btn"
          data-tooltip="settings"
          onPointerEnter={() => void loadSettingsModal()}
          onFocus={() => void loadSettingsModal()}
          onClick={handleSettingsClick}
        >
          <IconSettingsGear4 solid class="settings" />
        </a>
      </div>
    </>
  );
}
