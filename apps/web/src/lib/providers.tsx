// Providers every entry point needs: language, toasts, confirm dialogs and tooltips.
import { I18nProvider, useI18n } from "@pama/i18n";
import { ConfirmProvider, ToastProvider, TooltipProvider } from "@pama/ui";
import type { ReactNode } from "react";

function Kit({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  return (
    <TooltipProvider delayDuration={300}>
      <ToastProvider closeLabel={t.common.dismiss}>
        <ConfirmProvider
          defaults={{ confirmLabel: t.common.confirm, cancelLabel: t.common.cancel }}
        >
          {children}
        </ConfirmProvider>
      </ToastProvider>
    </TooltipProvider>
  );
}

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <I18nProvider>
      <Kit>{children}</Kit>
    </I18nProvider>
  );
}
