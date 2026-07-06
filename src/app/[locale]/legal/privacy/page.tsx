import type { Metadata } from "next";
import { setRequestLocale, getTranslations } from "next-intl/server";
import { isLocale, type Locale } from "@/i18n/routing";

export const metadata: Metadata = {
  title: "Privacy Policy — Datellix",
  description: "Privacy Policy describing how Datellix collects, uses, and protects your data.",
};

interface PageProps {
  params: Promise<{ locale: string }>;
}

/**
 * Privacy Policy page.
 *
 * Rendered as a Server Component. Shares the /legal/layout.tsx document
 * shell. Content is plain semantic HTML with Tailwind typography utility
 * classes.
 *
 * Last updated: 2026-07-06.
 */
export default async function PrivacyPage({ params }: PageProps) {
  const { locale } = await params;
  if (isLocale(locale)) {
    setRequestLocale(locale as Locale);
  }
  const t = await getTranslations("Legal");
  return (
    <article className="space-y-8">
      <header className="space-y-2">
        <h1 className="font-display text-3xl font-semibold tracking-tight">
          {t("privacyTitle")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("privacyLastUpdated")}
        </p>
      </header>

      <div className="space-y-6 text-sm leading-relaxed text-foreground/90">
        <section className="space-y-3">
          <h2 className="font-display text-lg font-semibold tracking-tight">
            1. Introduction
          </h2>
          <p>
            Datellix (&ldquo;Datellix&rdquo;, &ldquo;we&rdquo;,
            &ldquo;us&rdquo;, or &ldquo;our&rdquo;) is an AI data
            analysis platform. This Privacy Policy explains how we collect,
            use, disclose, and safeguard your information when you use our
            website and services (the &ldquo;Service&rdquo;).
          </p>
          <p>
            We are committed to protecting your privacy and designed the
            Service with security-by-default principles: credentials are
            encrypted at rest with AES-256, all database tables are
            protected by Row Level Security, and SQL execution is
            restricted to read-only queries.
          </p>
          <p>
            By creating an account or using the Service, you consent to
            the data practices described in this Privacy Policy. If you
            do not agree with these practices, please do not use the
            Service.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-display text-lg font-semibold tracking-tight">
            2. Information We Collect
          </h2>

          <h3 className="font-medium">2.1 Account Information</h3>
          <p>
            When you register, we collect your email address and a
            password (stored as a salted hash by Supabase Auth). We never
            store passwords in plaintext. We also collect a verification
            code (OTP) sent to your email during signup to confirm email
            ownership; the OTP is stored in memory for at most 5 minutes
            and deleted immediately after use.
          </p>

          <h3 className="font-medium">2.2 User Content</h3>
          <p>
            &ldquo;User Content&rdquo; includes any data you upload to
            or connect through the Service:
          </p>
          <ul className="ml-6 list-disc space-y-1">
            <li>Uploaded files (CSV, Excel, Parquet, DuckDB, SQLite);</li>
            <li>
              Database connection configurations (host, port, database
              name, user, password) for PostgreSQL, MySQL, and BigQuery
              sources;
            </li>
            <li>
              Query results generated when you ask the AI agent
              questions;
            </li>
            <li>
              AI-generated artifacts (charts, tables, forecasts, code
              snippets, reports) produced during your sessions;
            </li>
            <li>
              Chat conversation history, including natural-language
              messages and agent reasoning.
            </li>
          </ul>
          <p>
            Uploaded files and database credentials are stored in our
            Supabase Postgres database and (for file content) in our
            object storage backend. Database credentials and storage
            keys are encrypted at rest with pgcrypto AES-256 before
            being written to the database. Only the last 4 characters
            of each secret are ever sent to the browser as a mask.
          </p>

          <h3 className="font-medium">2.3 Configuration Data</h3>
          <p>
            When you configure your own LLM provider (API key, model
            name, base URL) or object storage backend (S3 endpoint,
            access key, secret key), these credentials are encrypted at
            rest with AES-256 and stored in the
            <code className="mx-1 rounded bg-muted px-1.5 py-0.5 font-mono text-xs">user_settings</code>
            table. We never log or display full API keys after they are
            saved.
          </p>

          <h3 className="font-medium">2.4 Usage and Log Data</h3>
          <p>
            We automatically collect certain usage information when you
            use the Service, including:
          </p>
          <ul className="ml-6 list-disc space-y-1">
            <li>
              API request metadata (timestamps, IP addresses, request
              duration, status codes);
            </li>
            <li>
              Token usage and sandbox execution metrics (LLM tokens
              consumed, Python runtime duration) for usage tracking and
              billing;
            </li>
            <li>
              Authentication events (login, logout, OTP verification)
              for security auditing;
            </li>
            <li>
              Browser type, operating system, and referring URL
              collected via standard HTTP headers.
            </li>
          </ul>
          <p>
            Logs do not include the contents of your User Content
            unless you report a specific issue that requires us to
            inspect a failed request. Logs are retained for up to ninety
            (90) days.
          </p>
          <p>
            <strong>Rate limiting.</strong> We use your IP address as a
            sliding-window counter to enforce API rate limits. When
            Upstash Redis is configured (production deployments), the
            IP-derived counter key and timestamp entries are stored in
            Upstash Redis for up to twice the rate-limit window (e.g.
            10 minutes for a 5-minute OTP window, 2 minutes for the
            1-minute global API window). When Redis is not configured
            (local development), the counter is held in process memory
            and discarded on instance restart. The counter stores only
            the IP (or IP+email hash for OTP endpoints) and hit
            timestamps — never User Content.
          </p>

          <h3 className="font-medium">2.5 Schema Embeddings</h3>
          <p>
            To enable natural-language schema search, we generate vector
            embeddings of your connected data source schemas (table
            names, column names, descriptions) using an embedding model.
            These embeddings are stored in our database and associated
            with your account. They do not contain row-level data.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-display text-lg font-semibold tracking-tight">
            3. How We Use Your Information
          </h2>
          <p>We use your information to:</p>
          <ul className="ml-6 list-disc space-y-1">
            <li>Provide, operate, and maintain the Service;</li>
            <li>
              Authenticate your account and verify your email address
              during signup;
            </li>
            <li>
              Execute AI-generated SQL queries against your connected
              data sources and process the results;
            </li>
            <li>
              Run Python code in isolated sandboxes to perform
              statistical analysis, forecasting, and visualization;
            </li>
            <li>
              Transmit your questions and query results to your
              configured LLM provider for AI inference;
            </li>
            <li>
              Persist conversation history (LangGraph checkpoints) so
              you can resume sessions across page refreshes;
            </li>
            <li>
              Track usage (token consumption, sandbox execution time)
              for billing, quota enforcement, and resource planning;
            </li>
            <li>
              Detect, prevent, and respond to security incidents,
              fraud, or abuse;
            </li>
            <li>
              Send you transactional emails (verification codes,
              security alerts, and account-related notices);
            </li>
            <li>
              Comply with legal obligations and enforce our Terms of
              Service.
            </li>
          </ul>
          <p>
            We do not sell your personal information or User Content to
            third parties. We do not use your User Content to train our
            own AI models.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-display text-lg font-semibold tracking-tight">
            4. How We Share Your Information
          </h2>
          <p>
            We share your information only as described below, and only
            with service providers who are contractually bound to
            protect it.
          </p>

          <h3 className="font-medium">4.1 LLM Providers</h3>
          <p>
            When the AI agent processes your questions, your
            natural-language input, schema context, and query results
            are transmitted to the LLM provider you have configured
            (OpenAI, Anthropic, GLM, or any OpenAI-compatible endpoint).
            If you have not configured your own provider, the
            project-default provider is used. Your data is processed by
            these providers in accordance with their own privacy
            policies and terms of service. We encourage you to review
            the data retention and processing practices of your chosen
            provider.
          </p>

          <h3 className="font-medium">4.2 Infrastructure Providers</h3>
          <p>
            We use the following infrastructure providers to operate the
            Service. Each receives only the data necessary to perform
            its function:
          </p>
          <ul className="ml-6 list-disc space-y-1">
            <li>
              <strong>Supabase</strong> — authentication, database
              hosting, and vector embeddings. Receives your email,
              hashed password, and all stored User Content.
            </li>
            <li>
              <strong>Daytona</strong> — Python sandbox execution.
              Receives Python code and any data loaded into the sandbox
              (e.g., uploaded file contents, query results). Sandbox
              state is ephemeral and disposed after each ReAct turn.
            </li>
            <li>
              <strong>Vercel Blob / your S3-compatible backend</strong>
              — file storage. Receives uploaded file contents.
            </li>
            <li>
              <strong>Resend</strong> — transactional email. Receives
              your email address and the OTP code for delivery.
            </li>
            <li>
              <strong>Cloudflare</strong> — Turnstile bot protection.
              Receives a Turnstile token and your IP address for
              verification.
            </li>
            <li>
              <strong>Upstash Redis</strong> — rate limit counter store
              (production only). Receives an IP-derived identifier and
              hit timestamps to enforce API rate limits across serverless
              instances. Does not receive User Content.
            </li>
            <li>
              <strong>Vercel</strong> — application hosting. Receives
              request metadata and logs for operational monitoring.
            </li>
          </ul>

          <h3 className="font-medium">4.3 Legal Disclosures</h3>
          <p>
            We may disclose your information if required by law,
            subpoena, or court order, or if we believe in good faith
            that disclosure is necessary to protect our rights, your
            safety, or the safety of others.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-display text-lg font-semibold tracking-tight">
            5. Data Retention and Deletion
          </h2>
          <ul className="ml-6 list-disc space-y-1">
            <li>
              <strong>Account data</strong> (email, hashed password,
              settings) is retained for the lifetime of your account.
            </li>
            <li>
              <strong>User Content</strong> (sessions, artifacts, data
              source configurations, uploaded files) is retained until
              you delete it through the Service interface or until your
              account is terminated.
            </li>
            <li>
              <strong>Conversation memory</strong> (LangGraph
              checkpoints) persists across page refreshes for your
              convenience. Deleting a session also deletes its
              checkpoint. Deleting your account immediately removes all
              of your checkpoints across all sessions.
            </li>
            <li>
              <strong>Usage logs</strong> are retained for up to 90
              days for security and operational purposes.
            </li>
            <li>
              <strong>OTP codes</strong> are stored in memory for at
              most 5 minutes and deleted immediately after verification.
            </li>
            <li>
              <strong>Schema embeddings</strong> are deleted when you
              delete the associated data source.
            </li>
          </ul>
          <p>
            Upon account termination, we make commercially reasonable
            efforts to delete all your User Content within thirty (30)
            days, except where retention is required by law.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-display text-lg font-semibold tracking-tight">
            6. Data Security
          </h2>
          <p>
            We implement industry-standard security measures to protect
            your information:
          </p>
          <ul className="ml-6 list-disc space-y-1">
            <li>
              <strong>Encryption at rest</strong> — all database
              credentials, LLM API keys, and storage secrets are
              encrypted with pgcrypto AES-256 before being stored.
            </li>
            <li>
              <strong>Row Level Security</strong> — every database
              table is protected by Supabase RLS policies ensuring
              users can only access their own data.
            </li>
            <li>
              <strong>Read-only SQL enforcement</strong> — the AI agent
              can only execute SELECT/WITH queries. Write operations
              (INSERT, UPDATE, DELETE, DDL) are blocked by a keyword
              denylist and SQL validation.
            </li>
            <li>
              <strong>Isolated sandboxes</strong> — Python code runs in
              disposable Daytona containers that are destroyed after
              each ReAct turn. Sandboxes are not shared between users.
            </li>
            <li>
              <strong>Secret masking</strong> — only the last 4
              characters of API keys and passwords are ever sent to the
              browser.
            </li>
            <li>
              <strong>Bot protection</strong> — signup is protected by
              Cloudflare Turnstile to prevent automated abuse.
            </li>
            <li>
              <strong>TLS in transit</strong> — all network
              communication is encrypted with HTTPS/TLS.
            </li>
          </ul>
          <p>
            No security system is impenetrable. We cannot guarantee the
            absolute security of your data, but we are committed to
            promptly investigating and addressing any security incident.
            If you discover a vulnerability, please contact us at
            support@wesluma.com.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-display text-lg font-semibold tracking-tight">
            7. Your Privacy Rights
          </h2>
          <p>
            Depending on your jurisdiction, you may have the following
            rights regarding your personal data:
          </p>
          <ul className="ml-6 list-disc space-y-1">
            <li>
              <strong>Access</strong> — request a copy of the personal
              data we hold about you;
            </li>
            <li>
              <strong>Rectification</strong> — request correction of
              inaccurate or incomplete data;
            </li>
            <li>
              <strong>Erasure</strong> — request deletion of your
              personal data (also known as the &ldquo;right to be
              forgotten&rdquo;);
            </li>
            <li>
              <strong>Restriction</strong> — request that we limit the
              processing of your data;
            </li>
            <li>
              <strong>Data portability</strong> — request your data in
              a structured, machine-readable format;
            </li>
            <li>
              <strong>Objection</strong> — object to the processing of
              your data for specific purposes;
            </li>
            <li>
              <strong>Withdrawal of consent</strong> — withdraw
              consent for processing that relies on consent (though
              this may affect your ability to use the Service).
            </li>
          </ul>
          <p>
            To exercise your right to delete your account and all
            associated data, you can use the &ldquo;Delete account&rdquo;
            option in the Settings page — this takes effect immediately
            and does not require contacting us. For all other rights
            (access, rectification, restriction, portability, or
            objection), contact us at support@wesluma.com. We will
            respond within thirty (30) days, or as required by
            applicable law.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-display text-lg font-semibold tracking-tight">
            8. GDPR (European Economic Area and UK)
          </h2>
          <p>
            If you are located in the European Economic Area (EEA) or
            the United Kingdom, you have additional rights under the
            General Data Protection Regulation (GDPR) and the UK GDPR:
          </p>
          <ul className="ml-6 list-disc space-y-1">
            <li>
              The lawful basis for processing your account data and
              User Content is <strong>contractual necessity</strong>
              (Article 6(1)(b)) — we process this data to provide the
              Service you requested.
            </li>
            <li>
              The lawful basis for processing usage logs and analytics
              is <strong>legitimate interest</strong> (Article 6(1)(f))
              — security, fraud prevention, and service reliability.
            </li>
            <li>
              The lawful basis for sending verification emails is
              <strong>contractual necessity</strong> — required to
              authenticate your account.
            </li>
            <li>
              You have the right to lodge a complaint with your local
              data protection authority (e.g., the Information
              Commissioner&apos;s Office in the UK, or the relevant
              supervisory authority in your EU member state) if you
              believe we have violated your GDPR rights.
            </li>
          </ul>
          <p>
            We do not engage in automated decision-making or profiling
            with legal or similarly significant effects, except where
            required to provide the Service you requested.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-display text-lg font-semibold tracking-tight">
            9. CCPA (California)
          </h2>
          <p>
            If you are a California resident, you have additional rights
            under the California Consumer Privacy Act (CCPA) and the
            California Privacy Rights Act (CPRA):
          </p>
          <ul className="ml-6 list-disc space-y-1">
            <li>
              <strong>Right to know</strong> — request disclosure of
              the categories and specific pieces of personal
              information we collect, use, or share;
            </li>
            <li>
              <strong>Right to delete</strong> — request deletion of
              your personal information;
            </li>
            <li>
              <strong>Right to opt out</strong> — opt out of the
              &ldquo;sale&rdquo; or &ldquo;sharing&rdquo; of your
              personal information. We do not sell your personal
              information;
            </li>
            <li>
              <strong>Right to non-discrimination</strong> — we will
              not discriminate against you for exercising any CCPA
              right.
            </li>
          </ul>
          <p>
            To exercise CCPA rights, contact us at
            support@wesluma.com. We will verify your identity
            before responding to requests involving sensitive personal
            information.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-display text-lg font-semibold tracking-tight">
            10. International Data Transfers
          </h2>
          <p>
            Your information, including User Content, may be transferred
            to and processed in countries other than your country of
            residence, including the United States and any country where
            our infrastructure providers (Supabase, Daytona, Vercel,
            Resend, Cloudflare, Upstash, LLM providers) operate data
            centers.
          </p>
          <p>
            For transfers from the EEA, UK, or Switzerland, we rely on
            Standard Contractual Clauses (SCCs) or other appropriate
            safeguards as approved by the European Commission. By using
            the Service, you acknowledge and consent to these
            international transfers.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-display text-lg font-semibold tracking-tight">
            11. Cookies and Tracking
          </h2>
          <p>
            The Service uses essential cookies to maintain your
            authentication session with Supabase. These cookies are
            necessary for the Service to function and cannot be
            disabled if you wish to use the Service.
          </p>
          <p>
            We also set a <code className="mx-1 rounded bg-muted px-1.5 py-0.5 font-mono text-xs">NEXT_LOCALE</code>
            cookie (1-year lifetime) to remember your preferred
            interface language. On your first visit, the locale is
            negotiated from your browser&apos;s <code className="mx-1 rounded bg-muted px-1.5 py-0.5 font-mono text-xs">Accept-Language</code>
            header and the chosen value is persisted so subsequent
            visits skip negotiation. You can change your language at
            any time from Settings; doing so updates this cookie.
          </p>
          <p>
            We do not use advertising cookies, tracking pixels, or
            third-party analytics cookies. Cloudflare Turnstile may set
            a temporary cookie during the signup flow to prevent bot
            abuse; this cookie is session-scoped and does not track
            your activity across the site.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-display text-lg font-semibold tracking-tight">
            12. Children&apos;s Privacy
          </h2>
          <p>
            The Service is not directed to children under 18, and we do
            not knowingly collect personal information from children.
            If you believe we have collected information from a child,
            please contact us at support@wesluma.com, and we
            will promptly delete it.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-display text-lg font-semibold tracking-tight">
            13. Changes to This Privacy Policy
          </h2>
          <p>
            We may update this Privacy Policy from time to time. When
            we do, we will revise the &ldquo;Last updated&rdquo; date
            at the top of this page. For material changes that affect
            your privacy rights, we will provide notice through the
            Service or by email at least thirty (30) days before the
            changes take effect.
          </p>
          <p>
            Your continued use of the Service after the effective date
            of any changes constitutes acceptance of the revised
            Privacy Policy.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-display text-lg font-semibold tracking-tight">
            14. Contact Us
          </h2>
          <p>
            If you have any questions, concerns, or requests regarding
            this Privacy Policy or your personal data, please contact
            us at:
          </p>
          <p className="rounded-md border border-border bg-muted/30 p-3 font-mono text-xs">
            Datellix Privacy
            <br />
            Email: support@wesluma.com
          </p>
        </section>
      </div>
    </article>
  );
}
