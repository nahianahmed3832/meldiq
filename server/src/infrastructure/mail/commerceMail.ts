import { escapeHtml, MAIL_LOGO_CID, type RenderedMail } from "./mailTemplate.js";
import { MAIL_LOGO_PNG_BASE64 } from "./mailLogo.js";

/** Branded transactional messages with escaped customer notes and a server-created HTTPS action URL. */
export function commerceMail(heading: string, paragraphs: string[], action?: { text: string; url: string }): RenderedMail {
  if (action) {
    const url = new URL(action.url);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) throw new Error("Unsafe commerce mail action");
  }
  const h = escapeHtml;
  const button = action ? `<p style="margin:28px 0"><a href="${h(action.url)}" style="display:inline-block;background:#36c5ef;color:#081423;padding:14px 24px;border-radius:12px;font-weight:700;text-decoration:none">${h(action.text)}</a></p>` : "";
  return {
    text: [heading, ...paragraphs, ...(action ? [`${action.text}: ${action.url}`] : []), "Meldiq · Your space, your way"].join("\n\n"),
    html: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"></head><body style="margin:0;background:#101318;color:#edf1f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif"><div style="max-width:560px;margin:24px auto;padding:28px;border:1px solid #303640;border-radius:20px;background:#1c2129"><img src="cid:${MAIL_LOGO_CID}" width="38" height="38" alt="Meldiq"><h1 style="font-size:26px;line-height:1.25">${h(heading)}</h1>${paragraphs.map(p => `<p style="line-height:1.6;overflow-wrap:anywhere;white-space:pre-wrap">${h(p)}</p>`).join("")}${button}<p style="font-size:12px;color:#a7b1c1">Meldiq · Your space, your way</p></div></body></html>`,
    inline: [{ cid: MAIL_LOGO_CID, filename: "meldiq.png", contentType: "image/png", content: Buffer.from(MAIL_LOGO_PNG_BASE64, "base64") }],
  };
}
