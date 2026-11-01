import { describe, expect, it } from "vitest";
import { legacyRedirect } from "./legacy.ts";

describe("legacyRedirect", () => {
  it("maps every v0.1 tab to its v0.2 route", () => {
    expect(legacyRedirect("/", "?tab=review")).toBe("/review");
    expect(legacyRedirect("/", "?tab=inbox")).toBe("/conversations");
    expect(legacyRedirect("/", "?tab=audit")).toBe("/activity/audit");
    expect(legacyRedirect("/", "?tab=bundles")).toBe("/library/tasks");
    expect(legacyRedirect("/", "?tab=doctor")).toBe("/activity/doctor");
    expect(legacyRedirect("/", "?tab=settings")).toBe("/settings/connections");
  });

  it("keeps the other parameters (the desktop opens ?tab=links&q=…)", () => {
    expect(legacyRedirect("/", "?tab=links&q=refund%20fee")).toBe("/links?q=refund+fee");
    expect(legacyRedirect("/", "?tab=settings&section=models")).toBe(
      "/settings/connections?section=models",
    );
  });

  it("sends unknown tabs to Review and /console to the root", () => {
    expect(legacyRedirect("/", "?tab=nope")).toBe("/review");
    expect(legacyRedirect("/console", "")).toBe("/");
    expect(legacyRedirect("/console", "?tab=links")).toBe("/links");
  });

  it("leaves v0.2 URLs alone", () => {
    expect(legacyRedirect("/review", "")).toBeNull();
    expect(legacyRedirect("/", "")).toBeNull();
    expect(legacyRedirect("/", "?device=ABCD-EFGH")).toBeNull();
    expect(legacyRedirect("/links", "?tab=links")).toBeNull();
  });
});
