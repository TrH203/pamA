import { useI18n } from "@pama/i18n";
import { EmptyState, initTheme } from "@pama/ui";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { MonitorSmartphone } from "lucide-react";
import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ApiError, token } from "../lib/api.ts";
import { AppProviders } from "../lib/providers.tsx";
import { makeQueryClient, queries } from "../lib/query.ts";
import "../styles.css";
import { DeviceApprove } from "./DeviceApprove.tsx";
import { Login } from "./Login.tsx";
import { legacyRedirect } from "./legacy.ts";
import { makeRouter } from "./router.tsx";

type Auth = "checking" | "ok" | "login" | "local";

function useAuth(): { auth: Auth; dev: boolean } {
  const me = useQuery({ ...queries.me, retry: false, staleTime: Number.POSITIVE_INFINITY });
  if (me.isPending) return { auth: "checking", dev: false };
  if (me.data) return { auth: "ok", dev: me.data.dev === true };
  const e = me.error;
  if (!(e instanceof ApiError) || e.status !== 401) return { auth: "ok", dev: false };
  // The owner's machine uses a per-launch token: open the console from the desktop app.
  const local = location.hostname === "127.0.0.1" || location.hostname === "localhost";
  return { auth: local ? "local" : "login", dev: false };
}

function OpenFromApp() {
  const { t } = useI18n();
  return (
    <main className="mx-auto mt-24 max-w-md px-4">
      <EmptyState
        icon={MonitorSmartphone}
        title={t.console.openFromAppTitle}
        description={t.console.openFromApp}
      />
    </main>
  );
}

function ConsoleApp() {
  const { auth, dev } = useAuth();
  // `pama login` opens `/?device=CODE` (spec 004).
  const [device, setDevice] = useState(new URLSearchParams(location.search).get("device"));
  const router = useMemo(() => (auth === "ok" ? makeRouter({ dev }) : null), [auth, dev]);
  if (auth === "checking") return null;
  if (auth === "login") return <Login />;
  if (auth === "local") return <OpenFromApp />;
  if (device) {
    return (
      <DeviceApprove
        code={device}
        onClose={() => {
          history.replaceState(null, "", "/review");
          setDevice(null);
        }}
      />
    );
  }
  return router ? <RouterProvider router={router} /> : null;
}

// Before anything reads the URL: keep the fragment token, then map v0.1 `?tab=` links.
token();
initTheme();
const legacy = legacyRedirect(location.pathname, location.search);
if (legacy) history.replaceState(null, "", legacy);

const queryClient = makeQueryClient();
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <AppProviders>
          <ConsoleApp />
        </AppProviders>
      </QueryClientProvider>
    </StrictMode>,
  );
}
