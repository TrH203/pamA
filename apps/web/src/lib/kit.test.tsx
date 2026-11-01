// @vitest-environment jsdom
// Component tests for the shared kit (spec 009): accessibility wiring and behaviour that the
// console, Ask page and desktop windows rely on.
import { I18nProvider, messages, useI18n } from "@pama/i18n";
import {
  Button,
  ConfirmProvider,
  ErrorBanner,
  Field,
  Input,
  StatusPill,
  useConfirm,
} from "@pama/ui";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(cleanup);

const en = messages("en");
const viMessages = messages("vi");

function Revoke() {
  const confirm = useConfirm();
  const [result, setResult] = useState("pending");
  return (
    <>
      <button
        type="button"
        onClick={async () => setResult(String(await confirm({ title: "Revoke link?" })))}
      >
        revoke
      </button>
      <output>{result}</output>
    </>
  );
}

function Probe() {
  const { t, setLocale } = useI18n();
  return (
    <button type="button" onClick={() => setLocale("vi")}>
      {t.common.retry}
    </button>
  );
}

describe("Button", () => {
  it("disables itself and sets aria-busy while loading", () => {
    render(<Button loading>Save</Button>);
    const b = screen.getByRole("button", { name: /save/i });
    expect(b).toHaveProperty("disabled", true);
    expect(b.getAttribute("aria-busy")).toBe("true");
  });
});

describe("Field", () => {
  it("labels the control and links hint and error", () => {
    render(
      <Field label="Email" hint="Work address" error="Required">
        <Input />
      </Field>,
    );
    const input = screen.getByLabelText("Email");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const ids = (input.getAttribute("aria-describedby") ?? "").split(" ");
    const described = ids.map((id) => document.getElementById(id)?.textContent);
    expect(described).toEqual(["Work address", "Required"]);
  });
});

describe("StatusPill", () => {
  it("always shows text next to its icon (never colour only)", () => {
    const { container } = render(<StatusPill tone="danger">blocked</StatusPill>);
    expect(screen.getByText("blocked")).toBeTruthy();
    expect(container.querySelector("svg[aria-hidden]")).not.toBeNull();
  });
});

describe("ErrorBanner", () => {
  it("is announced as an alert and retries", async () => {
    const retry = vi.fn();
    render(<ErrorBanner message="Network down" onRetry={retry} />);
    expect(screen.getByRole("alert").textContent).toContain("Network down");
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(retry).toHaveBeenCalledOnce();
  });
});

describe("useConfirm", () => {
  it("replaces window.confirm with a dialog that resolves the choice", async () => {
    render(
      <ConfirmProvider defaults={{ confirmLabel: "Confirm", cancelLabel: "Cancel" }}>
        <Revoke />
      </ConfirmProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "revoke" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Revoke link?");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("true"));
  });
});

describe("i18n", () => {
  function keys(o: object, prefix = ""): string[] {
    return Object.entries(o).flatMap(([k, v]) =>
      v && typeof v === "object" ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`],
    );
  }

  it("Vietnamese covers every English key", () => {
    expect(keys(viMessages).sort()).toEqual(keys(en).sort());
  });

  it("sets <html lang> and switches language", async () => {
    render(
      <I18nProvider initial="en">
        <Probe />
      </I18nProvider>,
    );
    expect(document.documentElement.lang).toBe("en");
    await act(() => userEvent.click(screen.getByRole("button")));
    expect(document.documentElement.lang).toBe("vi");
    expect(screen.getByRole("button").textContent).toBe(viMessages.common.retry);
  });
});
