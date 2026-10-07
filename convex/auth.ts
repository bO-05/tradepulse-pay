import { convexAuth } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";
import { ConvexError } from "convex/values";

export function normalizeEmail(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase();
}

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
  ],
});
