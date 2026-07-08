"use client";

import { useState, useRef, type FormEvent } from "react";
import { Link, useRouter } from "@/i18n/navigation";
import { ArrowRight, RotateCcw, CheckCircle2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { TurnstileWidget } from "@/components/auth/turnstile-widget";
import { LanguageSwitcher } from "@/components/sidebar/language-switcher";
import { ThemeToggle } from "@/components/theme/theme-toggle";

type Mode = "signin" | "signup";
/** signup sub-steps */
type SignupStep = "form" | "turnstile" | "otp";

const INTER: React.CSSProperties = {
  fontFamily: '"Inter", system-ui, sans-serif',
};

export default function LoginPage() {
  const t = useTranslations("Login");
  const router = useRouter();
  const supabase = createClient();

  const [mode, setMode] = useState<Mode>("signin");
  const [signupStep, setSignupStep] = useState<SignupStep>("form");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [loading, setLoading] = useState(false);
  const [agreedToTerms, setAgreedToTerms] = useState(false);

  const turnstileResetRef = useRef<(() => void) | null>(null);

  /* ------------------------------------------------------------------ */
  /*  Sign-in                                                             */
  /* ------------------------------------------------------------------ */
  async function handleSignIn(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (error) throw error;
      toast.success(t("toastWelcomeBack"));
      router.replace("/");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("toastAuthFailed"));
    } finally {
      setLoading(false);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Sign-up — Step 1: submit form → show Turnstile                     */
  /* ------------------------------------------------------------------ */
  function handleSignUpFormSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!agreedToTerms) {
      toast.error(t("toastTermsRequired"));
      return;
    }
    setSignupStep("turnstile");
  }

  /* ------------------------------------------------------------------ */
  /*  Sign-up — Step 2: Turnstile success → send OTP                     */
  /* ------------------------------------------------------------------ */
  async function handleTurnstileSuccess(token: string) {
    setLoading(true);
    try {
      const res = await fetch("/api/auth/send-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, turnstileToken: token }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Failed to send verification code");
      }
      toast.success(t("toastOtpSent"));
      setSignupStep("otp");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("toastSomethingWrong"));
      // Reset the widget so the user can try again
      turnstileResetRef.current?.();
      setSignupStep("form");
    } finally {
      setLoading(false);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Sign-up — Step 3: verify OTP → create account                      */
  /* ------------------------------------------------------------------ */
  async function handleOtpSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    try {
      // Verify OTP
      const verifyRes = await fetch("/api/auth/verify-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code: otp }),
      });
      const verifyData = (await verifyRes.json()) as {
        ok?: boolean;
        error?: string;
      };
      if (!verifyRes.ok || !verifyData.ok) {
        throw new Error(verifyData.error ?? "Verification failed");
      }

      // Create Supabase account
      const { error: signUpError } = await supabase.auth.signUp({
        email,
        password,
      });
      if (signUpError) throw signUpError;

      toast.success(t("toastAccountCreated"));
      // Reset to sign-in
      setMode("signin");
      setSignupStep("form");
      setPassword("");
      setOtp("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("toastSomethingWrong"));
    } finally {
      setLoading(false);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Helpers                                                              */
  /* ------------------------------------------------------------------ */
  function switchToSignUp() {
    setMode("signup");
    setSignupStep("form");
    setPassword("");
    setOtp("");
  }

  function switchToSignIn() {
    setMode("signin");
    setSignupStep("form");
    setPassword("");
    setOtp("");
  }

  function goBackToForm() {
    setSignupStep("form");
    setOtp("");
    turnstileResetRef.current?.();
  }

  /* ------------------------------------------------------------------ */
  /*  Render                                                               */
  /* ------------------------------------------------------------------ */
  const siteKey = process.env.NEXT_PUBLIC_CLOUDFLARE_TURNSTILE_SITE_KEY ?? "";

  // Localised "terms" and "privacy" link labels are inlined into the
  // termsAgreement message via <termsLink>...</termsLink> tag syntax so
  // next-intl's t.rich() can wrap each clause in a <Link>.

  return (
    <main className="relative grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      {/* ============================================================
          Left panel — editorial brand showcase
          ============================================================ */}
      <aside className="relative hidden flex-col justify-between overflow-hidden border-r border-border bg-muted/40 p-12 lg:flex">
        {/* Brand mark + language switcher + theme toggle */}
        <div className="relative z-10 flex items-center justify-between">
          <span
            style={{
              fontFamily:
                '"Plus Jakarta Sans", "Inter", system-ui, sans-serif',
            }}
            className="text-2xl font-semibold tracking-tight"
          >
            Datellix
          </span>
          <div className="flex items-center gap-1">
            <ThemeToggle />
            <div className="w-40">
              <LanguageSwitcher variant="ghost" />
            </div>
          </div>
        </div>

        {/* Headline */}
        <div className="relative z-10 max-w-md">
          <h1 className="font-display text-5xl font-semibold leading-[1.05] tracking-tight">
            {t("headline")}
            <br />
            <span className="text-amber-gradient">{t("headlineAccent")}</span>
          </h1>
          <p className="mt-6 text-base leading-relaxed text-muted-foreground">
            {t("tagline")}
          </p>
        </div>

        {/* Feature ticks */}
        <ul className="relative z-10 space-y-2.5 text-sm text-muted-foreground">
          {[t("feature1"), t("feature2"), t("feature3"), t("feature4")].map(
            (feat) => (
              <li key={feat} className="flex items-center gap-3">
                <span className="text-primary">→</span>
                <span className="font-mono text-xs">{feat}</span>
              </li>
            ),
          )}
        </ul>
      </aside>

      {/* ============================================================
          Right panel — auth form
          ============================================================ */}
      <section className="relative flex items-center justify-center px-6 py-12 sm:px-12">
        {/* Mobile language switcher + theme toggle (top-right) */}
        <div className="absolute right-4 top-4 flex items-center gap-1 lg:hidden">
          <ThemeToggle />
          <div className="w-40">
            <LanguageSwitcher variant="ghost" />
          </div>
        </div>

        <div className="w-full max-w-sm animate-fade-up">
          {/* Mobile brand mark */}
          <div className="mb-10 flex items-center gap-3 lg:hidden">
            <span
              style={{
                fontFamily:
                  '"Plus Jakarta Sans", "Inter", system-ui, sans-serif',
              }}
              className="text-xl font-semibold tracking-tight"
            >
              Datellix
            </span>
          </div>

          {/* ---- SIGN IN ---- */}
          {mode === "signin" && (
            <>
              <div className="mb-8">
                <p
                  className="mb-2 text-xs uppercase tracking-[0.25em] text-muted-foreground"
                  style={INTER}
                >
                  {t("signinEyebrow")}
                </p>
                <h2 className="font-display text-3xl font-semibold tracking-tight">
                  {t("signinTitle")}{" "}
                  <span className="text-primary">{t("signinTitleAccent")}</span>
                </h2>
                <p className="mt-2 text-sm text-muted-foreground" style={INTER}>
                  {t("signinSubtitle")}
                </p>
              </div>

              <div className="divider-amber mb-8" />

              <form onSubmit={handleSignIn} className="space-y-5">
                <div className="space-y-2">
                  <label
                    htmlFor="signin-email"
                    className="text-xs uppercase tracking-wider text-muted-foreground"
                    style={INTER}
                  >
                    {t("labelEmail")}
                  </label>
                  <Input
                    id="signin-email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder={t("placeholderEmail")}
                    autoComplete="email"
                    className="h-11 bg-card text-sm"
                    style={INTER}
                  />
                </div>

                <div className="space-y-2">
                  <label
                    htmlFor="signin-password"
                    className="text-xs uppercase tracking-wider text-muted-foreground"
                    style={INTER}
                  >
                    {t("labelPassword")}
                  </label>
                  <Input
                    id="signin-password"
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={t("placeholderPassword")}
                    autoComplete="current-password"
                    className="h-11 bg-card text-sm"
                    style={INTER}
                  />
                </div>

                <Button
                  type="submit"
                  size="lg"
                  disabled={loading}
                  className="mt-2 h-11 w-full font-medium"
                  style={INTER}
                >
                  {loading ? (
                    t("signinButtonLoading")
                  ) : (
                    <>
                      {t("signinButton")}
                      <ArrowRight className="h-4 w-4" />
                    </>
                  )}
                </Button>
              </form>

              <div className="divider-amber my-8" />

              <p className="text-center text-sm text-muted-foreground" style={INTER}>
                {t("noAccountPrompt")}{" "}
                <button
                  type="button"
                  className="font-medium text-primary underline-offset-4 hover:underline"
                  onClick={switchToSignUp}
                  style={INTER}
                >
                  {t("noAccountCta")}
                </button>
              </p>
            </>
          )}

          {/* ---- SIGN UP — Step 1: Form ---- */}
          {mode === "signup" && signupStep === "form" && (
            <>
              <div className="mb-8">
                <p
                  className="mb-2 text-xs uppercase tracking-[0.25em] text-muted-foreground"
                  style={INTER}
                >
                  {t("signupEyebrow")}
                </p>
                <h2 className="font-display text-3xl font-semibold tracking-tight">
                  {t("signupTitle")}{" "}
                  <span className="text-primary">{t("signupTitleAccent")}</span>
                </h2>
                <p className="mt-2 text-sm text-muted-foreground" style={INTER}>
                  {t("signupSubtitle")}
                </p>
              </div>

              <div className="divider-amber mb-8" />

              <form onSubmit={handleSignUpFormSubmit} className="space-y-5">
                <div className="space-y-2">
                  <label
                    htmlFor="signup-email"
                    className="text-xs uppercase tracking-wider text-muted-foreground"
                    style={INTER}
                  >
                    {t("labelEmail")}
                  </label>
                  <Input
                    id="signup-email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder={t("placeholderEmail")}
                    autoComplete="email"
                    className="h-11 bg-card text-sm"
                    style={INTER}
                  />
                </div>

                <div className="space-y-2">
                  <label
                    htmlFor="signup-password"
                    className="text-xs uppercase tracking-wider text-muted-foreground"
                    style={INTER}
                  >
                    {t("labelPassword")}
                  </label>
                  <Input
                    id="signup-password"
                    type="password"
                    required
                    minLength={6}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={t("placeholderPasswordSignup")}
                    autoComplete="new-password"
                    className="h-11 bg-card text-sm"
                    style={INTER}
                  />
                </div>

                {/* Agreement checkbox — required before sending verification code */}
                <label
                  className="flex cursor-pointer items-start gap-2 text-xs text-muted-foreground"
                  style={INTER}
                >
                  <input
                    type="checkbox"
                    checked={agreedToTerms}
                    onChange={(e) => setAgreedToTerms(e.target.checked)}
                    className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded border-border accent-primary"
                  />
                  <span>
                    {/* Localised agreement sentence with embedded links.
                        The message uses <termsLink>...</termsLink> tag
                        syntax, so next-intl's t.rich() calls the function
                        with the inner text as `chunks`, which we wrap in a
                        <Link>. */}
                    {t.rich("termsAgreement", {
                      termsLink: (chunks) => (
                        <Link
                          href="/legal/terms"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-medium text-primary underline-offset-4 hover:underline"
                        >
                          {chunks}
                        </Link>
                      ),
                      privacyLink: (chunks) => (
                        <Link
                          href="/legal/privacy"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-medium text-primary underline-offset-4 hover:underline"
                        >
                          {chunks}
                        </Link>
                      ),
                    })}
                  </span>
                </label>

                <Button
                  type="submit"
                  size="lg"
                  disabled={!agreedToTerms}
                  className="mt-2 h-11 w-full font-medium"
                  style={INTER}
                >
                  {t("continue")}
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </form>

              <div className="divider-amber my-8" />

              <p className="text-center text-sm text-muted-foreground" style={INTER}>
                {t("haveAccountPrompt")}{" "}
                <button
                  type="button"
                  className="font-medium text-primary underline-offset-4 hover:underline"
                  onClick={switchToSignIn}
                  style={INTER}
                >
                  {t("haveAccountCta")}
                </button>
              </p>
            </>
          )}

          {/* ---- SIGN UP — Step 2: Turnstile ---- */}
          {mode === "signup" && signupStep === "turnstile" && (
            <>
              <div className="mb-8">
                <p
                  className="mb-2 text-xs uppercase tracking-[0.25em] text-muted-foreground"
                  style={INTER}
                >
                  {t("turnstileEyebrow")}
                </p>
                <h2 className="font-display text-3xl font-semibold tracking-tight">
                  {t("turnstileTitle")}{" "}
                  <span className="text-primary">{t("turnstileTitleAccent")}</span>
                </h2>
                <p className="mt-2 text-sm text-muted-foreground" style={INTER}>
                  {t("turnstileSubtitle")}
                </p>
              </div>

              <div className="divider-amber mb-8" />

              {loading ? (
                <div
                  className="flex items-center justify-center py-10 text-sm text-muted-foreground"
                  style={INTER}
                >
                  {t("turnstileSending")}
                </div>
              ) : (
                <div className="flex flex-col items-center gap-6">
                  <TurnstileWidget
                    siteKey={siteKey}
                    onSuccess={handleTurnstileSuccess}
                    onError={() => {
                      toast.error(t("toastTurnstileFailed"));
                      setSignupStep("form");
                    }}
                    onExpired={() => {
                      toast.error(t("toastTurnstileExpired"));
                      setSignupStep("form");
                    }}
                    resetRef={turnstileResetRef}
                  />
                </div>
              )}

              <div className="divider-amber my-8" />

              <p className="text-center text-sm text-muted-foreground" style={INTER}>
                <button
                  type="button"
                  className="font-medium text-primary underline-offset-4 hover:underline"
                  onClick={goBackToForm}
                  style={INTER}
                >
                  ← {t("back")}
                </button>
              </p>
            </>
          )}

          {/* ---- SIGN UP — Step 3: OTP ---- */}
          {mode === "signup" && signupStep === "otp" && (
            <>
              <div className="mb-8">
                <p
                  className="mb-2 text-xs uppercase tracking-[0.25em] text-muted-foreground"
                  style={INTER}
                >
                  {t("otpEyebrow")}
                </p>
                <h2 className="font-display text-3xl font-semibold tracking-tight">
                  {t("otpTitle")}{" "}
                  <span className="text-primary">{t("otpTitleAccent")}</span>
                </h2>
                <p className="mt-2 text-sm text-muted-foreground" style={INTER}>
                  {t.rich("otpSubtitle", {
                    email,
                    b: (chunks) => (
                      <span className="font-medium text-foreground">{chunks}</span>
                    ),
                  })}
                </p>
              </div>

              <div className="divider-amber mb-8" />

              <form onSubmit={handleOtpSubmit} className="space-y-5">
                <div className="space-y-2">
                  <label
                    htmlFor="otp-code"
                    className="text-xs uppercase tracking-wider text-muted-foreground"
                    style={INTER}
                  >
                    {t("labelVerificationCode")}
                  </label>
                  <Input
                    id="otp-code"
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    required
                    value={otp}
                    onChange={(e) =>
                      setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))
                    }
                    placeholder={t("placeholderOtp")}
                    autoComplete="one-time-code"
                    className="h-11 bg-card text-center text-lg tracking-[0.4em]"
                    style={INTER}
                  />
                </div>

                <Button
                  type="submit"
                  size="lg"
                  disabled={loading || otp.length < 6}
                  className="mt-2 h-11 w-full font-medium"
                  style={INTER}
                >
                  {loading ? (
                    t("signupButtonLoading")
                  ) : (
                    <>
                      {t("signupButton")}
                      <CheckCircle2 className="h-4 w-4" />
                    </>
                  )}
                </Button>
              </form>

              <div className="divider-amber my-8" />

              <p className="text-center text-sm text-muted-foreground" style={INTER}>
                <button
                  type="button"
                  className="font-medium text-primary underline-offset-4 hover:underline"
                  onClick={goBackToForm}
                  style={INTER}
                >
                  <RotateCcw className="mr-1 inline h-3 w-3" />
                  {t("resendCode")}
                </button>
              </p>
            </>
          )}
        </div>
      </section>
    </main>
  );
}
