import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../styles.css";
import { inTauri } from "./ipc.ts";
import { Popup } from "./Popup.tsx";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      {inTauri() ? (
        <Popup />
      ) : (
        <p className="p-4 text-stone-600">The draft popup runs inside the pamA desktop app.</p>
      )}
    </StrictMode>,
  );
}
