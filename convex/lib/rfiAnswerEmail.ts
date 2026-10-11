import { escapeHtml } from "./mailer";

export const RFI_ANSWER_MIN = 2;
export const RFI_ANSWER_MAX = 8000;

export type RfiAnswerEmailInput = {
  /** The GC-reviewed answer, sent exactly as typed. */
  answer: string;
  gcName: string;
  answeredByName: string;
  projectTitle: string;
  csiDivision: string;
  tradeName: string;
  ref?: string;
  inboundSubject: string;
};

export function cleanRfiAnswer(raw: string): string {
  return raw.replace(/\r\n/g, "\n").trim();
}

export function rfiAnswerSubject(inboundSubject: string, ref?: string): string {
  const base = inboundSubject.trim() || "Your pre-bid question";
  const withRe = /^re:/i.test(base) ? base : `Re: ${base}`;
  return ref && !withRe.includes(`[TP-${ref}]`) ? `${withRe} [TP-${ref}]` : withRe;
}

/** Plain text and HTML for the GC's RFI answer. The answer comes first and is never rewritten. */
export function buildRfiAnswerEmail(input: RfiAnswerEmailInput): { subject: string; text: string; html: string } {
  const footer = [
    "--",
    `${input.answeredByName}, ${input.gcName}`,
    `${input.projectTitle} · ${input.csiDivision} ${input.tradeName}`,
    ...(input.ref ? [`Reference [TP-${input.ref}]. Reply to this email with any further questions.`] : []),
    "Sent with TradePulse Pay",
  ];
  const text = `${input.answer}\n\n${footer.join("\n")}`;
  const paragraphs = escapeHtml(input.answer)
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 12px">${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
  const footerHtml = footer
    .slice(1)
    .map((line) => escapeHtml(line))
    .join("<br>");
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1f2937;line-height:1.5">${paragraphs}<p style="margin:16px 0 0;color:#6b7280;font-size:12px">${footerHtml}</p></div>`;
  return { subject: rfiAnswerSubject(input.inboundSubject, input.ref), text, html };
}
