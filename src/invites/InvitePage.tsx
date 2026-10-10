import { useAuthActions } from "@convex-dev/auth/react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "../../convex/_generated/api";
import { AuthLayout, FormAlert } from "../auth/AuthLayout";
import { myProjectHash } from "../auth/navigation";
import { SignInPage } from "../auth/SignInPage";
import { getErrorMessage } from "../lib/errors";
import { Button, DateText, TextInput } from "../ui";
import { forgetInviteToken, rememberInviteToken } from "./inviteSession";

function Status({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-surface-sunken text-ink flex items-center justify-center font-sans" role="status">
      {children}
    </div>
  );
}

function leaveTo(hash: string) {
  forgetInviteToken();
  window.location.hash = hash;
}

function DeadInvite({ title, body }: { title: string; body: string }) {
  useEffect(() => forgetInviteToken(), []);
  return (
    <AuthLayout title={title} description={body}>
      <a href="#/" onClick={() => forgetInviteToken()} className="text-sm font-medium text-emerald-300 hover:underline">
        Go to sign in
      </a>
    </AuthLayout>
  );
}

/**
 * `#/invite/<token>`: shown before the AuthGate so a signed-out visitor sees who invited them, can
 * create an account or sign in with the invited email, and then accept without losing the link.
 */
export function InvitePage({ token }: { token: string }) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const { signOut } = useAuthActions();
  const invite = useQuery(api.invites.getByToken, isLoading ? "skip" : { token });
  const accept = useMutation(api.invites.accept);
  const [authScreen, setAuthScreen] = useState<"signIn" | "signUp" | null>(null);
  const [companyName, setCompanyName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [accepted, setAccepted] = useState(false);

  useEffect(() => {
    if (token) rememberInviteToken(token);
  }, [token]);

  if (accepted) return <Status>Opening your workspace…</Status>;
  if (isLoading || invite === undefined) return <Status>Checking your invite…</Status>;

  if (invite.state === "invalid") {
    return <DeadInvite title="This invite link is not valid" body="Check that you copied the whole link, or ask the person who invited you for a new one." />;
  }
  if (invite.state === "no_longer_valid") {
    return (
      <DeadInvite
        title="This invite is no longer valid"
        body="It was already used, replaced by a newer link, or cancelled. Ask the person who invited you to send a new invite."
      />
    );
  }
  if (invite.expiresAt <= Date.now()) {
    return <DeadInvite title="This invite has expired" body={`This invite has expired — ask ${invite.inviterCompanyName} to resend it.`} />;
  }

  const role =
    invite.kind === "teammate" ? "as a teammate" : invite.kind === "sub" ? "as a subcontractor" : "as the owner";
  const summary = (
    <div className="space-y-3 text-sm">
      <p className="text-ink">
        <span className="font-semibold">{invite.inviterCompanyName}</span> invited you to join {role}
        {invite.projectTitle ? (
          <>
            {" "}
            on <span className="font-semibold">{invite.projectTitle}</span>
          </>
        ) : null}
        .
      </p>
      <dl className="divide-y divide-line rounded-lg border border-line">
        <div className="flex justify-between gap-3 px-3 py-2">
          <dt className="text-ink-subtle">Invited email</dt>
          <dd className="font-medium break-all text-right" data-testid="invite-email">
            {invite.email}
          </dd>
        </div>
        <div className="flex justify-between gap-3 px-3 py-2">
          <dt className="text-ink-subtle">From</dt>
          <dd className="text-right">{invite.inviterName}</dd>
        </div>
        {invite.kind !== "teammate" && invite.inviteeCompanyName ? (
          <div className="flex justify-between gap-3 px-3 py-2">
            <dt className="text-ink-subtle">Your company</dt>
            <dd className="text-right">{invite.inviteeCompanyName}</dd>
          </div>
        ) : null}
        <div className="flex justify-between gap-3 px-3 py-2">
          <dt className="text-ink-subtle">Expires</dt>
          <dd className="text-right">
            <DateText value={invite.expiresAt} />
          </dd>
        </div>
      </dl>
    </div>
  );

  if (!isAuthenticated || invite.viewer === null) {
    if (authScreen !== null) {
      return (
        <SignInPage
          key={authScreen}
          initialScreen={authScreen}
          initialEmail={invite.email}
          context={`Use ${invite.email} to accept the invite from ${invite.inviterCompanyName}.`}
        />
      );
    }
    return (
      <AuthLayout title="You're invited to TradePulse Pay">
        {summary}
        <div className="mt-5 flex flex-col gap-2">
          <Button onClick={() => setAuthScreen("signUp")}>Create account</Button>
          <Button variant="secondary" onClick={() => setAuthScreen("signIn")}>
            Sign in
          </Button>
        </div>
      </AuthLayout>
    );
  }

  const viewer = invite.viewer;
  const signOutButton = (label: string) => (
    <Button
      variant="secondary"
      onClick={() => {
        setAuthScreen(null);
        void signOut();
      }}
    >
      {label}
    </Button>
  );

  if (viewer.isAgent) {
    return (
      <AuthLayout title="Billing agents can't accept invites">
        {summary}
        <div className="mt-4 space-y-3">
          <FormAlert>AgentID billing agents cannot accept invitations. A person at the invited company must accept it.</FormAlert>
          {signOutButton("Sign out")}
        </div>
      </AuthLayout>
    );
  }

  if (!viewer.emailMatches) {
    return (
      <AuthLayout title="This invite is for a different email">
        <div className="space-y-4 text-sm">
          <p>
            This invite was sent to <span className="font-semibold">{invite.email}</span>. You're signed in as{" "}
            <span className="font-semibold">{viewer.email ?? "another account"}</span>.
          </p>
          <p className="text-ink-subtle">Sign out, then sign in or create an account with the invited email.</p>
          {signOutButton("Sign out and use a different account")}
        </div>
      </AuthLayout>
    );
  }

  const ownerName = companyName ?? invite.inviteeCompanyName ?? "";
  const needsOwnerName = invite.kind === "owner" && viewer.companyName === null;
  let joinNote: string;
  if (invite.kind === "teammate") joinNote = `You'll join ${invite.inviterCompanyName} as a member.`;
  else if (viewer.companyName) joinNote = `You'll join with your company, ${viewer.companyName}.`;
  else if (invite.kind === "sub")
    joinNote = `We'll create ${invite.inviteeCompanyName ?? "your company"} with you as its admin.`;
  else joinNote = "We'll create your owner company with you as its admin.";

  const onAccept = async () => {
    if (accepting) return;
    setError(null);
    setAccepting(true);
    try {
      const result = await accept({ token, ...(needsOwnerName ? { companyName: ownerName } : {}) });
      setAccepted(true);
      leaveTo(result.kind === "teammate" || result.projectId === null ? "#/" : myProjectHash(result.projectId));
    } catch (err) {
      setError(getErrorMessage(err, "We couldn't accept the invite. Try again."));
      setAccepting(false);
    }
  };

  return (
    <AuthLayout title="Accept your invite">
      {summary}
      <div className="mt-4 space-y-4">
        <p className="text-sm text-ink-subtle">{joinNote}</p>
        {needsOwnerName && (
          <TextInput
            id="invite-owner-company"
            label="Company name"
            required
            value={ownerName}
            onChange={setCompanyName}
            hint="You can change it now or later in Company settings."
          />
        )}
        {error && <FormAlert>{error}</FormAlert>}
        <Button className="w-full" onClick={() => void onAccept()} loading={accepting} loadingLabel="Accepting…">
          Accept invite
        </Button>
        <p className="text-center text-xs text-ink-subtle">
          Signed in as {viewer.email}.{" "}
          <button type="button" className="font-medium text-emerald-300 hover:underline" onClick={() => void signOut()}>
            Sign out
          </button>
        </p>
      </div>
    </AuthLayout>
  );
}
