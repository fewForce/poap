/**
 * Sending the pass by email over SMTP, as tessera does: the .pkpass attached
 * (an iPhone opens it straight into Wallet) and a download link beside it for
 * mail clients that strip attachments.
 */
import nodemailer, { type Transporter } from "nodemailer";
import type { EventRecord, RegistrationRecord } from "../types.js";
import { PKPASS_CONTENT_TYPE } from "./pass.js";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments?: Array<{ filename: string; content: Buffer; contentType: string }>;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export interface SmtpConfig {
  host: string;
  port: number;
  /** True for implicit TLS (port 465); false upgrades with STARTTLS when the server offers it. */
  secure: boolean;
  user?: string;
  password?: string;
  from: string;
  fromName: string;
}

export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;

  constructor(private readonly config: SmtpConfig) {
    this.transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      ...(config.user ? { auth: { user: config.user, pass: config.password ?? "" } } : {}),
    });
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({
      from: { name: this.config.fromName, address: this.config.from },
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      attachments: (message.attachments ?? []).map((a) => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType,
      })),
    });
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

export function passEmail(input: {
  to: string;
  event: EventRecord;
  registration: RegistrationRecord;
  pkpass: Buffer;
  downloadUrl: string;
}): MailMessage {
  const { event, registration } = input;
  const name = registration.displayName?.trim() || "there";
  const when = [event.eventDate, event.venue].filter((x): x is string => Boolean(x?.trim())).join(" · ");
  const subject = `Your pass for ${event.name}`;
  const text = [
    `Hi ${name},`,
    "",
    `You are registered for ${event.name}${when ? ` (${when})` : ""}.`,
    "",
    "Your Apple Wallet pass is attached. On an iPhone, open the attachment and tap Add.",
    `If the attachment is missing, download the pass here: ${input.downloadUrl}`,
    "",
    "Show the pass at the desk. The volunteer scans it and your badge is issued to your account:",
    registration.address,
    "",
    "The code on the pass changes after every scan, so please use the pass itself rather than a screenshot.",
  ].join("\n");
  const html = `<!doctype html><html><body style="margin:0;background:#faf9f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1c1b1a">
<div style="max-width:520px;margin:0 auto;padding:28px 20px">
<div style="background:#fff;border:1px solid #eceae6;border-radius:16px;padding:26px">
<p style="margin:0 0 4px;font-size:13px;color:#8a8681">${escapeHtml(when || `Event ${event.eventId}`)}</p>
<h1 style="margin:0 0 16px;font-size:22px;line-height:1.25">${escapeHtml(event.name)}</h1>
<p style="margin:0 0 14px;font-size:15px;line-height:1.55">Hi ${escapeHtml(name)}, you are registered. Your Apple Wallet pass is attached: on an iPhone, open it and tap <b>Add</b>.</p>
<p style="margin:0 0 18px"><a href="${escapeHtml(input.downloadUrl)}" style="display:inline-block;background:#1c1b1a;color:#fff;text-decoration:none;border-radius:10px;padding:12px 18px;font-size:15px;font-weight:600">Add to Apple Wallet</a></p>
<p style="margin:0 0 8px;font-size:14px;line-height:1.55;color:#57544f">Show the pass at the desk. The volunteer scans it and your badge is issued to:</p>
<p style="margin:0 0 16px;font-family:SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;word-break:break-all">${escapeHtml(registration.address)}</p>
<p style="margin:0;font-size:13px;line-height:1.5;color:#8a8681">The code on the pass changes after every scan, so a screenshot of it will not work.</p>
</div>
<p style="margin:14px 0 0;text-align:center;font-size:12px;color:#8a8681">powered by feooh</p>
</div></body></html>`;
  return {
    to: input.to,
    subject,
    text,
    html,
    attachments: [{ filename: "pass.pkpass", content: input.pkpass, contentType: PKPASS_CONTENT_TYPE }],
  };
}
