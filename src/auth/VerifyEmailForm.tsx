import { useAuthActions } from "@convex-dev/auth/react";
import { FormEvent, useState } from "react";
import { Button, TextInput } from "../ui";
import { AuthLayout, FormAlert, TextLink } from "./AuthLayout";
import { describeAuthError } from "./authErrors";
import type { VerifyScreen } from "./authScreens";
import { RESEND_COOLDOWN_MS, useCooldown } from "./useCooldown";

export function CodeInput({ id, value, onChange, error }: { id: string; value: string; onChange: (v: string) => void; error?: string }) {
  return (
    <TextInput
      id={id}
      label="8-digit code"
      name="code"
      inputMode="numeric"
      autoComplete="one-time-code"
      maxLength={8}
      required
      value={value}
      onChange={(raw) => onChange(raw.replace(/\D/g, "").slice(0, 8))}
      error={error}
    />
  );
}

export function codeProblem(code: string): string | null {
  return /^\d{8}$/.test(code) ? null : "Enter the 8-digit code from the email.";
}

export function VerifyEmailForm({ screen, onBack }: { screen: VerifyScreen; onBack: () => void }) {
  const { signIn } = useAuthActions();
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(screen.error ?? null);
  const [notice, setNotice] = useState<string | null>(
    screen.codeSent ? `${screen.notice ? `${screen.notice} ` : ""}We sent an 8-digit code to ${screen.email}.` : null,
  );
  const [verifying, setVerifying] = useState(false);
  const [resending, setResending] = useState(false);
  const cooldown = useCooldown(Date.now() + (screen.retryAfterMs ?? RESEND_COOLDOWN_MS));

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (verifying) return;
    const problem = codeProblem(code);
    setCodeError(problem);
    setError(null);
    if (problem) return;
    setVerifying(true);
    try {
      await signIn("password", { flow: "email-verification", email: screen.email, code });
      // Verified and signed in: the AuthGate takes over.
    } catch (err) {
      const info = describeAuthError(err, "verify");
      if (info.code === "INVALID_CODE") setCodeError(info.message);
      else setError(info.message);
      setVerifying(false);
    }
  };

  const onResend = async () => {
    if (resending || cooldown.secondsLeft > 0) return;
    setResending(true);
    setError(null);
    setNotice(null);
    try {
      const result = await signIn("password", { flow: "signIn", email: screen.email, password: screen.password });
      if (!result.signingIn) {
        setNotice(`We sent a new code to ${screen.email}. Codes from earlier emails no longer work.`);
        setCode("");
        setCodeError(null);
      }
      cooldown.restart();
    } catch (err) {
      const info = describeAuthError(err, "resend");
      setError(info.message);
      cooldown.restart(info.retryAfterMs ?? RESEND_COOLDOWN_MS);
    } finally {
      setResending(false);
    }
  };

  return (
    <AuthLayout
      title="Verify your email"
      description={
        <>
          Enter the code we emailed to <span className="font-medium text-ink">{screen.email}</span> from TradePulse Pay. It
          expires in 15 minutes.
        </>
      }
      footer={<TextLink onClick={onBack}>Back to sign in</TextLink>}
    >
      <form onSubmit={onSubmit} noValidate aria-label="Verify your email" className="space-y-4">
        {notice && <FormAlert tone="info">{notice}</FormAlert>}
        <CodeInput id="verify-code" value={code} onChange={setCode} error={codeError ?? undefined} />
        {error && <FormAlert>{error}</FormAlert>}
        <Button type="submit" className="w-full" loading={verifying} loadingLabel="Verifying…">
          Verify email
        </Button>
        <ResendButton secondsLeft={cooldown.secondsLeft} loading={resending} onClick={() => void onResend()} />
      </form>
    </AuthLayout>
  );
}

export function ResendButton({ secondsLeft, loading, onClick }: { secondsLeft: number; loading: boolean; onClick: () => void }) {
  return (
    <div className="text-center">
      <Button
        variant="ghost"
        size="sm"
        onClick={onClick}
        disabled={secondsLeft > 0}
        loading={loading}
        loadingLabel="Sending…"
        data-testid="resend-code"
      >
        {secondsLeft > 0 ? `Resend code in ${secondsLeft}s` : "Resend code"}
      </Button>
    </div>
  );
}
