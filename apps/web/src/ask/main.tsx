import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../styles.css";
import { AskPage } from "./AskPage.tsx";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <AskPage />
    </StrictMode>,
  );
}
