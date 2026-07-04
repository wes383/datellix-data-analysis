"use client";

import { useState, useRef, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowRight, RotateCcw, CheckCircle2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { TurnstileWidget } from "@/components/auth/turnstile-widget";

type Mode = "signin" | "signup";
/** signup sub-steps */
type SignupStep = "form" | "turnstile" | "otp";

const INTER: React.CSSProperties = {
  fontFamily: '"Inter", system-ui, sans-serif',
};

export default function LoginPage() {
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
      toast.success("Welcome back");
      router.replace("/");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Authentication failed");
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
      toast.error("Please agree to the Terms of Service and Privacy Policy to continue.");
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
      toast.success("Verification code sent — check your inbox");
      setSignupStep("otp");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
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

      toast.success("Account created. Please sign in.");
      // Reset to sign-in
      setMode("signin");
      setSignupStep("form");
      setPassword("");
      setOtp("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
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

  return (
    <main className="relative grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      {/* ============================================================
          Left panel — editorial brand showcase
          ============================================================ */}
      <aside className="relative hidden flex-col justify-between overflow-hidden border-r border-border bg-muted/40 p-12 lg:flex">
        {/* Brand mark */}
        <div className="relative z-10">
          <div className="flex items-center gap-3">
            <span
              style={{
                fontFamily:
                  '"Plus Jakarta Sans", "Inter", system-ui, sans-serif',
              }}
              className="text-2xl font-semibold tracking-tight"
            >
              Datellix
            </span>
          </div>
        </div>

        {/* Headline */}
        <div className="relative z-10 max-w-md">
          <h1 className="font-display text-5xl font-semibold leading-[1.05] tracking-tight">
            Ask your data
            <br />
            <span className="text-amber-gradient">anything.</span>
          </h1>
          <p className="mt-6 text-base leading-relaxed text-muted-foreground">
            An AI analyst that turns plain-English questions into SQL, charts,
            and forecasts — running in isolated sandboxes, persisted in your own
            warehouse.
          </p>
        </div>

        {/* Feature ticks */}
        <ul className="relative z-10 space-y-2.5 text-sm text-muted-foreground">
          {[
            "Natural language → SQL → chart",
            "Isolated Python sandbox for code execution",
            "Multi-turn sessions with full history",
            "Connect your own data warehouse",
          ].map((feat) => (
            <li key={feat} className="flex items-center gap-3">
              <span className="text-primary">→</span>
              <span className="font-mono text-xs">{feat}</span>
            </li>
          ))}
        </ul>
      </aside>

      {/* ============================================================
          Right panel — auth form
          ============================================================ */}
      <section className="flex items-center justify-center px-6 py-12 sm:px-12">
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
                  Sign in
                </p>
                <h2 className="font-display text-3xl font-semibold tracking-tight">
                  Welcome <span className="text-primary">back.</span>
                </h2>
                <p className="mt-2 text-sm text-muted-foreground" style={INTER}>
                  Enter your credentials to access your sessions.
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
                    Email
                  </label>
                  <Input
                    id="signin-email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@company.com"
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
                    Password
                  </label>
                  <Input
                    id="signin-password"
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Your password"
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
                    "Signing in…"
                  ) : (
                    <>
                      Sign in
                      <ArrowRight className="h-4 w-4" />
                    </>
                  )}
                </Button>
              </form>

              <div className="divider-amber my-8" />

              <p className="text-center text-sm text-muted-foreground" style={INTER}>
                No account yet?{" "}
                <button
                  type="button"
                  className="font-medium text-primary underline-offset-4 hover:underline"
                  onClick={switchToSignUp}
                  style={INTER}
                >
                  Create one
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
                  Create account
                </p>
                <h2 className="font-display text-3xl font-semibold tracking-tight">
                  Start <span className="text-primary">analyzing.</span>
                </h2>
                <p className="mt-2 text-sm text-muted-foreground" style={INTER}>
                  Create an account to begin your first analysis.
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
                    Email
                  </label>
                  <Input
                    id="signup-email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@company.com"
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
                    Password
                  </label>
                  <Input
                    id="signup-password"
                    type="password"
                    required
                    minLength={6}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="At least 6 characters"
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
                    I have read and agree to the{" "}
                    <Link
                      href="/legal/terms"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-primary underline-offset-4 hover:underline"
                    >
                      Terms of Service
                    </Link>{" "}
                    and{" "}
                    <Link
                      href="/legal/privacy"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-primary underline-offset-4 hover:underline"
                    >
                      Privacy Policy
                    </Link>
                    .
                  </span>
                </label>

                <Button
                  type="submit"
                  size="lg"
                  disabled={!agreedToTerms}
                  className="mt-2 h-11 w-full font-medium"
                  style={INTER}
                >
                  Continue
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </form>

              <div className="divider-amber my-8" />

              <p className="text-center text-sm text-muted-foreground" style={INTER}>
                Already have an account?{" "}
                <button
                  type="button"
                  className="font-medium text-primary underline-offset-4 hover:underline"
                  onClick={switchToSignIn}
                  style={INTER}
                >
                  Sign in
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
                  Human verification
                </p>
                <h2 className="font-display text-3xl font-semibold tracking-tight">
                  Almost <span className="text-primary">there.</span>
                </h2>
                <p className="mt-2 text-sm text-muted-foreground" style={INTER}>
                  Complete the verification below to receive your code.
                </p>
              </div>

              <div className="divider-amber mb-8" />

              {loading ? (
                <div
                  className="flex items-center justify-center py-10 text-sm text-muted-foreground"
                  style={INTER}
                >
                  Sending verification code…
                </div>
              ) : (
                <div className="flex flex-col items-center gap-6">
                  <TurnstileWidget
                    siteKey={siteKey}
                    onSuccess={handleTurnstileSuccess}
                    onError={() => {
                      toast.error("Verification failed. Please try again.");
                      setSignupStep("form");
                    }}
                    onExpired={() => {
                      toast.error("Verification expired. Please try again.");
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
                  ← Back
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
                  Verify your email
                </p>
                <h2 className="font-display text-3xl font-semibold tracking-tight">
                  Check your <span className="text-primary">inbox.</span>
                </h2>
                <p className="mt-2 text-sm text-muted-foreground" style={INTER}>
                  We sent a 6-digit code to{" "}
                  <span className="font-medium text-foreground">{email}</span>.
                  It expires in 5 minutes.
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
                    Verification code
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
                    placeholder="123456"
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
                    "Verifying…"
                  ) : (
                    <>
                      Confirm &amp; create account
                      <CheckCircle2 className="h-4 w-4" />
                    </>
                  )}
                </Button>
              </form>

              <div className="divider-amber my-8" />

              <p className="text-center text-sm text-muted-foreground" style={INTER}>
                Didn&apos;t receive it?{" "}
                <button
                  type="button"
                  className="font-medium text-primary underline-offset-4 hover:underline"
                  onClick={goBackToForm}
                  style={INTER}
                >
                  <RotateCcw className="mr-1 inline h-3 w-3" />
                  Resend code
                </button>
              </p>
            </>
          )}
        </div>
      </section>
    </main>
  );
}
