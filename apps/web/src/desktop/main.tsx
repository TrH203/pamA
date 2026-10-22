import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../styles.css";
import { inTauri } from "./ipc.ts";
import { Popup } from "./Popup.tsx";
import { Settings } from "./Settings.tsx";

function DesktopApp() {
  if (!inTauri())
    return <p className="p-4 text-stone-600">This page runs inside the pamA desktop app.</p>;
  return new URLSearchParams(location.search).get("view") === "settings" ? <Settings /> : <Popup />;
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <DesktopApp />
    </StrictMode>,
  );
}
