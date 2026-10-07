/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agentmailApi from "../agentmailApi.js";
import type * as agreements from "../agreements.js";
import type * as auditLogs from "../auditLogs.js";
import type * as bids from "../bids.js";
import type * as contractorDiscovery from "../contractorDiscovery.js";
import type * as contractors from "../contractors.js";
import type * as coordination from "../coordination.js";
import type * as crons from "../crons.js";
import type * as email from "../email.js";
import type * as emailActions from "../emailActions.js";
import type * as evals from "../evals.js";
import type * as files from "../files.js";
import type * as http from "../http.js";
import type * as lib_money from "../lib/money.js";
import type * as llmRouter from "../llmRouter.js";
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
  agentmailApi: typeof agentmailApi;
  agreements: typeof agreements;
  auditLogs: typeof auditLogs;
  bids: typeof bids;
  contractorDiscovery: typeof contractorDiscovery;
  contractors: typeof contractors;
  coordination: typeof coordination;
  crons: typeof crons;
  email: typeof email;
  emailActions: typeof emailActions;
  evals: typeof evals;
  files: typeof files;
  http: typeof http;
  "lib/money": typeof lib_money;
  llmRouter: typeof llmRouter;
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
