import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../styles.css";

function AskApp() {
  return <main className="p-4">pamA ask</main>;
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <AskApp />
    </StrictMode>,
  );
}
