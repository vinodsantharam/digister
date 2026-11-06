import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import nodemailer from "nodemailer";
import type { DigisterConfig } from "../config.js";
import { getPaths } from "../paths.js";

export type EmailConfig = DigisterConfig["email"];

export const PASSWORD_FILE = "smtp-password";
export const PASSWORD_ENV = "DIGISTER_SMTP_PASSWORD";

export interface EmailMessage {
  subject: string;
  html: string;
  text: string;
}

/** The subset of a nodemailer transport Digister uses; replaceable in tests. */
export interface MailTransport {
  sendMail(msg: { from: string; to: string; subject: string; html: string; text: string }): Promise<unknown>;
  verify(): Promise<unknown>;
}

export interface EmailDeps {
  transport?: MailTransport;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export const passwordFile = (home: string = getPaths().home): string => path.join(home, PASSWORD_FILE);

/**
 * The SMTP password: DIGISTER_SMTP_PASSWORD, else DIGISTER_HOME/smtp-password. The file must
 * not be readable by group or others. Throws a plain-English error when neither works.
 */
export function readSmtpPassword(deps: Pick<EmailDeps, "env" | "home"> = {}): string {
  const fromEnv = (deps.env ?? process.env)[PASSWORD_ENV];
  if (fromEnv?.trim()) return fromEnv.trim();
  const file = passwordFile(deps.home);
  if (!existsSync(file)) {
    throw new Error(`no SMTP password: save it to ${file} (chmod 600) or set ${PASSWORD_ENV}`);
  }
  if (process.platform !== "win32" && (statSync(file).mode & 0o077) !== 0) {
    throw new Error(`${file} is readable by other users; run: chmod 600 ${file}`);
  }
  const pw = readFileSync(file, "utf8").trim();
  if (!pw) throw new Error(`${file} is empty`);
  return pw;
}

const sender = (cfg: EmailConfig) => cfg.from || cfg.to;

export function createMailTransport(cfg: EmailConfig, deps: EmailDeps = {}): MailTransport {
  if (deps.transport) return deps.transport;
  return nodemailer.createTransport({
    host: cfg.smtp_host,
    port: cfg.smtp_port,
    secure: cfg.smtp_port === 465,
    auth: { user: cfg.smtp_user || cfg.to, pass: readSmtpPassword(deps) },
  });
}

/** `Digest Nov 6 · <first headline>`; the headline is cut to keep the subject short. */
export function digestSubject(date: string, headline?: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  const day = Number.isNaN(d.getTime())
    ? date
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const h = headline?.replace(/\s+/g, " ").trim();
  if (!h) return `Digest ${day}`;
  return `Digest ${day} · ${h.length > 80 ? `${h.slice(0, 79)}…` : h}`;
}

export async function sendDigestEmail(msg: EmailMessage, cfg: EmailConfig, deps: EmailDeps = {}): Promise<void> {
  const transport = createMailTransport(cfg, deps);
  await transport.sendMail({ from: sender(cfg), to: cfg.to, subject: msg.subject, html: msg.html, text: msg.text });
}

/** For `doctor`: password readable and the SMTP server accepts the login. Throws on failure. */
export async function verifyEmail(cfg: EmailConfig, deps: EmailDeps = {}): Promise<void> {
  await createMailTransport(cfg, deps).verify();
}
