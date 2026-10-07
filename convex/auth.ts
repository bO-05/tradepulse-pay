import { convexAuth } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";
import type { OIDCConfig } from "@auth/core/providers";
import { ConvexError } from "convex/values";
import type { MutationCtx } from "./_generated/server";
import { AGENTID_PROVIDER_ID, agentIdProfile, syncAgentProfile, type AgentIdClaims } from "./lib/agentAccess";

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

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    Password({
      profile(params) {
        // Accounts are provisioned by the demo seed (convex/demoAccounts.ts) or,
        // later, by GC invitation. Open self-registration would create users with
        // no role, so the public sign-up flow is refused.
        if (params.flow === "signUp") {
          throw new ConvexError("Self sign-up is disabled. Ask your general contractor for an account.");
        }
        return { email: normalizeEmail(params.email) };
      },
    }),
    AgentID,
  ],
  callbacks: {
    async afterUserCreatedOrUpdated(ctx, args) {
      if (args.provider.id !== AGENTID_PROVIDER_ID) return;
      await syncAgentProfile(ctx as unknown as MutationCtx, args.userId, { duringAgentIdSignIn: true });
    },
  },
});
