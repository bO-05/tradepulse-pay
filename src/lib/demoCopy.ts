/**
 * Display words for seeded demo records.
 *
 * The database keeps the names it was seeded with (the frozen Lopez rows are never rewritten), so
 * `(demo)`/`(seed)` suffixes, stand-in parentheticals and the old demo insurer are removed here, at
 * the last moment before they reach a screen. This is presentation only: ids, demo keys, money and
 * stored names never change.
 */

/** "Ortiz Plumbing (demo)" → "Ortiz Plumbing"; "Demo GC (TradePulse Pay demo)" → "Demo GC". */
export function demoDisplayName(name: string): string {
  const insurer = name.replace(/\bDemo Mutual Insurance Co\.?/gi, "Harbor Point Mutual");
  // Only a Demo/seed name loses its parentheticals. A real company named "Acme (Texas)" keeps them.
  if (!/\b(demo|seed)\b/i.test(name)) return insurer.replace(/\s+/g, " ").trim();
  let out = insurer;
  let previous = "";
  while (out !== previous) {
    previous = out;
    out = out.replace(/\s*\([^()]*\)\s*$/, "");
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * The persistent identity chip on a residential screen. The shared demo login keeps its stored
 * company name, but the chrome names the job the seat opens: the GC reads Bayview Remodeling and
 * the owner reads Dana Lopez. Presentation only — stored names, ids and audit rows are unchanged.
 */
export function demoIdentityName(name: string): string {
  const base = demoDisplayName(name);
  if (/^demo gc$/i.test(base)) return "Bayview Remodeling";
  if (/^demo owner$/i.test(base)) return "Dana Lopez";
  return base;
}

/** A seeded project title without the old demo-run prefix or the words "judge demo". */
export function demoProjectName(title: string): string {
  return title
    .trim()
    .replace(/\s*\((?:demo|seed)\)\s*$/i, "")
    .replace(/^Demo\s*·\s*/i, "")
    .replace(/\bTradePulse Pay judge demo\b/gi, "Sandbox run")
    .replace(/\bjudge demo\b/gi, "Sandbox run")
    .replace(/\bDemo\b/g, "Sandbox")
    .trim();
}

/** The seeded project description, without the old demo-run wording. */
export function demoProjectDescription(description: string): string {
  return description
    .trim()
    .replace(/\s*\((?:demo|seed)\)\s*$/i, "")
    .replace(/Demo data for the one-click TradePulse Pay judge demo/gi, "Sandbox data for a one-click guided run")
    .replace(/\bjudge demo\b/gi, "sandbox run")
    .replace(/\bDemo data\b/gi, "Sandbox data")
    .trim();
}

/** "Judge demo · Period 2 (billing agent)" → "Period 2 · billing agent". */
export function demoPeriodLabel(label: string): string {
  return label
    .trim()
    .replace(/^Judge demo\s*·\s*/i, "")
    .replace(/\s*\(honest\)\s*$/i, "")
    .replace(/\s*\(billing agent\)\s*$/i, " · billing agent")
    .trim();
}
