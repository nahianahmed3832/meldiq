import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
import type { Metrics } from "../../modules/administration/ops/metrics.js";
import type { MailConfig } from "../../modules/accounts/config.js";
import { type InlineImage, type MailContent, renderMail } from "./mailTemplate.js";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  /** The designed version (mailTemplate.ts); clients that can't show HTML show [text]. */
  html?: string;
  /** Images the HTML refers to by cid: (the logo). */
  inline?: InlineImage[];
}

/** One message in nodemailer's shape: text and HTML alternatives, inline images as related parts. */
export interface MimeMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: { cid: string; filename: string; contentType: string; content: Buffer; contentDisposition: "inline" }[];
}

function mimeMessage(from: string, m: MailMessage): MimeMessage {
  const base = { from, to: m.to, subject: m.subject, text: m.text };
  if (!m.html) return base;
  const attachments = (m.inline ?? []).map((i) => ({ ...i, contentDisposition: "inline" as const }));
  return { ...base, html: m.html, ...(attachments.length ? { attachments } : {}) };
}

/** Sends account emails (verification and reset codes). Implementations never log a message's body: it holds codes. */
export interface Mailer {
  readonly kind: MailConfig["transport"] | "memory";
  /** False when no transport is configured: routes that must send email answer 503 instead of pretending. */
  readonly available: boolean;
  send(message: MailMessage): Promise<void>;
  /** Connects and signs in without sending anything (the connector check); absent when the transport can't. */
  verify?(): Promise<void>;
}

/**
 * The same mailer, with each send's outcome counted for the platform health view (docs/OPERATIONS.md). Only the
 * transport and the error's kind are recorded, never the address or the message.
 */
export function meteredMailer(inner: Mailer, metrics: Metrics | undefined): Mailer {
  if (!metrics) return inner;
  const name = `mail.${inner.kind}`;
  return {
    kind: inner.kind,
    available: inner.available,
    async send(message: MailMessage): Promise<void> {
      try {
        await inner.send(message);
        metrics.recordProvider(name);
      } catch (e) {
        metrics.recordProvider(name, e);
        throw e;
      }
    },
    verify: inner.verify
      ? async () => {
          try {
            await inner.verify?.();
            metrics.recordProvider(name);
          } catch (e) {
            metrics.recordProvider(name, e);
            throw e;
          }
        }
      : undefined,
  };
}

class NoMailer implements Mailer {
  readonly kind = "none" as const;
  readonly available = false;
  async send(): Promise<void> {
    throw new Error("no mail transport configured");
  }
}

/** Development only (refused with APP_ENV=production): one file per message, readable only by the server's user. */
class FileMailer implements Mailer {
  readonly kind = "file" as const;
  readonly available = true;
  constructor(
    private readonly dir: string,
    private readonly from: string,
  ) {}

  async send(m: MailMessage): Promise<void> {
    await fs.promises.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const name = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.eml`;
    const body = `From: ${this.from}\nTo: ${m.to}\nSubject: ${m.subject}\n\n${m.text}\n`;
    await fs.promises.writeFile(path.join(this.dir, name), body, { mode: 0o600 });
    // The designed version next to it, for a look in a browser (the logo shows as a broken image there).
    if (m.html) await fs.promises.writeFile(path.join(this.dir, name.replace(/\.eml$/, ".html")), m.html, { mode: 0o600 });
  }
}

/** The part of the SES client this mailer uses (tests pass a fake). */
export interface SesSender {
  send(command: SendEmailCommand): Promise<unknown>;
}

export class SesMailer implements Mailer {
  readonly kind = "ses" as const;
  readonly available = true;
  constructor(
    private readonly client: SesSender,
    private readonly from: string,
  ) {}

  async send(m: MailMessage): Promise<void> {
    if (m.html) {
      // SES's simple form has no inline images, so the designed version goes as a complete MIME message.
      const raw = await new MailComposer(mimeMessage(this.from, m)).compile().build();
      await this.client.send(new SendEmailCommand({ FromEmailAddress: this.from, Destination: { ToAddresses: [m.to] }, Content: { Raw: { Data: raw } } }));
      return;
    }
    await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: this.from,
        Destination: { ToAddresses: [m.to] },
        Content: { Simple: { Subject: { Data: m.subject, Charset: "UTF-8" }, Body: { Text: { Data: m.text, Charset: "UTF-8" } } } },
      }),
    );
  }
}

/** The part of a nodemailer transport this mailer uses (tests pass a fake). */
export interface SmtpSender {
  sendMail(message: MimeMessage): Promise<unknown>;
  verify?(): Promise<unknown>;
}

/**
 * Any SMTP provider (Hostinger Mail for development and early testing). Always encrypted: TLS from the start on port
 * 465, or a required STARTTLS upgrade elsewhere, with the server's certificate checked. Errors are passed on without
 * the message (it holds a code); nodemailer's own logging stays off.
 */
export class SmtpMailer implements Mailer {
  readonly kind = "smtp" as const;
  readonly available = true;
  constructor(
    private readonly transport: SmtpSender,
    private readonly from: string,
  ) {}

  async send(m: MailMessage): Promise<void> {
    await this.transport.sendMail(mimeMessage(this.from, m));
  }

  async verify(): Promise<void> {
    await this.transport.verify?.();
  }
}

/** Connection timeouts for SMTP: a slow provider must not hold a sign-up request open. */
const SMTP_TIMEOUT_MS = 15_000;

export function smtpTransport(config: Extract<MailConfig, { transport: "smtp" }>): SmtpSender {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: !config.secure,
    auth: config.auth ?? undefined,
    tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
    logger: false,
    debug: false,
  });
}

export function createMailer(config: MailConfig): Mailer {
  switch (config.transport) {
    case "none":
      return new NoMailer();
    case "file":
      return new FileMailer(config.dir, config.from);
    case "ses":
      return new SesMailer(new SESv2Client({ region: config.region, ...(config.credentials ? { credentials: config.credentials } : {}) }), config.from);
    case "smtp":
      return new SmtpMailer(smtpTransport(config), config.from);
  }
}

/** Subject plus the designed and plain versions of one account email. */
function compose(subject: string, content: MailContent): Omit<MailMessage, "to"> {
  return { subject, ...renderMail(subject, content) };
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The texts of account emails, laid out by mailTemplate.ts. No links: the person types the code into the app. Nothing
 * anyone typed (a name) goes into them, so the sign-up form can't be used to send someone else's words from Meldiq's
 * address.
 */
export const mailTexts = {
  verifyEmail: (code: string): Omit<MailMessage, "to"> =>
    compose(`${code} is your Meldiq verification code`, {
      preview: "Enter this code in Meldiq to verify your email. It expires in 15 minutes.",
      heading: "Verify your email",
      paragraphs: ["Enter this code in the Meldiq app to finish setting up your account."],
      code: { value: code, note: "This code expires in 15 minutes." },
      footnote: "If you didn't create a Meldiq account, you can ignore this email.",
    }),
  resetPassword: (code: string): Omit<MailMessage, "to"> =>
    compose("Reset your Meldiq password", {
      preview: "Your password reset code. It expires in 15 minutes.",
      heading: "Reset your password",
      paragraphs: ["Enter this code in the Meldiq app, then choose a new password."],
      code: { value: code, note: "This code expires in 15 minutes." },
      footnote: "If you didn't ask to reset your password, ignore this email: your password stays the same.",
    }),
  recoveryEmail: (code: string): Omit<MailMessage, "to"> =>
    compose(`${code} confirms your new Meldiq email address`, {
      preview: "Confirm this address to finish recovering a Meldiq account.",
      heading: "Confirm your new email address",
      paragraphs: ["Someone is recovering a Meldiq account with a recovery code and wants to use this address from now on. To confirm, enter this code in the app."],
      code: { value: code, note: "This code expires in 30 minutes." },
      footnote: "If this wasn't you, ignore this email: nothing changes without this code.",
    }),
  /** API 0.46.0 (docs/ACCOUNT_SAFETY.md): changing the account's email from Settings. */
  emailChangeCode: (code: string): Omit<MailMessage, "to"> =>
    compose(`${code} confirms your new Meldiq email address`, {
      preview: "Confirm this address to make it your Meldiq account's email.",
      heading: "Confirm your new email address",
      paragraphs: ["You asked to use this address for your Meldiq account. To confirm, enter this code in Meldiq."],
      code: { value: code, note: "This code expires in 30 minutes." },
      footnote: "If this wasn't you, ignore this email: nothing changes without this code.",
    }),
  emailChangeInUse: (): Omit<MailMessage, "to"> =>
    compose("This address already has a Meldiq account", {
      preview: "Someone asked to move a Meldiq account to this address, but it already has one.",
      heading: "This address is already in use",
      paragraphs: ["Someone asked to use this address for their Meldiq account, but it already belongs to a Meldiq account, so nothing changed."],
      footnote: "If this was you, sign in to that account instead, or use a different address.",
    }),
  emailChanged: (newAddress: string): Omit<MailMessage, "to"> =>
    compose("Your Meldiq account's email was changed", {
      preview: "Your account now uses a different email address.",
      heading: "Your email address was changed",
      paragraphs: [`Your Meldiq account now uses ${newAddress}. Sign-in emails and codes go there from now on.`],
      footnote: "If this wasn't you, reset your password and contact Meldiq support straight away.",
    }),
  totpChanged: (on: boolean): Omit<MailMessage, "to"> =>
    compose(on ? "Two-step sign-in is on for your Meldiq account" : "Two-step sign-in was turned off", {
      preview: on ? "Signing in now also needs a code from your authenticator app." : "Signing in no longer needs a code from your authenticator app.",
      heading: on ? "Two-step sign-in is on" : "Two-step sign-in is off",
      paragraphs: [
        on
          ? "Signing in to your Meldiq account with your password now also needs a code from your authenticator app, or one of your backup codes."
          : "Signing in to your Meldiq account no longer needs a code from your authenticator app.",
      ],
      footnote: "If this wasn't you, reset your password and contact Meldiq support straight away.",
    }),
  recoveryCodesCreated: (): Omit<MailMessage, "to"> =>
    compose("New recovery codes for your Meldiq account", {
      preview: "New recovery codes were created, and older ones stopped working.",
      heading: "New recovery codes created",
      paragraphs: [
        "New recovery codes were just created for your Meldiq account, and any older ones stopped working.",
        "Keep them somewhere safe and offline: each one can get you back in once if you lose access to this email address.",
      ],
      footnote: "If this wasn't you, sign in, change your password and create new codes.",
    }),
  recoveryAddressChanged: (maskedNewEmail: string): Omit<MailMessage, "to"> =>
    compose("Your Meldiq account email was changed", {
      preview: "A recovery code was used to move your account to another address.",
      heading: "Your account email was changed",
      paragraphs: [`A recovery code was used to move your Meldiq account to **${maskedNewEmail}**, and its password was changed. Every signed-in app was signed out.`],
      footnote: "If this wasn't you, contact your workspace administrator right away.",
    }),
  recoveryFinished: (remaining: number): Omit<MailMessage, "to"> =>
    compose("Your Meldiq account is recovered", {
      preview: "Your account now uses this email address.",
      heading: "Your account is recovered",
      paragraphs: [
        "Your Meldiq account now uses this email address. Sign in with it and your new password.",
        `You have **${plural(remaining, "recovery code")}** left; create a new set from Settings › Account once you're signed in.`,
      ],
      footnote: "Your encrypted messages need your encryption recovery key or another signed-in phone; your email and password can't replace it.",
    }),
  keyUnlock: (code: string): Omit<MailMessage, "to"> =>
    compose(`${code} is your code to set up Meldiq on a new device`, {
      preview: "Enter this code on the new device to restore your encrypted messages. It expires in 15 minutes.",
      heading: "Set up a new device",
      paragraphs: [
        "Someone signed in to your Meldiq account with your password on a new device and asked to restore your encrypted messages there.",
        "If it was you, enter this code on that device.",
      ],
      code: { value: code, note: "This code expires in 15 minutes." },
      footnote: "If this wasn't you, don't share this code with anyone, and change your password now: without this code your messages stay locked.",
    }),
  alreadyRegistered: (): Omit<MailMessage, "to"> =>
    compose("Someone tried to create a Meldiq account with your email", {
      preview: "This address already has a Meldiq account.",
      heading: "This email already has an account",
      paragraphs: ["Someone tried to create a new Meldiq account with this email address, which already has an account. If it was you, sign in instead, or reset your password from the sign-in screen."],
      footnote: "If it wasn't you, you don't need to do anything.",
    }),
};
