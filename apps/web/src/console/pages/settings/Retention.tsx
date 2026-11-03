// Settings → Retention (spec 008, FR-008): how long Ask Link conversations are kept.
import { useI18n } from "@pama/i18n";
import { Button, Card, CardHeader, ErrorBanner, Field, Input, useToast } from "@pama/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, errorMessage } from "../../../lib/api.ts";
import { settingsKeys, useRetention } from "./data.ts";
import { Loaded } from "./shared.tsx";

const MIN = 1;
const MAX = 3650;

function RetentionForm({ days }: { days: number }) {
  const { t } = useI18n();
  const r = t.pages.settings.retention;
  const toast = useToast();
  const qc = useQueryClient();
  const [value, setValue] = useState(String(days));
  useEffect(() => setValue(String(days)), [days]);
  const n = Number(value);
  const valid = /^\d+$/.test(value.trim()) && n >= MIN && n <= MAX;
  const save = useMutation({
    mutationFn: (d: number) =>
      api<{ ask_retention_days: number }>("/v1/settings/retention", {
        method: "PUT",
        json: { ask_retention_days: d },
      }),
    onSuccess: (res) => {
      qc.setQueryData(settingsKeys.retention, res);
      toast.success(r.saved);
    },
  });
  return (
    <Card>
      <CardHeader title={r.title} description={r.description} />
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) save.mutate(n);
        }}
      >
        <Field
          label={r.days}
          hint={`${r.hint} ${r.current(days)}`}
          error={value !== "" && !valid ? r.invalid : undefined}
        >
          <Input
            type="number"
            inputMode="numeric"
            min={MIN}
            max={MAX}
            step={1}
            required
            className="max-w-40"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </Field>
        {save.isError && <ErrorBanner title={r.saveFailed} message={errorMessage(save.error)} />}
        <Button
          type="submit"
          variant="primary"
          loading={save.isPending}
          disabled={!valid || n === days}
        >
          {t.common.save}
        </Button>
      </form>
    </Card>
  );
}

export function Retention() {
  const q = useRetention();
  return (
    <Loaded queries={[q]} rows={1}>
      {() => <RetentionForm days={q.data?.ask_retention_days ?? 180} />}
    </Loaded>
  );
}
