"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Check } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

type Mode = "signin" | "signup";

export default function LoginPage() {
  const router = useRouter();
  const supabase = createClient();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    try {
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error) throw error;
        toast.success("Welcome back");
        // Login success → redirect to home
        router.replace("/");
        return;
      } else {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        toast.success("Account created. Please sign in.");
        // Signup success → switch to sign-in mode and clear password
        setMode("signin");
        setPassword("");
        // Brief delay so the toast is visible before the form swaps
        setTimeout(() => {
          const pwdInput = document.getElementById(
            "password",
          ) as HTMLInputElement | null;
          pwdInput?.focus();
        }, 100);
        return;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Authentication failed";
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="relative grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      {/* ============================================================
          Left panel — editorial brand showcase
          ============================================================ */}
      <aside className="relative hidden flex-col justify-between overflow-hidden border-r border-border bg-muted/40 p-12 lg:flex">
        {/* Brand mark */}
        <div className="relative z-10">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary font-display text-2xl font-bold text-primary-foreground">
              D
            </div>
            <span className="font-display text-2xl font-semibold tracking-tight">
              Datellix
            </span>
          </div>
        </div>

        {/* Headline */}
        <div className="relative z-10 max-w-md">
          <p className="mb-4 font-mono text-xs uppercase tracking-[0.3em] text-primary/80">
            v0 · skeleton
          </p>
          <h1 className="font-display text-5xl font-semibold leading-[1.05] tracking-tight">
            Ask your data
            <br />
            <span className="text-amber-gradient italic">anything.</span>
          </h1>
          <p className="mt-6 text-base leading-relaxed text-muted-foreground">
            A serverless AI analyst that turns plain-English questions into SQL,
            charts, and forecasts — running in isolated sandboxes, persisted in
            your own warehouse.
          </p>
        </div>

        {/* Feature ticks */}
        <ul className="relative z-10 space-y-2.5 text-sm text-muted-foreground">
          {[
            "Natural language → SQL → chart",
            "Daytona-isolated Python sandbox",
            "pgvector schema retrieval",
            "Streaming responses via SSE",
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
            <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary font-display text-xl font-bold text-primary-foreground">
              D
            </div>
            <span className="font-display text-xl font-semibold tracking-tight">
              Datellix
            </span>
          </div>

          {/* Header */}
          <div className="mb-8">
            <p className="mb-2 font-mono text-xs uppercase tracking-[0.25em] text-muted-foreground">
              {mode === "signin" ? "Sign in" : "Create account"}
            </p>
            <h2 className="font-display text-3xl font-semibold tracking-tight">
              {mode === "signin" ? (
                <>
                  Welcome <span className="italic text-primary">back.</span>
                </>
              ) : (
                <>
                  Start <span className="italic text-primary">analyzing.</span>
                </>
              )}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {mode === "signin"
                ? "Enter your credentials to access your sessions."
                : "Create an account to begin your first analysis."}
            </p>
          </div>

          <div className="divider-amber mb-8" />

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <label
                htmlFor="email"
                className="font-mono text-xs uppercase tracking-wider text-muted-foreground"
              >
                Email
              </label>
              <Input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                autoComplete="email"
                className="h-11 bg-card font-mono text-sm"
              />
            </div>

            <div className="space-y-2">
              <label
                htmlFor="password"
                className="font-mono text-xs uppercase tracking-wider text-muted-foreground"
              >
                Password
              </label>
              <Input
                id="password"
                type="password"
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 6 characters"
                autoComplete={
                  mode === "signin" ? "current-password" : "new-password"
                }
                className="h-11 bg-card font-mono text-sm"
              />
            </div>

            <Button
              type="submit"
              size="lg"
              disabled={loading}
              className="mt-2 h-11 w-full font-medium"
            >
              {loading ? (
                "Working…"
              ) : (
                <>
                  {mode === "signin" ? "Sign in" : "Create account"}
                  <ArrowRight className="h-4 w-4" />
                </>
              )}
            </Button>
          </form>

          <div className="divider-amber my-8" />

          {/* Mode toggle */}
          <p className="text-center text-sm text-muted-foreground">
            {mode === "signin" ? (
              <>
                No account yet?{" "}
                <button
                  type="button"
                  className="font-medium text-primary underline-offset-4 hover:underline"
                  onClick={() => {
                    setMode("signup");
                    setPassword("");
                  }}
                >
                  Create one
                </button>
              </>
            ) : (
              <>
                Already have an account?{" "}
                <button
                  type="button"
                  className="font-medium text-primary underline-offset-4 hover:underline"
                  onClick={() => {
                    setMode("signin");
                    setPassword("");
                  }}
                >
                  Sign in
                </button>
              </>
            )}
          </p>
        </div>
      </section>
    </main>
  );
}
