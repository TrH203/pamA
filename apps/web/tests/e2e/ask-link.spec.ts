// Quickstart Scenario 2 in a browser: PIN gate, cited answer, out-of-scope refusal + forward,
// owner reply, lockout, revoke.
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { DEMO_OUT } from "../../playwright.config.ts";

const demo = () =>
  JSON.parse(readFileSync(DEMO_OUT, "utf8")) as {
    base: string;
    token: string;
    pinLink: string;
    pin: string;
    openLink: string;
  };

test("PIN link: answer with citations, refuse out of scope, forward, owner reply", async ({
  page,
  request,
}) => {
  const d = demo();
  await page.goto(d.pinLink);
  await expect(page.getByRole("heading", { name: "Enter the PIN" })).toBeVisible();
  await page.getByLabel("Enter the PIN").fill(d.pin);
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByText("You're asking Hien's agent")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Refund policy" })).toBeVisible();

  const box = page.getByLabel("Ask a question in any language…");
  await box.fill("Do refunds include the shipping fee?");
  await box.press("Enter");
  await expect(page.getByText("Automated answer on behalf of Hien")).toBeVisible();
  await expect(page.getByText("Refunds do not include the shipping fee.").first()).toBeVisible();
  await expect(page.getByText(/\[1\] .*feat\/refund-shipping/)).toBeVisible();

  await box.fill("Which merchant account does payment-sandbox use?");
  await box.press("Enter");
  await expect(page.getByText("This isn't covered by what was shared with you.")).toBeVisible();
  await expect(page.getByText("merchant account", { exact: false }).last()).not.toHaveText(
    /webhook signing/,
  );
  await page.getByRole("button", { name: "Forward to Hien" }).click();
  await expect(page.getByText("Forwarded. Hien's reply will appear here.")).toBeVisible();

  // Owner replies from the inbox (API); the asker sees it after reload.
  const auth = { authorization: `Bearer ${d.token}` };
  const inbox = await (await request.get(`${d.base}/v1/inbox`, { headers: auth })).json();
  const id = inbox.items[0].id;
  await request.post(`${d.base}/v1/asks/${id}/reply`, {
    headers: auth,
    data: { text: "Not in this project, I'll send details separately." },
  });
  await page.reload();
  await expect(page.getByText("Reply from Hien")).toBeVisible();
  await expect(page.getByText("I'll send details separately.")).toBeVisible();
});

test("wrong PIN five times locks access", async ({ browser }) => {
  const d = demo();
  const page = await (await browser.newContext()).newPage();
  await page.goto(d.pinLink);
  for (let i = 0; i < 5; i++) {
    await page.getByLabel("Enter the PIN").fill("0000");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.locator("p.text-red-700")).toBeVisible();
  }
  await page.getByLabel("Enter the PIN").fill(d.pin);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Too many attempts. Try again in 15 minutes.")).toBeVisible();
});

test("open link shows suggested questions; revoked link shows nothing", async ({
  page,
  request,
}) => {
  const d = demo();
  await page.goto(d.openLink);
  await expect(page.getByText("Try asking")).toBeVisible();
  await page
    .getByRole("button", { name: /Why was it decided/ })
    .first()
    .click();
  await expect(
    page.getByText("Automated answer on behalf of Hien").or(page.getByText("This isn't covered")),
  ).toBeVisible();

  const slug = new URL(d.openLink).pathname.split("/")[2];
  await request.post(`${d.base}/v1/links/${slug}/revoke`, {
    headers: { authorization: `Bearer ${d.token}` },
    data: {},
  });
  const res = await page.goto(d.openLink);
  expect(res?.status()).toBe(410);
  await expect(page.getByText("This link is no longer active")).toBeVisible();
  await expect(page.getByText("Try asking")).toHaveCount(0);
});
