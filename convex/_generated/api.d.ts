/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agentLinks from "../agentLinks.js";
import type * as agentmailApi from "../agentmailApi.js";
import type * as agreements from "../agreements.js";
import type * as auditLogs from "../auditLogs.js";
import type * as auth from "../auth.js";
import type * as bids from "../bids.js";
import type * as contractorDiscovery from "../contractorDiscovery.js";
import type * as contractors from "../contractors.js";
import type * as coordination from "../coordination.js";
import type * as crons from "../crons.js";
import type * as demoAccounts from "../demoAccounts.js";
import type * as email from "../email.js";
import type * as emailActions from "../emailActions.js";
import type * as evals from "../evals.js";
import type * as files from "../files.js";
import type * as http from "../http.js";
import type * as lib_agentAccess from "../lib/agentAccess.js";
import type * as lib_money from "../lib/money.js";
import type * as lib_roles from "../lib/roles.js";
import type * as lib_testIdentity from "../lib/testIdentity.js";
import type * as llmRouter from "../llmRouter.js";
import type * as payments_captures from "../payments/captures.js";
import type * as payments_changeOrderDb from "../payments/changeOrderDb.js";
import type * as payments_changeOrderMath from "../payments/changeOrderMath.js";
import type * as payments_funding from "../payments/funding.js";
import type * as payments_invoices from "../payments/invoices.js";
import type * as payments_ledger from "../payments/ledger.js";
import type * as payments_ledgerTotals from "../payments/ledgerTotals.js";
import type * as payments_orders from "../payments/orders.js";
import type * as payments_payoutDb from "../payments/payoutDb.js";
import type * as payments_payoutMath from "../payments/payoutMath.js";
import type * as payments_payouts from "../payments/payouts.js";
import type * as payments_paypalAudit from "../payments/paypalAudit.js";
import type * as payments_paypalClient from "../payments/paypalClient.js";
import type * as payments_paypalSmoke from "../payments/paypalSmoke.js";
import type * as payments_release from "../payments/release.js";
import type * as payments_releaseDb from "../payments/releaseDb.js";
import type * as payments_retainage from "../payments/retainage.js";
import type * as payments_retainageDb from "../payments/retainageDb.js";
import type * as payments_sov from "../payments/sov.js";
import type * as payments_sovMath from "../payments/sovMath.js";
import type * as payments_stateMachine from "../payments/stateMachine.js";
import type * as payments_webhook from "../payments/webhook.js";
import type * as payments_webhookDb from "../payments/webhookDb.js";
import type * as payments_webhookEvents from "../payments/webhookEvents.js";
import type * as portal from "../portal.js";
import type * as profiles from "../profiles.js";
import type * as projects from "../projects.js";
import type * as realDocuments from "../realDocuments.js";
import type * as rfq from "../rfq.js";
import type * as rfqActions from "../rfqActions.js";
import type * as simulation from "../simulation.js";
import type * as terms from "../terms.js";
import type * as tradePackages from "../tradePackages.js";
import type * as validation from "../validation.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agentLinks: typeof agentLinks;
  agentmailApi: typeof agentmailApi;
  agreements: typeof agreements;
  auditLogs: typeof auditLogs;
  auth: typeof auth;
  bids: typeof bids;
  contractorDiscovery: typeof contractorDiscovery;
  contractors: typeof contractors;
  coordination: typeof coordination;
  crons: typeof crons;
  demoAccounts: typeof demoAccounts;
  email: typeof email;
  emailActions: typeof emailActions;
  evals: typeof evals;
  files: typeof files;
  http: typeof http;
  "lib/agentAccess": typeof lib_agentAccess;
  "lib/money": typeof lib_money;
  "lib/roles": typeof lib_roles;
  "lib/testIdentity": typeof lib_testIdentity;
  llmRouter: typeof llmRouter;
  "payments/captures": typeof payments_captures;
  "payments/changeOrderDb": typeof payments_changeOrderDb;
  "payments/changeOrderMath": typeof payments_changeOrderMath;
  "payments/funding": typeof payments_funding;
  "payments/invoices": typeof payments_invoices;
  "payments/ledger": typeof payments_ledger;
  "payments/ledgerTotals": typeof payments_ledgerTotals;
  "payments/orders": typeof payments_orders;
  "payments/payoutDb": typeof payments_payoutDb;
  "payments/payoutMath": typeof payments_payoutMath;
  "payments/payouts": typeof payments_payouts;
  "payments/paypalAudit": typeof payments_paypalAudit;
  "payments/paypalClient": typeof payments_paypalClient;
  "payments/paypalSmoke": typeof payments_paypalSmoke;
  "payments/release": typeof payments_release;
  "payments/releaseDb": typeof payments_releaseDb;
  "payments/retainage": typeof payments_retainage;
  "payments/retainageDb": typeof payments_retainageDb;
  "payments/sov": typeof payments_sov;
  "payments/sovMath": typeof payments_sovMath;
  "payments/stateMachine": typeof payments_stateMachine;
  "payments/webhook": typeof payments_webhook;
  "payments/webhookDb": typeof payments_webhookDb;
  "payments/webhookEvents": typeof payments_webhookEvents;
  portal: typeof portal;
  profiles: typeof profiles;
  projects: typeof projects;
  realDocuments: typeof realDocuments;
  rfq: typeof rfq;
  rfqActions: typeof rfqActions;
  simulation: typeof simulation;
  terms: typeof terms;
  tradePackages: typeof tradePackages;
  validation: typeof validation;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  staticHosting: import("@convex-dev/static-hosting/_generated/component.js").ComponentApi<"staticHosting">;
  firecrawl: import("@firecrawl/firecrawl-convex/_generated/component.js").ComponentApi<"firecrawl">;
  agentmail: import("@agentmail/convex/_generated/component.js").ComponentApi<"agentmail">;
};
