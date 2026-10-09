/**
 * The generated subcontract draft (AIA-style terms; not a form of the American Institute of
 * Architects). Every commercial figure comes from the agreement's stored terms and the project;
 * nothing here is a fixed default. Pure TS.
 */
import { formatCents } from "./money";
import {
  liquidatedDamagesText,
  paymentTermsText,
  retainageText,
  stateName,
  warrantyText,
  type AgreementTerms,
} from "./agreementTerms";
import { venueText, type Venue } from "./venue";

export type SubcontractTextInput = {
  agreementNumber: string;
  formattedDate: string;
  generalContractor: string;
  subName: string;
  contactEmail: string;
  /** e.g. "C-10 123456 (CSLB lookup: active, Oct 8, 2026)". */
  licenseLine: string;
  projectTitle: string;
  projectAddress: string;
  projectType: string;
  ownerName: string;
  csiDivision: string;
  tradeName: string;
  scopeSummary: string;
  mandatoryInclusions: string[];
  contractSumCents: number;
  terms: AgreementTerms;
  venue: Venue;
};

export function numberToWords(num: number): string {
  num = Math.round(num);
  const units = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  if (num >= 1_000_000_000) {
    const billions = Math.floor(num / 1_000_000_000);
    const rem = num % 1_000_000_000;
    return `${numberToWords(billions)} Billion` + (rem ? ` ${numberToWords(rem)}` : "");
  }
  if (num >= 1_000_000) {
    const millions = Math.floor(num / 1_000_000);
    const rem = num % 1_000_000;
    return `${numberToWords(millions)} Million` + (rem ? ` ${numberToWords(rem)}` : "");
  }
  if (num >= 1000) {
    const thousands = Math.floor(num / 1000);
    const rem = num % 1000;
    return `${numberToWords(thousands)} Thousand` + (rem ? ` ${numberToWords(rem)}` : "");
  }
  if (num >= 100) {
    const hundreds = Math.floor(num / 100);
    const rem = num % 100;
    return `${units[hundreds]} Hundred` + (rem ? ` ${numberToWords(rem)}` : "");
  }
  if (num >= 20) {
    const t = Math.floor(num / 10);
    const rem = num % 10;
    return tens[t] + (rem ? `-${units[rem]}` : "");
  }
  if (num > 0) return units[num];
  return "Zero";
}

function amountInWords(cents: number): string {
  const dollars = Math.floor(cents / 100);
  const rem = cents % 100;
  return `${numberToWords(dollars)} Dollars and ${rem.toString().padStart(2, "0")}/100`;
}

function paymentClause(terms: AgreementTerms): string {
  const p = terms.paymentTerms;
  return p.type === "pay_when_paid"
    ? `Payment terms: ${paymentTermsText(p)} after the Contractor receives payment from the Owner for the Subcontractor's Work.`
    : `Payment terms: ${paymentTermsText(p)} after the Contractor approves the Subcontractor's payment application.`;
}

export function buildSubcontractText(p: SubcontractTextInput): string {
  const t = p.terms;
  const ins = t.insurance;
  const governingName = stateName(t.governingState);
  const governing = governingName ? `the law of the State of ${governingName}` : "the law of the state in which the Project is located";
  const venue = venueText(p.venue);
  const contact = /\.invalid$/i.test(p.contactEmail)
    ? "not published; obtain the subcontractor's notice address before execution"
    : p.contactEmail;
  const inclusions = p.mandatoryInclusions.length
    ? p.mandatoryInclusions.map((inc) => `  [x] ${inc}`).join("\n")
    : "  (none listed in the trade package)";
  const ld =
    t.liquidatedDamagesCentsPerDay === undefined
      ? "Liquidated damages: none stated in this Subcontract."
      : `Liquidated damages: ${liquidatedDamagesText(t.liquidatedDamagesCentsPerDay)} for each calendar day of unexcused delay past Substantial Completion of the Subcontractor's Work.`;

  return `================================================================================
SUBCONTRACT AGREEMENT (AIA-STYLE TERMS) - GENERATED DRAFT
AGREEMENT NO: ${p.agreementNumber}
================================================================================

NOTICE: This draft is based on AIA-style terms and article structure. It is not
a form published or licensed by the American Institute of Architects. Review it
with counsel and complete any item marked [to be completed] before execution.
TradePulse Pay does not provide a signature service.

AGREEMENT made as of ${p.formattedDate}.

BETWEEN the Contractor:
  ${p.generalContractor}

and the Subcontractor:
  ${p.subName}
  Contact: ${contact}
  License: ${p.licenseLine}

The Project:
  ${p.projectTitle}
  Address: ${p.projectAddress}
  Type: ${p.projectType}
  Owner: ${p.ownerName}

--------------------------------------------------------------------------------
TABLE OF ARTICLES
--------------------------------------------------------------------------------
ARTICLE 1   THE SUBCONTRACT DOCUMENTS
ARTICLE 2   MUTUAL RIGHTS AND RESPONSIBILITIES
ARTICLE 3   CONTRACTOR OBLIGATIONS
ARTICLE 4   SUBCONTRACTOR WORK AND SCOPE INCLUSIONS
ARTICLE 5   CHANGES IN THE WORK
ARTICLE 6   SUBCONTRACT SUM, RETAINAGE AND PROGRESS PAYMENTS
ARTICLE 7   INSURANCE AND INDEMNIFICATION
ARTICLE 8   WARRANTY
ARTICLE 9   DISPUTE RESOLUTION AND GOVERNING LAW
ARTICLE 10  EXECUTION

--------------------------------------------------------------------------------
ARTICLE 1 - THE SUBCONTRACT DOCUMENTS
--------------------------------------------------------------------------------
1.1 The Subcontract Documents consist of:
  (1) this Subcontract Agreement;
  (2) the Prime Agreement between the Contractor and the Owner, to the extent it
      applies to the Subcontractor's Work;
  (3) CSI MasterFormat Division ${p.csiDivision} (${p.tradeName}) drawings and specifications;
  (4) addenda issued before execution; and
  (5) written pre-bid clarifications recorded in TradePulse Pay.

--------------------------------------------------------------------------------
ARTICLE 2 - MUTUAL RIGHTS AND RESPONSIBILITIES
--------------------------------------------------------------------------------
2.1 The Contractor and Subcontractor are mutually bound by this Agreement and, to
the extent the Prime Agreement applies to the Subcontractor's Work, the Contractor
assumes toward the Subcontractor the obligations the Owner assumes toward the
Contractor.

--------------------------------------------------------------------------------
ARTICLE 3 - CONTRACTOR OBLIGATIONS
--------------------------------------------------------------------------------
3.1 The Contractor shall coordinate the Work of all trades, provide site access
and administer requests for information through the TradePulse Pay project portal.

--------------------------------------------------------------------------------
ARTICLE 4 - SUBCONTRACTOR WORK AND SCOPE INCLUSIONS
--------------------------------------------------------------------------------
4.1 The Subcontractor shall furnish the labor, materials, equipment, services and
supervision necessary to complete Division ${p.csiDivision}: ${p.tradeName}.

Summary of scope:
${p.scopeSummary}

4.2 Scope inclusions. The Subcontract Sum includes:
${inclusions}

4.3 Exclusions or substitutions are recognized only when approved in an executed
Change Order.

--------------------------------------------------------------------------------
ARTICLE 5 - CHANGES IN THE WORK
--------------------------------------------------------------------------------
5.1 The Contractor may order changes within the general scope of this Subcontract
by written Change Order before the changed work begins.

--------------------------------------------------------------------------------
ARTICLE 6 - SUBCONTRACT SUM, RETAINAGE AND PROGRESS PAYMENTS
--------------------------------------------------------------------------------
6.1 The Contractor shall pay the Subcontractor the Subcontract Sum of
  ${formatCents(p.contractSumCents)} (${amountInWords(p.contractSumCents)}),
  subject to additions and deductions by Change Order.

6.2 Progress payments are made monthly on the approved schedule of values.
Retainage withheld from each progress payment: ${retainageText(t)}.
${paymentClause(t)}
${ld}

--------------------------------------------------------------------------------
ARTICLE 7 - INSURANCE AND INDEMNIFICATION
--------------------------------------------------------------------------------
7.1 Before starting the Work, the Subcontractor shall furnish a certificate of
insurance evidencing at least:
  - Commercial general liability: ${formatCents(ins.glEachOccurrenceCents)} each occurrence / ${formatCents(ins.glAggregateCents)} general aggregate
  - Automobile liability: ${formatCents(ins.autoCents)} combined single limit
  - Umbrella / excess liability: ${formatCents(ins.umbrellaCents)} each occurrence
  - Workers' compensation: ${ins.workersComp ? "statutory limits, with employer's liability" : "not required by this Subcontract"}
  - Additional insured: ${ins.additionalInsured ? "the Contractor and the Owner, on a primary and non-contributory basis" : "not required by this Subcontract"}

--------------------------------------------------------------------------------
ARTICLE 8 - WARRANTY
--------------------------------------------------------------------------------
8.1 The Subcontractor warrants that materials and equipment are new unless
otherwise specified and that the Work is free from defects and conforms to the
Division ${p.csiDivision} specifications.
Warranty period: ${warrantyText(t.warrantyMonths)} from Substantial Completion.

--------------------------------------------------------------------------------
ARTICLE 9 - DISPUTE RESOLUTION AND GOVERNING LAW
--------------------------------------------------------------------------------
9.1 Claims arising out of or related to this Subcontract are subject to mediation
as a condition precedent to binding arbitration administered by the American
Arbitration Association. Mediation and arbitration hearings shall be held in
${venue}.

9.2 Governing law: this Subcontract is governed by ${governing}.

--------------------------------------------------------------------------------
ARTICLE 10 - EXECUTION
--------------------------------------------------------------------------------
CONTRACTOR: ${p.generalContractor}
By: ___________________________________       Date: ____________________

SUBCONTRACTOR: ${p.subName}
By: ___________________________________       Date: ____________________

================================================================================
Prepared in TradePulse Pay for ${p.generalContractor}
AIA-style subcontract draft; not a form of the American Institute of Architects
================================================================================`;
}
