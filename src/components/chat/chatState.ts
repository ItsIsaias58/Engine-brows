import { signal } from "@preact/signals";

// estado de apertura del panel de chat del shell. Vive aparte del componente
// para que el botón de la TopBar pueda alternarlo sin que el panel esté montado
// todavía (se monta la primera vez que se abre).
export const chatPanelOpen = signal(false);
