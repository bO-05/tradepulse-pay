/**
 * The public residential-remodel pitch. Shown once above the sign-in card on the signed-out page and
 * again on the `#/demo` seat picker, so a judge or a remodeler sees who the product is for before a
 * sign-in form.
 */
export const RESIDENTIAL_OUTCOMES = [
  {
    title: "Catch overbilling early",
    detail: "Every line is checked against the schedule of values, exclusions and what was already paid.",
  },
  {
    title: "Decide with the evidence",
    detail: "See the contract, change orders, licence status and prior payments beside the amount you are approving.",
  },
  {
    title: "Keep a clean owner trail",
    detail: "Sub pay apps, owner invoices and PayPal receipts stay tied to one job ledger for the owner or lender.",
  },
] as const;

/**
 * The eyebrow and headline. `compact` keeps only those two lines, for the `#/demo` screen where
 * the role buttons have to be the first visible action on a 390px viewport.
 */
export function ResidentialHeroIntro({
  headingId = "landing-heading",
  level = 1,
  compact = false,
}: {
  headingId?: string;
  level?: 1 | 2;
  compact?: boolean;
}) {
  const Heading = level === 1 ? "h1" : "h2";
  return (
    <div className={compact ? "space-y-3" : "space-y-4"}>
      <p className="font-mono text-sm uppercase tracking-[0.2em] text-emerald-300">Progress draws for owner-run remodels</p>
      <Heading
        id={headingId}
        className={
          compact
            ? "max-w-xl font-serif text-4xl leading-[1.05] sm:text-6xl"
            : "max-w-xl font-serif text-5xl leading-[1.05] sm:text-6xl"
        }
      >
        Pay the right amount.<br /><span className="text-emerald-300">Keep the receipt.</span>
      </Heading>
      {compact ? null : (
        <p className="max-w-xl text-lg leading-relaxed text-slate-300">
          A sub sends a pay app. TradePulse checks the claim against the contract and schedule of values, shows
          you the backup, and waits for your approval before PayPal moves sandbox money.
        </p>
      )}
    </div>
  );
}

/** The three outcomes and the "who it is for" line, shared by the sign-in page and `#/demo`. */
export function ResidentialOutcomes() {
  return (
    <>
      <ul className="grid gap-3 sm:grid-cols-3" aria-label="What TradePulse Pay does">
        {RESIDENTIAL_OUTCOMES.map((item) => (
          <li key={item.title} className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
            <h2 className="text-sm font-semibold text-white">{item.title}</h2>
            <p className="mt-2 text-xs leading-relaxed text-slate-300">{item.detail}</p>
          </li>
        ))}
      </ul>
      <p className="max-w-xl text-sm leading-relaxed text-slate-300">
        Built for the GC running a handful of kitchens, additions and whole-home remodels — not a
        billion-dollar ERP. Rules compute the money. A model can explain the evidence. You make the call.
      </p>
    </>
  );
}

export function ResidentialHero({
  headingId = "landing-heading",
  level = 1,
  showDemoLink = false,
}: {
  headingId?: string;
  level?: 1 | 2;
  showDemoLink?: boolean;
}) {
  return (
    <section aria-labelledby={headingId} className="space-y-7">
      <ResidentialHeroIntro headingId={headingId} level={level} />
      <ResidentialOutcomes />
      {showDemoLink ? (
        <p className="text-sm">
          <a
            href="#/demo"
            className="inline-flex items-center gap-1 rounded text-emerald-300 underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300"
            data-testid="landing-open-demo"
          >
            Open the guided demo or inspect a settled run <span aria-hidden="true">→</span>
          </a>
        </p>
      ) : null}
    </section>
  );
}
