import { openInApp } from "../../core/browser/openInApp.ts";

// Los enlaces del footer son botones y no <a target="_blank"> a proposito: un
// <a> abriria el navegador del sistema, sin proxy y sin HUD, que es
// exactamente lo que este sitio promete no hacer. El reset de .link para
// botones vive en base/index.css, asi que se ven igual.
const LINKS = [
  { label: "discord", url: "https://discord.gg/4GeWaGPh6c" },
  { label: "self-host", url: "https://github.com/gayq/lyra" },
];

export default function Footer() {
  return (
    <div class="footer">
      <div id="cute">
        {LINKS.map((link) => (
          <button
            key={link.label}
            type="button"
            class="link"
            onClick={() => openInApp(link.url)}
          >
            {link.label}
          </button>
        ))}
      </div>
    </div>
  );
}
