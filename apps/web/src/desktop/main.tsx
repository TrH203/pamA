import { useI18n } from "@pama/i18n";
import { initTheme } from "@pama/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppProviders } from "../lib/providers.tsx";
import "../styles.css";
import { inTauri } from "./ipc.ts";
import { Popup } from "./Popup.tsx";
import { Settings } from "./Settings.tsx";

function DesktopApp() {
  const { t } = useI18n();
  if (!inTauri()) return <p className="p-4 text-muted">{t.desktop.onlyInApp}</p>;
  return new URLSearchParams(location.search).get("view") === "settings" ? <Settings /> : <Popup />;
}

initTheme();
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <AppProviders>
        <DesktopApp />
      </AppProviders>
    </StrictMode>,
  );
}
