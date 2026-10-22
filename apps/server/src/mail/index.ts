// Outgoing email (one-time codes, owner replies) via the operator's SMTP server (research R11).
// Without SMTP, only the open and PIN access modes can be used.
import type { Config } from "../config.ts";
import type { EgressGuard } from "../net/egress.ts";

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  available: boolean;
  send(m: Mail): Promise<void>;
}

export const noMailer: Mailer = {
  available: false,
  send: async () => {
    throw new Error("email is not configured");
  },
};

export async function createMailer(config: Config, guard: EgressGuard): Promise<Mailer> {
  if (!config.smtp) return noMailer;
  const { createTransport } = await import("nodemailer");
  const smtp = config.smtp;
  const transport = createTransport(smtp.url);
  const host = new URL(smtp.url).hostname;
  return {
    available: true,
    async send(m) {
      await guard.assertAllowed(host, "mail");
      await transport.sendMail({ from: smtp.from, to: m.to, subject: m.subject, text: m.text });
    },
  };
}
