/**
 * Copy-integrity rules and rendered-text extraction shared by `leak-scan.mjs` and the
 * accessibility harness. Keeping one rule list means the two pragmatic gates cannot drift.
 */

export const RULES = [
  { id: "agent-id", label: "AgentID", re: /\bAgentID\b/g },
  { id: "stand-in", label: "stand-in", re: /\bstand-in\b/gi },
  { id: "guided-demo-driver", label: "Guided demo driver", re: /Guided demo driver/gi },
  { id: "fixture", label: "fixture", re: /\bfixture\b/gi },
  { id: "demo-suffix", label: "(demo)", re: /\(demo\)/gi },
  { id: "seed-suffix", label: "(seed)", re: /\(seed\)/gi },
  { id: "demo-mutual", label: "Demo Mutual Insurance Co.", re: /Demo Mutual Insurance Co\.?/gi },
  { id: "convex", label: "Convex", re: /\bConvex\b/gi },
  { id: "invalid-domain", label: "verify-required.invalid", re: /verify-required\.invalid/gi },
  { id: "rule-closeout", label: "closeoutWorkBeforeEarlierTranches", re: /closeoutWorkBeforeEarlierTranches/g },
  { id: "rule-ceiling", label: "trancheCeilingPctToDate", re: /trancheCeilingPctToDate/g },
  { id: "rule-exclusions", label: "excludedScopeNotes", re: /excludedScopeNotes/g },
  { id: "judge-demo-period", label: "Judge demo ·", re: /Judge demo\s*[·•]/gi },
  { id: "recovery-dev", label: "Recovery-dev", re: /Recovery-dev/gi },
  { id: "studio-license", label: "Studio license", re: /Studio license/gi },
  { id: "cron-actor", label: "Convex Automated Cron Engine", re: /Convex Automated Cron Engine/gi },
  { id: "cron-auditor", label: "Convex Compliance Auditor Cron", re: /Convex Compliance Auditor Cron/gi },
  { id: "kernel-browser", label: "KERNEL hosted browser", re: /KERNEL hosted browser/gi },
  { id: "system-actor", label: "internal system actor", re: /\bsystem:[a-z0-9-]+\b/g },
  { id: "env-name", label: "environment variable name", re: /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){1,}\b/g },
  { id: "record-id", label: "record or vendor id", re: /\b[a-z][a-z0-9]{31}\b/g },
  // An unmasked address is any full local part at an example.com domain.
  // Masked forms (sb-****@personal.example.com, [demo inbox]@example.com) do
  // not match because '*' and '[' are not local-part characters.
  { id: "example-address", label: "unmasked .example.com address", re: /\b[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)*example\.com\b/gi },
  // The a11y-and-copy feature adds the two seeded labels that leaked through the GC home's
  // collapsed money receipts: an internal A401 agreement id and an old judge-demo project title.
  { id: "demo-agreement", label: "seeded A401 agreement id", re: /\bA401-[A-Z0-9-]+\b/gi },
  { id: "judge-demo-title", label: "TradePulse Pay judge demo", re: /\bTradePulse Pay judge demo\b/gi },
  // The stored demo identities are presentation-mapped through demoIdentityName; the raw account
  // names must never reach a judge screen. Recorded audit history may quote them, and is reported
  // separately by the extractor rather than failed or rewritten.
  { id: "demo-gc-identity", label: "stored Demo GC identity", re: /\bDemo GC\b/g },
  { id: "demo-owner-identity", label: "stored Demo Owner identity", re: /\bDemo Owner\b/g },
  { id: "demo-sub-identity", label: "stored Demo Sub identity", re: /\bDemo Sub \d\b/g },
];

// Commit stamps are only a demo-flow concern; apply this rule to #/demo alone.
// Require at least one a-f letter so a plain date such as 20261108 is not a hit.
export const DEMO_COMMIT_RULE = { id: "demo-commit", label: "commit hash in demo flow", re: /\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g };

export function contextFor(text, index, length) {
  const start = Math.max(0, index - 70);
  const end = Math.min(text.length, index + length + 70);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

export function scanText(text, rules) {
  const hits = [];
  for (const rule of rules) {
    const re = new RegExp(rule.re.source, rule.re.flags);
    let match;
    while ((match = re.exec(text)) !== null) {
      hits.push({
        rule: rule.label,
        match: match[0],
        context: contextFor(text, match.index, match[0].length),
      });
      if (match[0] === "") re.lastIndex += 1;
    }
  }
  return hits;
}

/**
 * Runs in the browser. Walks rendered text nodes and returns app copy, quoted
 * recorded history, and the text skipped inside closed <details> elements. Any
 * text node with a closed <details> anywhere in its ancestor chain is skipped,
 * including that element's own <summary>, exactly as VAL-COPY-005 requires.
 */
export async function extractText(page) {
  return page.evaluate(() => {
    const root = document.querySelector("#workspace-main") ?? document.body;
    const app = [];
    const recorded = [];
    const skipped = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const el = node.parentElement;
        if (!el) return NodeFilter.FILTER_REJECT;
        if (el.closest("script,style,noscript,template,svg")) return NodeFilter.FILTER_REJECT;
        for (let n = el; n; n = n.parentElement) {
          if (n.tagName === "DETAILS" && !n.hasAttribute("open")) {
            skipped.push((node.textContent || "").trim().slice(0, 80));
            return NodeFilter.FILTER_REJECT;
          }
          if (n.hasAttribute("hidden")) return NodeFilter.FILTER_REJECT;
        }
        const visible =
          typeof el.checkVisibility === "function"
            ? el.checkVisibility({ checkVisibilityCSS: true })
            : el.getClientRects().length > 0;
        return visible ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    let node;
    while ((node = walker.nextNode())) {
      const value = (node.textContent || "").replace(/\s+/g, " ").trim();
      if (!value) continue;
      if (node.parentElement.closest("[data-recorded-history]")) recorded.push(value);
      else app.push(value);
    }
    return {
      hash: location.hash,
      appText: app.join(" ").replace(/\s+/g, " ").trim(),
      recordedText: recorded.join(" ").replace(/\s+/g, " ").trim(),
      recordedBlocks: [...root.querySelectorAll("[data-recorded-history]")].filter((el) => {
        if (el.closest("details:not([open])")) return false;
        return typeof el.checkVisibility === "function" ? el.checkVisibility() : el.getClientRects().length > 0;
      }).length,
      skippedInsideClosedDetails: skipped.length,
    };
  });
}

/**
 * Opens every disclosure on the screen except the contract-exempt manual block on `#/demo`.
 * Returns the number of disclosures opened so the run log can name the state it measured.
 */
export async function openDisclosures(page) {
  return page.evaluate(() => {
    let opened = 0;
    for (const details of document.querySelectorAll("details")) {
      if (details.getAttribute("data-testid") === "demo-manual-details") continue;
      if (details.open) continue;
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
      opened += 1;
    }
    return opened;
  });
}
