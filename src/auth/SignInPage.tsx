import { useAuthActions } from "@convex-dev/auth/react";
import { FormEvent, useState } from "react";
import { Button, TextInput } from "../ui";
import { AgentIdButton } from "./AgentIdButton";
import { AuthLayout, FormAlert, TextLink } from "./AuthLayout";
import { describeAuthError, emailInputProblem, normalizeEmailInput } from "./authErrors";
import { isCodeSendError, type AuthScreen, type VerifyScreen } from "./authScreens";
import { CreateAccountForm } from "./CreateAccountForm";
import { ForgotPasswordForm } from "./ForgotPasswordForm";
import { VerifyEmailForm } from "./VerifyEmailForm";


/** Sign in, Create account, Verify email and Forgot password, all reachable from the sign-in page. */
export function SignInPage() {
  const [screen, setScreen] = useState<AuthScreen>({ kind: "signIn" });
  const toSignIn = (email?: string, notice?: string) => setScreen({ kind: "signIn", email, notice });

  if (screen.kind === "signUp") {
    return <CreateAccountForm onVerify={(next) => setScreen(next)} onBack={() => toSignIn()} onForgot={(email) => setScreen({ kind: "forgot", email })} />;
  }
  if (screen.kind === "verify") {
    return <VerifyEmailForm key={screen.email} screen={screen} onBack={() => toSignIn(screen.email)} />;
  }
  if (screen.kind === "forgot") {
    return <ForgotPasswordForm initialEmail={screen.email ?? ""} onBack={(email) => toSignIn(email)} />;
  }
  return (
    <SignInForm
      initialEmail={screen.email ?? ""}
      notice={screen.notice}
      onCreateAccount={() => setScreen({ kind: "signUp" })}
      onForgot={(email) => setScreen({ kind: "forgot", email })}
      onVerify={(next) => setScreen(next)}
    />
  );
}

function SignInForm({
  initialEmail,
  notice,
  onCreateAccount,
  onForgot,
  onVerify,
}: {
  initialEmail: string;
  notice?: string;
  onCreateAccount: () => void;
  onForgot: (email: string) => void;
  onVerify: (screen: VerifyScreen) => void;
}) {
  const { signIn } = useAuthActions();
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    const emailProblem = emailInputProblem(email);
    setEmailError(emailProblem);
    setPasswordError(password.length === 0 ? "Enter your password." : null);
    setError(null);
    if (emailProblem || password.length === 0) return;
    const normalized = normalizeEmailInput(email);
    setSubmitting(true);
    try {
      const result = await signIn("password", { email: normalized, password, flow: "signIn" });
      if (!result.signingIn) {
        onVerify({
          kind: "verify",
          email: normalized,
          password,
          codeSent: true,
          notice: "Your email isn't verified yet. We sent a new code.",
        });
        return;
      }
      // Signed in: the AuthGate replaces this page.
    } catch (err) {
      const info = describeAuthError(err, "signIn");
      if (isCodeSendError(info)) {
        onVerify({ kind: "verify", email: normalized, password, codeSent: false, error: info.message, retryAfterMs: info.retryAfterMs });
        return;
      }
      setError(info.message);
      setSubmitting(false);
    }
  };

  return (
    <AuthLayout
      title="Sign in"
      footer={
        <>
          New to TradePulse Pay? <TextLink onClick={onCreateAccount}>Create account</TextLink>
        </>
      }
    >
      <form onSubmit={onSubmit} noValidate aria-label="Sign in" className="space-y-4">
        {notice && <FormAlert tone="info">{notice}</FormAlert>}
        <TextInput
          id="signin-email"
          label="Email"
          type="email"
          name="email"
          autoComplete="username"
          required
          value={email}
          onChange={setEmail}
          error={emailError ?? undefined}
        />
        <div className="space-y-1">
          <TextInput
            id="signin-password"
            label="Password"
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={setPassword}
            error={passwordError ?? undefined}
          />
          <div className="text-right">
            <TextLink onClick={() => onForgot(email)}>Forgot password?</TextLink>
          </div>
        </div>
        {error && <FormAlert>{error}</FormAlert>}
        <Button type="submit" className="w-full" loading={submitting} loadingLabel="Signing in…">
          Sign in
        </Button>
        <div className="flex items-center gap-3 text-[11px] text-ink-subtle" aria-hidden="true">
          <span className="h-px flex-1 bg-line" />
          or, for subcontractor billing agents
          <span className="h-px flex-1 bg-line" />
        </div>
        <AgentIdButton />
      </form>
    </AuthLayout>
  );
}
