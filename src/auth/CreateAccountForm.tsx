import { useAuthActions } from "@convex-dev/auth/react";
import { FormEvent, useRef, useState } from "react";
import { passwordProblem } from "../../convex/lib/passwordPolicy";
import { Button, focusFirstInvalid, TextInput } from "../ui";
import { AuthLayout, FormAlert, TextLink } from "./AuthLayout";
import { describeAuthError, emailInputProblem, normalizeEmailInput } from "./authErrors";
import { PasswordHints } from "./PasswordHints";
import { isCodeSendError, type VerifyScreen } from "./authScreens";

type FieldErrors = { name?: string; email?: string; password?: string };

export function CreateAccountForm({
  initialEmail = "",
  notice,
  onVerify,
  onBack,
  onForgot,
}: {
  initialEmail?: string;
  notice?: string;
  onVerify: (screen: VerifyScreen) => void;
  onBack: () => void;
  onForgot: (email: string) => void;
}) {
  const { signIn } = useAuthActions();
  const formRef = useRef<HTMLFormElement>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<{ message: string; exists: boolean } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    const next: FieldErrors = {
      name: name.trim().length === 0 ? "Enter your name." : undefined,
      email: emailInputProblem(email) ?? undefined,
      password: passwordProblem(password) ?? undefined,
    };
    setErrors(next);
    setFormError(null);
    if (next.name || next.email || next.password) {
      focusFirstInvalid(formRef.current);
      return;
    }
    const normalized = normalizeEmailInput(email);
    setSubmitting(true);
    try {
      const result = await signIn("password", { flow: "signUp", email: normalized, password, name: name.trim() });
      if (!result.signingIn) {
        onVerify({ kind: "verify", email: normalized, password, codeSent: true });
        return;
      }
    } catch (err) {
      const info = describeAuthError(err, "signUp");
      setSubmitting(false);
      if (isCodeSendError(info)) {
        onVerify({ kind: "verify", email: normalized, password, codeSent: false, error: info.message, retryAfterMs: info.retryAfterMs });
        return;
      }
      if (info.code === "WEAK_PASSWORD") setErrors({ password: info.message });
      else if (info.code === "INVALID_EMAIL") setErrors({ email: info.message });
      else if (info.code === "INVALID_NAME") setErrors({ name: info.message });
      else setFormError({ message: info.message, exists: info.code === "ACCOUNT_EXISTS" });
      focusFirstInvalid(formRef.current);
    }
  };

  return (
    <AuthLayout
      title="Create account"
      description="Set up a TradePulse Pay account for your company. We'll email you a code to verify your address."
      footer={
        <>
          Already have an account? <TextLink onClick={onBack}>Back to sign in</TextLink>
        </>
      }
    >
      <form ref={formRef} onSubmit={onSubmit} noValidate aria-label="Create account" className="space-y-4">
        {notice && <FormAlert tone="info">{notice}</FormAlert>}
        <TextInput
          id="signup-name"
          label="Your name"
          name="name"
          autoComplete="name"
          required
          value={name}
          onChange={setName}
          error={errors.name}
        />
        <TextInput
          id="signup-email"
          label="Work email"
          type="email"
          name="email"
          autoComplete="email"
          required
          value={email}
          onChange={setEmail}
          error={errors.email}
        />
        <div>
          <TextInput
            id="signup-password"
            label="Password"
            type="password"
            name="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={setPassword}
            error={errors.password}
          />
          <PasswordHints id="signup-password-hints" password={password} />
        </div>
        {formError && (
          <FormAlert>
            {formError.message}
            {formError.exists && (
              <span className="mt-2 flex gap-4">
                <TextLink onClick={onBack}>Sign in</TextLink>
                <TextLink onClick={() => onForgot(normalizeEmailInput(email))}>Reset password</TextLink>
              </span>
            )}
          </FormAlert>
        )}
        <Button type="submit" className="w-full" loading={submitting} loadingLabel="Creating account…">
          Create account
        </Button>
      </form>
    </AuthLayout>
  );
}
