import { useAuthActions } from "@convex-dev/auth/react";
import { FormEvent, useState } from "react";
import { passwordProblem } from "../../convex/lib/passwordPolicy";
import { Button, TextInput } from "../ui";
import { AuthLayout, FormAlert, TextLink } from "./AuthLayout";
import { describeAuthError, emailInputProblem, normalizeEmailInput } from "./authErrors";
import { PasswordHints } from "./PasswordHints";
import { RESEND_COOLDOWN_MS, useCooldown } from "./useCooldown";
import { CodeInput, codeProblem, ResendButton } from "./VerifyEmailForm";

// The same text for known and unknown addresses, so the screen never reveals whether an account exists.
export const neutralResetNotice = (email: string) =>
  `If an account exists for ${email}, we sent it an 8-digit code. The code expires in 15 minutes.`;

/** Forgot password: email → code + new password. Resetting ends the account's other sessions. */
export function ForgotPasswordForm({ initialEmail, onBack }: { initialEmail: string; onBack: (email?: string) => void }) {
  const [sentTo, setSentTo] = useState<{ email: string; notice: string } | null>(null);
  if (sentTo === null) {
    return <RequestStep initialEmail={initialEmail} onBack={onBack} onSent={(email, notice) => setSentTo({ email, notice })} />;
  }
  return <ResetStep email={sentTo.email} initialNotice={sentTo.notice} onBack={() => onBack(sentTo.email)} onChangeEmail={() => setSentTo(null)} />;
}

function RequestStep({
  initialEmail,
  onBack,
  onSent,
}: {
  initialEmail: string;
  onBack: (email?: string) => void;
  onSent: (email: string, notice: string) => void;
}) {
  const { signIn } = useAuthActions();
  const [email, setEmail] = useState(initialEmail);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    const problem = emailInputProblem(email);
    setEmailError(problem);
    setError(null);
    if (problem) return;
    const normalized = normalizeEmailInput(email);
    setSubmitting(true);
    try {
      await signIn("password", { flow: "reset", email: normalized });
      onSent(normalized, neutralResetNotice(normalized));
    } catch (err) {
      const info = describeAuthError(err, "resetRequest");
      setSubmitting(false);
      if (info.code === "RATE_LIMITED") {
        // A code was requested moments ago; let the person use it.
        onSent(normalized, `${neutralResetNotice(normalized)} ${info.message}`);
        return;
      }
      if (info.code === "INVALID_EMAIL") setEmailError(info.message);
      else setError(info.message);
    }
  };

  return (
    <AuthLayout
      title="Reset your password"
      description="Enter the email you sign in with. We'll email you a code to choose a new password."
      footer={<TextLink onClick={() => onBack(normalizeEmailInput(email) || undefined)}>Back to sign in</TextLink>}
    >
      <form onSubmit={onSubmit} noValidate aria-label="Reset your password" className="space-y-4">
        <TextInput
          id="forgot-email"
          label="Email"
          type="email"
          name="email"
          autoComplete="username"
          required
          value={email}
          onChange={setEmail}
          error={emailError ?? undefined}
        />
        {error && <FormAlert>{error}</FormAlert>}
        <Button type="submit" className="w-full" loading={submitting} loadingLabel="Sending code…">
          Send reset code
        </Button>
      </form>
    </AuthLayout>
  );
}

function ResetStep({
  email,
  initialNotice,
  onBack,
  onChangeEmail,
}: {
  email: string;
  initialNotice: string;
  onBack: () => void;
  onChangeEmail: () => void;
}) {
  const { signIn } = useAuthActions();
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(initialNotice);
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const cooldown = useCooldown(Date.now() + RESEND_COOLDOWN_MS);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    const cProblem = codeProblem(code);
    const pProblem = passwordProblem(password);
    setCodeError(cProblem);
    setPasswordError(pProblem);
    setError(null);
    if (cProblem || pProblem) return;
    setSubmitting(true);
    try {
      await signIn("password", { flow: "reset-verification", email, code, newPassword: password });
      // Signed in with the new password; other sessions were ended by the server.
    } catch (err) {
      const info = describeAuthError(err, "resetVerify");
      if (info.code === "INVALID_CODE") setCodeError(info.message);
      else if (info.code === "WEAK_PASSWORD") setPasswordError(info.message);
      else setError(info.message);
      setSubmitting(false);
    }
  };

  const onResend = async () => {
    if (resending || cooldown.secondsLeft > 0) return;
    setResending(true);
    setError(null);
    setNotice(null);
    try {
      await signIn("password", { flow: "reset", email });
      setNotice(`${neutralResetNotice(email)} Codes from earlier emails no longer work.`);
      cooldown.restart();
    } catch (err) {
      const info = describeAuthError(err, "resetRequest");
      setError(info.message);
      cooldown.restart(info.retryAfterMs ?? RESEND_COOLDOWN_MS);
    } finally {
      setResending(false);
    }
  };

  return (
    <AuthLayout
      title="Choose a new password"
      description={
        <>
          Resetting signs you out everywhere else.{" "}
          <TextLink onClick={onChangeEmail}>Use a different email</TextLink>
        </>
      }
      footer={<TextLink onClick={onBack}>Back to sign in</TextLink>}
    >
      <form onSubmit={onSubmit} noValidate aria-label="Choose a new password" className="space-y-4">
        {notice && <FormAlert tone="info">{notice}</FormAlert>}
        <CodeInput id="reset-code" value={code} onChange={setCode} error={codeError ?? undefined} />
        <div>
          <TextInput
            id="reset-password"
            label="New password"
            type="password"
            name="new-password"
            autoComplete="new-password"
            required
            value={password}
            onChange={setPassword}
            error={passwordError ?? undefined}
          />
          <PasswordHints id="reset-password-hints" password={password} />
        </div>
        {error && <FormAlert>{error}</FormAlert>}
        <Button type="submit" className="w-full" loading={submitting} loadingLabel="Saving…">
          Save new password
        </Button>
        <ResendButton secondsLeft={cooldown.secondsLeft} loading={resending} onClick={() => void onResend()} />
      </form>
    </AuthLayout>
  );
}
