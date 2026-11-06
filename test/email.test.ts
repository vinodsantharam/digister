import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { digestSubject, readSmtpPassword, sendDigestEmail, type EmailConfig } from "../src/deliver/email.js";

const cfg: EmailConfig = {
  enabled: true, to: "me@example.com", from: "", smtp_host: "smtp.example.com", smtp_port: 465, smtp_user: "",
};

describe("readSmtpPassword", () => {
  const home = () => mkdtempSync(path.join(tmpdir(), "digister-mail-"));

  it("prefers the env var", () => {
    expect(readSmtpPassword({ env: { DIGISTER_SMTP_PASSWORD: " pw " }, home: home() })).toBe("pw");
  });

  it("reads a private password file and trims it", () => {
    const h = home();
    writeFileSync(path.join(h, "smtp-password"), "secret\n");
    chmodSync(path.join(h, "smtp-password"), 0o600);
    expect(readSmtpPassword({ env: {}, home: h })).toBe("secret");
  });

  it.skipIf(process.platform === "win32")("refuses a file other users can read", () => {
    const h = home();
    writeFileSync(path.join(h, "smtp-password"), "secret");
    chmodSync(path.join(h, "smtp-password"), 0o644);
    expect(() => readSmtpPassword({ env: {}, home: h })).toThrow(/chmod 600/);
  });

  it("explains what to do when there is no password", () => {
    expect(() => readSmtpPassword({ env: {}, home: home() })).toThrow(/smtp-password/);
  });
});

describe("digestSubject", () => {
  it("adds the first headline, cut to a readable length", () => {
    expect(digestSubject("2026-11-06")).toBe("Digest Nov 6");
    expect(digestSubject("2026-11-06", "  Qwen 4\nis out ")).toBe("Digest Nov 6 · Qwen 4 is out");
    expect(digestSubject("2026-11-06", "x".repeat(200)).length).toBeLessThan(100);
  });
});

describe("sendDigestEmail", () => {
  it("sends from the to address by default", async () => {
    const sent: unknown[] = [];
    await sendDigestEmail({ subject: "s", html: "<p>h</p>", text: "t" }, cfg, {
      transport: { sendMail: async (m) => void sent.push(m), verify: async () => true },
    });
    expect(sent).toEqual([{ from: "me@example.com", to: "me@example.com", subject: "s", html: "<p>h</p>", text: "t" }]);
  });
});
