/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agent_agentLoop from "../agent/agentLoop.js";
import type * as agent_payAgent from "../agent/payAgent.js";
import type * as agent_proposalDb from "../agent/proposalDb.js";
import type * as agent_proposalMath from "../agent/proposalMath.js";
import type * as agent_tools from "../agent/tools.js";
import type * as agentLinks from "../agentLinks.js";
import type * as agentmailApi from "../agentmailApi.js";
import type * as agentmailWebhook from "../agentmailWebhook.js";
import type * as agreementTerms from "../agreementTerms.js";
import type * as agreements from "../agreements.js";
import type * as auditLogs from "../auditLogs.js";
import type * as auth from "../auth.js";
import type * as authLimits from "../authLimits.js";
import type * as authMigrations from "../authMigrations.js";
import type * as bids from "../bids.js";
import type * as companies from "../companies.js";
import type * as contractorDiscovery from "../contractorDiscovery.js";
import type * as contractors from "../contractors.js";
import type * as coordination from "../coordination.js";
import type * as crons from "../crons.js";
import type * as dashboard_payAgent from "../dashboard/payAgent.js";
import type * as dashboard_queries from "../dashboard/queries.js";
import type * as dashboard_studioAccess from "../dashboard/studioAccess.js";
import type * as dashboard_studioAnthropic from "../dashboard/studioAnthropic.js";
import type * as dashboard_studioProxy from "../dashboard/studioProxy.js";
import type * as demoAccounts from "../demoAccounts.js";
import type * as devFixtures from "../devFixtures.js";
import type * as emailActions from "../emailActions.js";
import type * as emailOutbox from "../emailOutbox.js";
import type * as evals from "../evals.js";
import type * as files from "../files.js";
import type * as http from "../http.js";
import type * as inboundEmail from "../inboundEmail.js";
import type * as invites from "../invites.js";
import type * as judgeDemo_runs from "../judgeDemo/runs.js";
import type * as judgeDemo_scenario from "../judgeDemo/scenario.js";
import type * as kernel_cslb from "../kernel/cslb.js";
import type * as kernel_cslbFixtures from "../kernel/cslbFixtures.js";
import type * as kernel_demoLicenses from "../kernel/demoLicenses.js";
import type * as kernel_licenseCheck from "../kernel/licenseCheck.js";
import type * as kernel_licenseChecks from "../kernel/licenseChecks.js";
import type * as lib_agentAccess from "../lib/agentAccess.js";
import type * as lib_agentAudit from "../lib/agentAudit.js";
import type * as lib_agentLinkRemap from "../lib/agentLinkRemap.js";
import type * as lib_agreementDocument from "../lib/agreementDocument.js";
import type * as lib_agreementScope from "../lib/agreementScope.js";
import type * as lib_agreementTerms from "../lib/agreementTerms.js";
import type * as lib_aiLabels from "../lib/aiLabels.js";
import type * as lib_authEmail from "../lib/authEmail.js";
import type * as lib_authErrors from "../lib/authErrors.js";
import type * as lib_companyProfile from "../lib/companyProfile.js";
import type * as lib_demoPayees from "../lib/demoPayees.js";
import type * as lib_demoTenancy from "../lib/demoTenancy.js";
import type * as lib_gcCompanyName from "../lib/gcCompanyName.js";
import type * as lib_inviteRules from "../lib/inviteRules.js";
import type * as lib_llmsTxt from "../lib/llmsTxt.js";
import type * as lib_mailer from "../lib/mailer.js";
import type * as lib_money from "../lib/money.js";
import type * as lib_notify from "../lib/notify.js";
import type * as lib_ownerView from "../lib/ownerView.js";
import type * as lib_packageContractors from "../lib/packageContractors.js";
import type * as lib_passwordPolicy from "../lib/passwordPolicy.js";
import type * as lib_payee from "../lib/payee.js";
import type * as lib_projectScope from "../lib/projectScope.js";
import type * as lib_projectSetup from "../lib/projectSetup.js";
import type * as lib_projectSetupFixture from "../lib/projectSetupFixture.js";
import type * as lib_retainageRules from "../lib/retainageRules.js";
import type * as lib_roles from "../lib/roles.js";
import type * as lib_session from "../lib/session.js";
import type * as lib_subcontractText from "../lib/subcontractText.js";
import type * as lib_teammateInvites from "../lib/teammateInvites.js";
import type * as lib_tenancy from "../lib/tenancy.js";
import type * as lib_tenancyAction from "../lib/tenancyAction.js";
import type * as lib_tenancyFixtures from "../lib/tenancyFixtures.js";
import type * as lib_testIdentity from "../lib/testIdentity.js";
import type * as lib_vendorDirectory from "../lib/vendorDirectory.js";
import type * as lib_vendorMerge from "../lib/vendorMerge.js";
import type * as lib_vendorRules from "../lib/vendorRules.js";
import type * as lib_vendorSearch from "../lib/vendorSearch.js";
import type * as lib_venue from "../lib/venue.js";
import type * as llmRouter from "../llmRouter.js";
import type * as mailerDiagnostics from "../mailerDiagnostics.js";
import type * as notifications from "../notifications.js";
import type * as onboarding from "../onboarding.js";
import type * as partyProfiles from "../partyProfiles.js";
import type * as payApps_approvalAllocation from "../payApps/approvalAllocation.js";
import type * as payApps_backfill from "../payApps/backfill.js";
import type * as payApps_billingHistory from "../payApps/billingHistory.js";
import type * as payApps_proposalSync from "../payApps/proposalSync.js";
import type * as payApps_proposals from "../payApps/proposals.js";
import type * as payApps_review from "../payApps/review.js";
import type * as payApps_reviewContext from "../payApps/reviewContext.js";
import type * as payApps_reviewEvalFixtures from "../payApps/reviewEvalFixtures.js";
import type * as payApps_reviewEvals from "../payApps/reviewEvals.js";
import type * as payApps_reviewMath from "../payApps/reviewMath.js";
import type * as payApps_reviewModel from "../payApps/reviewModel.js";
import type * as payApps_reviewScenario from "../payApps/reviewScenario.js";
import type * as payApps_submit from "../payApps/submit.js";
import type * as payApps_validation from "../payApps/validation.js";
import type * as payee from "../payee.js";
import type * as payments_agreementHistory from "../payments/agreementHistory.js";
import type * as payments_captureSettlement from "../payments/captureSettlement.js";
import type * as payments_captures from "../payments/captures.js";
import type * as payments_cascade from "../payments/cascade.js";
import type * as payments_changeOrderDb from "../payments/changeOrderDb.js";
import type * as payments_changeOrderMath from "../payments/changeOrderMath.js";
import type * as payments_changeOrderRecipient from "../payments/changeOrderRecipient.js";
import type * as payments_funding from "../payments/funding.js";
import type * as payments_honorPeriod from "../payments/honorPeriod.js";
import type * as payments_honorPeriodDb from "../payments/honorPeriodDb.js";
import type * as payments_honorPeriodMath from "../payments/honorPeriodMath.js";
import type * as payments_invoices from "../payments/invoices.js";
import type * as payments_ledger from "../payments/ledger.js";
import type * as payments_ledgerTotals from "../payments/ledgerTotals.js";
import type * as payments_milestoneFundingState from "../payments/milestoneFundingState.js";
import type * as payments_orders from "../payments/orders.js";
import type * as payments_payoutDb from "../payments/payoutDb.js";
import type * as payments_payoutMath from "../payments/payoutMath.js";
import type * as payments_payoutRetry from "../payments/payoutRetry.js";
import type * as payments_payoutRetryDb from "../payments/payoutRetryDb.js";
import type * as payments_payoutRetryMath from "../payments/payoutRetryMath.js";
import type * as payments_payouts from "../payments/payouts.js";
import type * as payments_paypalAudit from "../payments/paypalAudit.js";
import type * as payments_paypalClient from "../payments/paypalClient.js";
import type * as payments_paypalSmoke from "../payments/paypalSmoke.js";
import type * as payments_reconcile from "../payments/reconcile.js";
import type * as payments_release from "../payments/release.js";
import type * as payments_releaseDb from "../payments/releaseDb.js";
import type * as payments_retainage from "../payments/retainage.js";
import type * as payments_retainageDb from "../payments/retainageDb.js";
import type * as payments_retainageMath from "../payments/retainageMath.js";
import type * as payments_sandboxTopUp from "../payments/sandboxTopUp.js";
import type * as payments_sandboxTopUpDb from "../payments/sandboxTopUpDb.js";
import type * as payments_sov from "../payments/sov.js";
import type * as payments_sovMath from "../payments/sovMath.js";
import type * as payments_stateMachine from "../payments/stateMachine.js";
import type * as payments_testing from "../payments/testing.js";
import type * as payments_webhook from "../payments/webhook.js";
import type * as payments_webhookDb from "../payments/webhookDb.js";
import type * as payments_webhookEvents from "../payments/webhookEvents.js";
import type * as people from "../people.js";
import type * as portal from "../portal.js";
import type * as procurementScenario from "../procurementScenario.js";
import type * as profiles from "../profiles.js";
import type * as projectFileDownload from "../projectFileDownload.js";
import type * as projects from "../projects.js";
import type * as realDocuments from "../realDocuments.js";
import type * as rfq from "../rfq.js";
import type * as rfqActions from "../rfqActions.js";
import type * as simulation from "../simulation.js";
import type * as tenancyAccess from "../tenancyAccess.js";
import type * as tenancyMigration from "../tenancyMigration.js";
import type * as terms from "../terms.js";
import type * as tradePackages from "../tradePackages.js";
import type * as validation from "../validation.js";
import type * as vendors from "../vendors.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "agent/agentLoop": typeof agent_agentLoop;
  "agent/payAgent": typeof agent_payAgent;
  "agent/proposalDb": typeof agent_proposalDb;
  "agent/proposalMath": typeof agent_proposalMath;
  "agent/tools": typeof agent_tools;
  agentLinks: typeof agentLinks;
  agentmailApi: typeof agentmailApi;
  agentmailWebhook: typeof agentmailWebhook;
  agreementTerms: typeof agreementTerms;
  agreements: typeof agreements;
  auditLogs: typeof auditLogs;
  auth: typeof auth;
  authLimits: typeof authLimits;
  authMigrations: typeof authMigrations;
  bids: typeof bids;
  companies: typeof companies;
  contractorDiscovery: typeof contractorDiscovery;
  contractors: typeof contractors;
  coordination: typeof coordination;
  crons: typeof crons;
  "dashboard/payAgent": typeof dashboard_payAgent;
  "dashboard/queries": typeof dashboard_queries;
  "dashboard/studioAccess": typeof dashboard_studioAccess;
  "dashboard/studioAnthropic": typeof dashboard_studioAnthropic;
  "dashboard/studioProxy": typeof dashboard_studioProxy;
  demoAccounts: typeof demoAccounts;
  devFixtures: typeof devFixtures;
  emailActions: typeof emailActions;
  emailOutbox: typeof emailOutbox;
  evals: typeof evals;
  files: typeof files;
  http: typeof http;
  inboundEmail: typeof inboundEmail;
  invites: typeof invites;
  "judgeDemo/runs": typeof judgeDemo_runs;
  "judgeDemo/scenario": typeof judgeDemo_scenario;
  "kernel/cslb": typeof kernel_cslb;
  "kernel/cslbFixtures": typeof kernel_cslbFixtures;
  "kernel/demoLicenses": typeof kernel_demoLicenses;
  "kernel/licenseCheck": typeof kernel_licenseCheck;
  "kernel/licenseChecks": typeof kernel_licenseChecks;
  "lib/agentAccess": typeof lib_agentAccess;
  "lib/agentAudit": typeof lib_agentAudit;
  "lib/agentLinkRemap": typeof lib_agentLinkRemap;
  "lib/agreementDocument": typeof lib_agreementDocument;
  "lib/agreementScope": typeof lib_agreementScope;
  "lib/agreementTerms": typeof lib_agreementTerms;
  "lib/aiLabels": typeof lib_aiLabels;
  "lib/authEmail": typeof lib_authEmail;
  "lib/authErrors": typeof lib_authErrors;
  "lib/companyProfile": typeof lib_companyProfile;
  "lib/demoPayees": typeof lib_demoPayees;
  "lib/demoTenancy": typeof lib_demoTenancy;
  "lib/gcCompanyName": typeof lib_gcCompanyName;
  "lib/inviteRules": typeof lib_inviteRules;
  "lib/llmsTxt": typeof lib_llmsTxt;
  "lib/mailer": typeof lib_mailer;
  "lib/money": typeof lib_money;
  "lib/notify": typeof lib_notify;
  "lib/ownerView": typeof lib_ownerView;
  "lib/packageContractors": typeof lib_packageContractors;
  "lib/passwordPolicy": typeof lib_passwordPolicy;
  "lib/payee": typeof lib_payee;
  "lib/projectScope": typeof lib_projectScope;
  "lib/projectSetup": typeof lib_projectSetup;
  "lib/projectSetupFixture": typeof lib_projectSetupFixture;
  "lib/retainageRules": typeof lib_retainageRules;
  "lib/roles": typeof lib_roles;
  "lib/session": typeof lib_session;
  "lib/subcontractText": typeof lib_subcontractText;
  "lib/teammateInvites": typeof lib_teammateInvites;
  "lib/tenancy": typeof lib_tenancy;
  "lib/tenancyAction": typeof lib_tenancyAction;
  "lib/tenancyFixtures": typeof lib_tenancyFixtures;
  "lib/testIdentity": typeof lib_testIdentity;
  "lib/vendorDirectory": typeof lib_vendorDirectory;
  "lib/vendorMerge": typeof lib_vendorMerge;
  "lib/vendorRules": typeof lib_vendorRules;
  "lib/vendorSearch": typeof lib_vendorSearch;
  "lib/venue": typeof lib_venue;
  llmRouter: typeof llmRouter;
  mailerDiagnostics: typeof mailerDiagnostics;
  notifications: typeof notifications;
  onboarding: typeof onboarding;
  partyProfiles: typeof partyProfiles;
  "payApps/approvalAllocation": typeof payApps_approvalAllocation;
  "payApps/backfill": typeof payApps_backfill;
  "payApps/billingHistory": typeof payApps_billingHistory;
  "payApps/proposalSync": typeof payApps_proposalSync;
  "payApps/proposals": typeof payApps_proposals;
  "payApps/review": typeof payApps_review;
  "payApps/reviewContext": typeof payApps_reviewContext;
  "payApps/reviewEvalFixtures": typeof payApps_reviewEvalFixtures;
  "payApps/reviewEvals": typeof payApps_reviewEvals;
  "payApps/reviewMath": typeof payApps_reviewMath;
  "payApps/reviewModel": typeof payApps_reviewModel;
  "payApps/reviewScenario": typeof payApps_reviewScenario;
  "payApps/submit": typeof payApps_submit;
  "payApps/validation": typeof payApps_validation;
  payee: typeof payee;
  "payments/agreementHistory": typeof payments_agreementHistory;
  "payments/captureSettlement": typeof payments_captureSettlement;
  "payments/captures": typeof payments_captures;
  "payments/cascade": typeof payments_cascade;
  "payments/changeOrderDb": typeof payments_changeOrderDb;
  "payments/changeOrderMath": typeof payments_changeOrderMath;
  "payments/changeOrderRecipient": typeof payments_changeOrderRecipient;
  "payments/funding": typeof payments_funding;
  "payments/honorPeriod": typeof payments_honorPeriod;
  "payments/honorPeriodDb": typeof payments_honorPeriodDb;
  "payments/honorPeriodMath": typeof payments_honorPeriodMath;
  "payments/invoices": typeof payments_invoices;
  "payments/ledger": typeof payments_ledger;
  "payments/ledgerTotals": typeof payments_ledgerTotals;
  "payments/milestoneFundingState": typeof payments_milestoneFundingState;
  "payments/orders": typeof payments_orders;
  "payments/payoutDb": typeof payments_payoutDb;
  "payments/payoutMath": typeof payments_payoutMath;
  "payments/payoutRetry": typeof payments_payoutRetry;
  "payments/payoutRetryDb": typeof payments_payoutRetryDb;
  "payments/payoutRetryMath": typeof payments_payoutRetryMath;
  "payments/payouts": typeof payments_payouts;
  "payments/paypalAudit": typeof payments_paypalAudit;
  "payments/paypalClient": typeof payments_paypalClient;
  "payments/paypalSmoke": typeof payments_paypalSmoke;
  "payments/reconcile": typeof payments_reconcile;
  "payments/release": typeof payments_release;
  "payments/releaseDb": typeof payments_releaseDb;
  "payments/retainage": typeof payments_retainage;
  "payments/retainageDb": typeof payments_retainageDb;
  "payments/retainageMath": typeof payments_retainageMath;
  "payments/sandboxTopUp": typeof payments_sandboxTopUp;
  "payments/sandboxTopUpDb": typeof payments_sandboxTopUpDb;
  "payments/sov": typeof payments_sov;
  "payments/sovMath": typeof payments_sovMath;
  "payments/stateMachine": typeof payments_stateMachine;
  "payments/testing": typeof payments_testing;
  "payments/webhook": typeof payments_webhook;
  "payments/webhookDb": typeof payments_webhookDb;
  "payments/webhookEvents": typeof payments_webhookEvents;
  people: typeof people;
  portal: typeof portal;
  procurementScenario: typeof procurementScenario;
  profiles: typeof profiles;
  projectFileDownload: typeof projectFileDownload;
  projects: typeof projects;
  realDocuments: typeof realDocuments;
  rfq: typeof rfq;
  rfqActions: typeof rfqActions;
  simulation: typeof simulation;
  tenancyAccess: typeof tenancyAccess;
  tenancyMigration: typeof tenancyMigration;
  terms: typeof terms;
  tradePackages: typeof tradePackages;
  validation: typeof validation;
  vendors: typeof vendors;
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
  rateLimiter: import("@convex-dev/rate-limiter/_generated/component.js").ComponentApi<"rateLimiter">;
};
