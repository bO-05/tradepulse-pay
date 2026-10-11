export const PRODUCT_NAME = "TradePulse Pay";
export const REPOSITORY_URL = "https://github.com/bO-05/tradepulse-pay";

/** Body of GET /llms.txt: a plain description of the product and its public endpoints. */
export function buildLlmsTxt(siteUrl: string): string {
  return `# ${PRODUCT_NAME}
> Subcontractor procurement and payments for general contractors, subcontractors and owners.

## Overview
${PRODUCT_NAME} helps a general contractor run a project from bids to payment:
1. Trade packages by CSI MasterFormat division, with bidder invitations by email
2. Bid leveling that normalizes scope gaps, lead times and insurance deficiencies
3. AIA-style subcontract drafts generated from the awarded bid
4. Pay applications reviewed with AI assistance; people approve every dollar
5. Milestone funding, payouts and owner invoices through PayPal (sandbox)

Each company sees only its own projects. Subcontractors and owners see the projects they are invited to.

## Endpoints
- Web app: ${siteUrl}
- Health: GET ${siteUrl}/api/health
- This file: GET ${siteUrl}/llms.txt

## Source
- Repository: ${REPOSITORY_URL}

## Bid leveling formula
Leveled cost = base bid + scope gaps + lead-time penalty + insurance penalty - accepted alternates
`;
}
