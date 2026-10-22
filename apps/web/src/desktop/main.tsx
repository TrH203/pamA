import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../styles.css";

function DesktopApp() {
  return <main className="p-4">pamA desktop</main>;
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <DesktopApp />
    </StrictMode>,
  );
}
