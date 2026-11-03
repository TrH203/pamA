import { initTheme } from "@pama/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppProviders } from "../lib/providers.tsx";
import "../styles.css";
import { AskPage } from "./AskPage.tsx";

initTheme();
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <AppProviders>
        <AskPage />
      </AppProviders>
    </StrictMode>,
  );
}
