#!/usr/bin/env node
/**
 * Dev-only helper for mail.tm disposable inboxes (free, no API key). Used by workers and
 * validators as test recipients; every message they receive still costs one AgentMail send.
 * Holds no secrets: the throwaway mail.tm credentials it prints belong to the inbox it created.
 *
 *   node scripts/dev/mailtm.mjs create [--prefix tp-test]
 *       -> {"address","password"}
 *   node scripts/dev/mailtm.mjs wait --address A --password P [--subject TEXT] [--timeout 120] [--since ISO]
 *       -> newest matching message: {"id","from","subject","receivedAt","code","inviteLink","links","hasHtml","text"}
 *   node scripts/dev/mailtm.mjs list --address A --password P
 *       -> [{"id","from","subject","receivedAt"}]
 *
 * `code` is the first 8-digit number in the message, `inviteLink` the first `#/invite/<token>` URL.
 */

const API = "https://api.mail.tm";
const POLL_MS = 3000;

async function call(path, { method = "GET", body, token } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`mail.tm ${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

function members(data) {
  return Array.isArray(data) ? data : data?.["hydra:member"] ?? data?.member ?? [];
}

function randomString(length, alphabet = "abcdefghijkmnpqrstuvwxyz23456789") {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

export async function createInbox(prefix = "tp-test") {
  const domains = members(await call("/domains")).filter((d) => d.isActive !== false);
  if (domains.length === 0) throw new Error("mail.tm returned no active domain");
  const address = `${prefix}-${randomString(10)}@${domains[0].domain}`.toLowerCase();
  const password = randomString(20, "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789");
  await call("/accounts", { method: "POST", body: { address, password } });
  return { address, password };
}

export async function login(address, password) {
  const { token } = await call("/token", { method: "POST", body: { address, password } });
  return token;
}

export function extract(text, html = "") {
  const haystack = `${text ?? ""}\n${html ?? ""}`;
  const code = /\b(\d{8})\b/.exec(text ?? "")?.[1] ?? /\b(\d{8})\b/.exec(haystack)?.[1] ?? null;
  const links = [...new Set([...haystack.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0].replace(/&amp;/g, "&")))];
  const inviteLink = links.find((l) => /#\/invite\/[A-Za-z0-9_-]+/.test(l)) ?? null;
  return { code, inviteLink, links };
}

export async function listMessages(token) {
  return members(await call("/messages", { token })).map((m) => ({
    id: m.id,
    from: m.from?.address ? `${m.from.name ? `${m.from.name} ` : ""}<${m.from.address}>` : String(m.from ?? ""),
    subject: m.subject ?? "",
    receivedAt: m.createdAt,
  }));
}

export async function readMessage(token, id) {
  const m = await call(`/messages/${id}`, { token });
  const html = Array.isArray(m.html) ? m.html.join("\n") : m.html ?? "";
  return {
    id: m.id,
    from: m.from?.address ? `${m.from.name ? `${m.from.name} ` : ""}<${m.from.address}>` : "",
    subject: m.subject ?? "",
    receivedAt: m.createdAt,
    hasHtml: Boolean(html),
    text: m.text ?? "",
    ...extract(m.text ?? "", html),
  };
}

export async function waitForMessage({ address, password, subject, timeoutSec = 120, since }) {
  const token = await login(address, password);
  const sinceMs = since ? Date.parse(since) : 0;
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    const match = (await listMessages(token)).find(
      (m) => (!subject || m.subject.includes(subject)) && (!sinceMs || Date.parse(m.receivedAt) >= sinceMs)
    );
    if (match) return await readMessage(token, match.id);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error(`no matching message at ${address} within ${timeoutSec}s`);
}

function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") ? true : argv[++i];
  }
  return out;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const f = flags(rest);
  let result;
  if (command === "create") {
    result = await createInbox(f.prefix || "tp-test");
  } else if (command === "wait") {
    if (!f.address || !f.password) throw new Error("wait needs --address and --password");
    result = await waitForMessage({
      address: f.address,
      password: f.password,
      subject: f.subject,
      timeoutSec: Number(f.timeout ?? 120),
      since: f.since,
    });
  } else if (command === "list") {
    if (!f.address || !f.password) throw new Error("list needs --address and --password");
    result = await listMessages(await login(f.address, f.password));
  } else {
    console.error("usage: mailtm.mjs create [--prefix P] | wait --address A --password P [--subject S] [--timeout N] [--since ISO] | list --address A --password P");
    process.exit(2);
  }
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err?.message || String(err));
    process.exit(1);
  });
}
