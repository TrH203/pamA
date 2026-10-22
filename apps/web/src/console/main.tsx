import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../styles.css";

function ConsoleApp() {
  return <main className="p-4">pamA console</main>;
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ConsoleApp />
    </StrictMode>,
  );
}
