import { useEffect } from "preact/hooks";
import { chatPanelOpen } from "./chatState.ts";

// panel de chat del shell de lyra. No reimplementa el chat: incrusta el widget
// compartido de owngames (`/owngames/shared/chat.html?embed=1`), que es el mismo
// que usan la bolsa y opencase. Así hay una sola lógica de chat y de sesión.
export default function ChatPanel({ openOnMount = false }: { openOnMount?: boolean }) {
  useEffect(() => {
    if (openOnMount) chatPanelOpen.value = true;
    // atajo: Esc cierra el panel, como el resto de menús
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && chatPanelOpen.value) chatPanelOpen.value = false;
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openOnMount]);

  if (!chatPanelOpen.value) return null;

  return (
    <div
      class="lyra-chat-shell"
      style={{
        position: "fixed",
        right: "12px",
        top: "12px",
        bottom: "12px",
        width: "430px",
        maxWidth: "calc(100vw - 24px)",
        zIndex: 50,
        display: "flex",
        flexDirection: "column",
        background: "#0f151c",
        border: "1px solid #223040",
        borderRadius: "12px",
        overflow: "hidden",
        boxShadow: "0 12px 40px rgba(0,0,0,.5)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "8px 12px",
          borderBottom: "1px solid #223040",
          background: "#131a22",
          color: "#e8eef5",
          font: "600 13px system-ui, sans-serif",
        }}
      >
        <span style={{ color: "#29e0a8" }}>💬 Chat</span>
        <button
          type="button"
          aria-label="Cerrar chat"
          onClick={() => { chatPanelOpen.value = false; }}
          style={{
            marginLeft: "auto",
            background: "none",
            border: 0,
            color: "#8aa0b4",
            cursor: "pointer",
            fontSize: "15px",
          }}
        >
          ✕
        </button>
      </div>
      <iframe
        id="lyra-chat-frame"
        title="Chat de owngames"
        src="/owngames/shared/chat.html?embed=1"
        style={{ flex: 1, width: "100%", border: 0, background: "#0b0f14" }}
      />
    </div>
  );
}
