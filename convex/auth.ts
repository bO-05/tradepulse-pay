import { convexAuth, retrieveAccount } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";
import type { OIDCConfig } from "@auth/core/providers";
import { ConvexError } from "convex/values";
import { internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { rateLimiter } from "./authLimits";
import { AGENTID_PROVIDER_ID, agentIdProfile, syncAgentProfile, type AgentIdClaims } from "./lib/agentAccess";
import { emailLimitError, ResetPasswordCode, VerifyEmailCode } from "./lib/authEmail";
import {
  INVALID_EMAIL_MESSAGE,
  isLowercaseEmail,
  isUndeliverableEmail,
  isUnknownAccount,
  translateAuthError,
} from "./lib/authErrors";
import { validatePassword } from "./lib/passwordPolicy";

export function normalizeEmail(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase();
}

export const AGENTID_SCOPES = "openid email profile owner_profile owner_email";

/**
 * AgentID (custom OIDC) for subcontractor billing agents. Tokens are used once
 * at sign-in by Convex Auth and never stored; Convex Auth issues its own session.
 */
export const AgentID: OIDCConfig<AgentIdClaims> = {
  id: AGENTID_PROVIDER_ID,
  name: "AgentID",
  type: "oidc",
  issuer: "https://auth.agentid.com",
  clientId: process.env.AUTH_AGENTID_ID,
  clientSecret: process.env.AUTH_AGENTID_SECRET,
  authorization: { params: { scope: AGENTID_SCOPES } },
  checks: ["pkce", "state", "nonce"],
  client: { id_token_signed_response_alg: "ES256", token_endpoint_auth_method: "client_secret_basic" },
  // An agent inbox must never be merged into an existing (e.g. password) user by email.
  allowDangerousEmailAccountLinking: false,
  profile: (claims) => agentIdProfile(claims),
};

const PasswordProvider = Password<DataModel>({
  profile(params) {
    // The code paths use the raw params.email, so a mixed-case address would split the account
    // from its codes; clients lowercase before every call and anything else is refused here.
    if (!isLowercaseEmail(params.email)) {
      throw new ConvexError({ code: "INVALID_EMAIL", message: INVALID_EMAIL_MESSAGE });
    }
    const email = params.email;
    if (params.flow === "signUp") {
      if (isUndeliverableEmail(email)) {
        throw new ConvexError({ code: "INVALID_EMAIL", message: "Use an email address that can receive mail." });
      }
      const name = typeof params.name === "string" ? params.name.trim().slice(0, 120) : "";
      if (name.length === 0) {
        throw new ConvexError({ code: "INVALID_NAME", message: "Enter your name." });
      }
      return { email, name };
    }
    return { email };
  },
  validatePasswordRequirements: (password) => validatePassword(password),
  verify: VerifyEmailCode,
  reset: ResetPasswordCode,
});

// Wraps the provider's authorize step so library errors reach the client as readable ConvexErrors
// (see lib/authErrors.ts) and a reset for an unknown address looks exactly like a real one.
const providerOptions = (PasswordProvider as unknown as { options: { authorize: AuthorizeFn } }).options;
type AuthorizeFn = (params: Record<string, unknown>, ctx: any) => Promise<unknown>;
const innerAuthorize = providerOptions.authorize;

/**
 * Refuses a code send before the library stores a new code; refusing afterwards (in the sender)
 * would leave the user holding an emailed code the library has already replaced.
 */
async function refuseCodeSendUpFront(flow: string, params: Record<string, unknown>, ctx: any): Promise<void> {
  if (flow !== "signUp" && flow !== "signIn" && flow !== "reset") return;
  const email = params.email;
  if (!isLowercaseEmail(email)) return;
  const { account, limited } = await ctx.runQuery(internal.authLimits.preflightAuthEmail, { email });
  const wouldSend =
    flow === "reset" || (flow === "signUp" && account === "none") || (flow === "signIn" && account === "unverified");
  if (!wouldSend) return;
  const refusal = limited
    ? new ConvexError({ kind: "RateLimited", name: limited.name, retryAfter: limited.retryAfter })
    : (await ctx.runQuery(internal.emailOutbox.authCodeBudgetExhausted, {}))
      ? emailLimitError()
      : null;
  if (refusal === null) return;
  if (flow === "signIn") {
    // Check the password without issuing a code, so a wrong password still reads as invalid credentials.
    await retrieveAccount(ctx, { provider: "password", account: { id: email, secret: String(params.password ?? "") } });
  }
  throw refusal;
}

providerOptions.authorize = async (params, ctx) => {
  const flow = String(params.flow ?? "");
  try {
    await refuseCodeSendUpFront(flow, params, ctx);
    return await innerAuthorize(params, ctx);
  } catch (err) {
    if (flow === "reset" && isUnknownAccount(err)) {
      // Same limits and budget answer as a known address, but nothing is stored or sent.
      await ctx.runMutation(internal.authLimits.consumeAuthEmailSend, { email: String(params.email) });
      if (await ctx.runQuery(internal.emailOutbox.authCodeBudgetExhausted, {})) {
        throw emailLimitError();
      }
      return null;
    }
    throw translateAuthError(flow, err) ?? err;
  }
};

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [PasswordProvider, AgentID],
  // Note the library's spelling of the option name.
  signIn: { maxFailedAttempsPerHour: 10 },
  callbacks: {
    async afterUserCreatedOrUpdated(ctx, args) {
      if (args.provider.id === AGENTID_PROVIDER_ID) {
        await syncAgentProfile(ctx as unknown as MutationCtx, args.userId, { duringAgentIdSignIn: true });
        return;
      }
      if (args.type === "credentials" && args.existingUserId === null) {
        // Runs inside the auth:store mutation, so a throw rolls back the new user and account.
        await rateLimiter.limit(ctx, "signUpBurst", { throws: true });
        await rateLimiter.limit(ctx, "signUpGlobal", { throws: true });
      }
    },
  },
});
