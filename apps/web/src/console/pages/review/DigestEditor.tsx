// Structured digest editor (spec 008a): goal, decisions (add, remove, reorder; what, why,
// rejected alternatives, labels), outcome, open items and modules. Validates against the digest
// schema before handing the edited digest to `onSave`.
import { useI18n } from "@pama/i18n";
import { Button, Checkbox, ErrorBanner, Field, Input, Textarea } from "@pama/ui";
import { ArrowDown, ArrowUp, Check, Plus, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import type { DigestContent } from "./types.ts";
import {
  type DecisionDraft,
  type EditorModel,
  type Errors,
  type FieldError,
  fromModel,
  LABELS,
  LIMITS,
  newKey,
  toModel,
  validate,
} from "./validate.ts";

function useErrorText() {
  const { t } = useI18n();
  const e = t.lib.editor.errors;
  return (err: FieldError | undefined) => {
    if (!err) return undefined;
    if (err.code === "required") return e.required;
    if (err.code === "tooLong") return e.tooLong(err.max);
    return e.tooMany(err.max);
  };
}

/** A list of one-line strings with add and remove. */
function StringList({
  legend,
  name,
  values,
  onChange,
  errors,
  max,
}: {
  legend: string;
  name: string;
  values: string[];
  onChange: (v: string[]) => void;
  errors: Errors;
  max: number | undefined;
}) {
  const { t } = useI18n();
  const ed = t.lib.editor;
  const errText = useErrorText();
  const listError = errText(errors[name]);
  return (
    <fieldset className="space-y-2">
      <legend className="text-ui font-medium text-fg">{legend}</legend>
      {values.length > 0 && (
        <ul className="space-y-2">
          {values.map((v, i) => {
            const label = `${legend}: ${ed.item(i + 1)}`;
            const err = errText(errors[`${name}.${i}`]);
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: plain strings edited in place
              <li key={i} className="space-y-1">
                <div className="flex gap-2">
                  <Input
                    aria-label={label}
                    aria-invalid={err ? true : undefined}
                    value={v}
                    onChange={(e) => onChange(values.map((x, j) => (j === i ? e.target.value : x)))}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={ed.remove(label)}
                    onClick={() => onChange(values.filter((_, j) => j !== i))}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </div>
                {err && <p className="text-xs text-danger-ink">{err}</p>}
              </li>
            );
          })}
        </ul>
      )}
      {listError && <p className="text-xs text-danger-ink">{listError}</p>}
      <Button
        size="sm"
        variant="ghost"
        disabled={max !== undefined && values.length >= max}
        onClick={() => onChange([...values, ""])}
      >
        <Plus aria-hidden />
        {ed.add}
      </Button>
    </fieldset>
  );
}

function DecisionEditor({
  d,
  i,
  count,
  errors,
  onChange,
  onRemove,
  onMove,
}: {
  d: DecisionDraft;
  i: number;
  count: number;
  errors: Errors;
  onChange: (d: DecisionDraft) => void;
  onRemove: () => void;
  onMove: (by: -1 | 1) => void;
}) {
  const { t } = useI18n();
  const ed = t.lib.editor;
  const errText = useErrorText();
  const n = i + 1;
  return (
    <li className="space-y-3 rounded-card border border-line bg-subtle/40 p-3">
      <fieldset className="space-y-3" aria-labelledby={`${d.key}-title`}>
        <div className="flex items-center gap-1">
          <h5 id={`${d.key}-title`} className="mr-auto text-ui font-medium text-fg">
            {ed.decision(n)}
          </h5>
          <Button
            variant="ghost"
            size="icon"
            aria-label={ed.moveUp(n)}
            disabled={i === 0}
            onClick={() => onMove(-1)}
          >
            <ArrowUp aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={ed.moveDown(n)}
            disabled={i === count - 1}
            onClick={() => onMove(1)}
          >
            <ArrowDown aria-hidden />
          </Button>
          <Button variant="ghost" size="icon" aria-label={ed.removeDecision(n)} onClick={onRemove}>
            <Trash2 aria-hidden />
          </Button>
        </div>
        <Field label={ed.what} error={errText(errors[`decisions.${i}.what`])}>
          <Textarea
            rows={2}
            value={d.what}
            onChange={(e) => onChange({ ...d, what: e.target.value })}
          />
        </Field>
        <Field label={ed.why} error={errText(errors[`decisions.${i}.why`])}>
          <Textarea
            rows={2}
            value={d.why}
            onChange={(e) => onChange({ ...d, why: e.target.value })}
          />
        </Field>
        <Field
          label={ed.alternatives}
          hint={ed.alternativesHint}
          error={errText(errors[`decisions.${i}.alternatives`])}
        >
          <Textarea
            rows={2}
            value={d.alternatives}
            onChange={(e) => onChange({ ...d, alternatives: e.target.value })}
          />
        </Field>
        <fieldset>
          <legend className="mb-1.5 text-ui font-medium text-fg">{ed.labels}</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {LABELS.map((l) => {
              const id = `${d.key}-label-${l}`;
              return (
                <span key={l} className="flex items-center gap-2">
                  <Checkbox
                    id={id}
                    checked={d.labels.includes(l)}
                    onCheckedChange={(c) =>
                      onChange({
                        ...d,
                        labels: c === true ? [...d.labels, l] : d.labels.filter((x) => x !== l),
                      })
                    }
                  />
                  <label htmlFor={id} className="text-ui text-fg">
                    {ed.labelNames[l] ?? l}
                  </label>
                </span>
              );
            })}
          </div>
        </fieldset>
      </fieldset>
    </li>
  );
}

export function DigestEditor({
  content,
  saving,
  onSave,
  onCancel,
}: {
  content: DigestContent;
  saving?: boolean;
  onSave: (edited: DigestContent) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const ed = t.lib.editor;
  const errText = useErrorText();
  const [m, setM] = useState<EditorModel>(() => toModel(content));
  const [errors, setErrors] = useState<Errors>({});
  const [tried, setTried] = useState(false);

  const update = (next: EditorModel) => {
    setM(next);
    if (tried) setErrors(validate(next));
  };
  const setDecision = (i: number, d: DecisionDraft) =>
    update({ ...m, decisions: m.decisions.map((x, j) => (j === i ? d : x)) });
  const move = (i: number, by: -1 | 1) => {
    const next = [...m.decisions];
    const j = i + by;
    const a = next[i];
    const b = next[j];
    if (!a || !b) return;
    next[i] = b;
    next[j] = a;
    update({ ...m, decisions: next });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    const errs = validate(m);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    onSave(fromModel(m, content));
  };
  const maxDecisions = LIMITS.decisions.maxItems;

  return (
    <form onSubmit={submit} noValidate className="space-y-4" aria-label={t.lib.review.edit}>
      {tried && Object.keys(errors).length > 0 && <ErrorBanner title={ed.invalid} />}
      <Field label={ed.goal} hint={ed.goalHint} error={errText(errors.goal)}>
        <Textarea
          rows={2}
          value={m.goal}
          autoFocus
          onChange={(e) => update({ ...m, goal: e.target.value })}
        />
      </Field>

      <section className="space-y-2" aria-label={ed.decisions}>
        <h4 className="text-ui font-medium text-fg">{ed.decisions}</h4>
        {m.decisions.length > 0 && (
          <ol className="space-y-3">
            {m.decisions.map((d, i) => (
              <DecisionEditor
                key={d.key}
                d={d}
                i={i}
                count={m.decisions.length}
                errors={errors}
                onChange={(x) => setDecision(i, x)}
                onRemove={() => update({ ...m, decisions: m.decisions.filter((_, j) => j !== i) })}
                onMove={(by) => move(i, by)}
              />
            ))}
          </ol>
        )}
        {errors.decisions && <p className="text-xs text-danger-ink">{errText(errors.decisions)}</p>}
        <Button
          size="sm"
          disabled={maxDecisions !== undefined && m.decisions.length >= maxDecisions}
          onClick={() =>
            update({
              ...m,
              decisions: [
                ...m.decisions,
                { key: newKey(), what: "", why: "", alternatives: "", labels: [] },
              ],
            })
          }
        >
          <Plus aria-hidden />
          {ed.addDecision}
        </Button>
      </section>

      <Field label={ed.outcome} error={errText(errors.outcome)}>
        <Textarea
          rows={2}
          value={m.outcome}
          onChange={(e) => update({ ...m, outcome: e.target.value })}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <StringList
          legend={ed.openItems}
          name="open_items"
          values={m.open_items}
          onChange={(v) => update({ ...m, open_items: v })}
          errors={errors}
          max={LIMITS.open_items.maxItems}
        />
        <StringList
          legend={ed.modules}
          name="modules"
          values={m.modules}
          onChange={(v) => update({ ...m, modules: v })}
          errors={errors}
          max={LIMITS.modules.maxItems}
        />
      </div>

      <p className="text-xs text-muted">
        {ed.redactions(content.redactions.secret, content.redactions.pii)}
      </p>
      <footer className="flex flex-wrap gap-2 border-t border-line pt-4">
        <Button type="submit" variant="primary" loading={saving}>
          <Check aria-hidden />
          {ed.saveApprove}
        </Button>
        <Button onClick={onCancel}>{ed.cancel}</Button>
      </footer>
    </form>
  );
}
