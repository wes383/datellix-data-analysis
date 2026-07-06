import type { Metadata } from "next";
import { setRequestLocale, getTranslations } from "next-intl/server";
import { isLocale, type Locale } from "@/i18n/routing";

export const metadata: Metadata = {
  title: "Terms of Service — Datellix",
  description: "Terms of Service governing the use of Datellix.",
};

interface PageProps {
  params: Promise<{ locale: string }>;
}

/**
 * Terms of Service page.
 *
 * Rendered as a Server Component (no client interactivity needed). The
 * document-style layout comes from /legal/layout.tsx. Content is plain
 * semantic HTML with Tailwind typography utility classes — no external
 * prose plugin is used.
 *
 * Last updated: 2026-07-06.
 */
export default async function TermsPage({ params }: PageProps) {
  const { locale } = await params;
  if (isLocale(locale)) {
    setRequestLocale(locale as Locale);
  }
  const t = await getTranslations("Legal");
  return (
    <article className="space-y-8">
      <header className="space-y-2">
        <h1 className="font-display text-3xl font-semibold tracking-tight">
          {t("termsTitle")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("termsLastUpdated")}
        </p>
      </header>

      <div className="space-y-6 text-sm leading-relaxed text-foreground/90">
        <section className="space-y-3">
          <h2 className="font-display text-lg font-semibold tracking-tight">
            1. Acceptance of Terms
          </h2>
          <p>
            Welcome to Datellix (&ldquo;Datellix&rdquo;, &ldquo;we&rdquo;,
            &ldquo;us&rdquo;, or &ldquo;our&rdquo;). By creating an account,
            accessing, or using the Datellix platform, website, or any
            related services (collectively, the &ldquo;Service&rdquo;), you
            agree to be bound by these Terms of Service (the
            &ldquo;Terms&rdquo;) and our Privacy Policy, which is
            incorporated herein by reference. If you do not agree to these
            Terms, you must not access or use the Service.
          </p>
          <p>
            You represent and warrant that you are at least 18 years of age
            and have the legal capacity to enter into these Terms. If you
            are using the Service on behalf of an organization, you
            represent that you have authority to bind that organization to
            these Terms.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-display text-lg font-semibold tracking-tight">
            2. Description of Service
          </h2>
          <p>
            Datellix is an AI data analysis platform that enables
            users to connect data sources (including PostgreSQL, MySQL,
            BigQuery, and uploaded files), ask questions in natural
            language, and receive AI-generated SQL queries, charts,
            forecasts, statistical analyses, and narrative reports. The
            Service executes user-initiated queries against connected data
            sources and runs Python code in isolated sandbox environments
            to perform advanced analytics.
          </p>
          <p>
            We reserve the right to modify, suspend, or discontinue the
            Service, or any feature thereof, at any time with or without
            notice. We will not be liable to you or any third party for
            any such modification, suspension, or discontinuance.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-display text-lg font-semibold tracking-tight">
            3. Account Registration and Security
          </h2>
          <p>
            To access the Service, you must register for an account using
            a valid email address and password. You agree to provide
            accurate, current, and complete information during registration
            and to update such information to keep it accurate.
          </p>
          <p>
            You are solely responsible for maintaining the confidentiality
            of your account credentials and for all activities that occur
            under your account. You agree to notify us immediately of any
            unauthorized use of your account or any other security breach.
            We will not be liable for any loss or damage arising from your
            failure to comply with this obligation.
          </p>
          <p>
            You may configure your own Large Language Model (LLM) provider
            credentials and object storage backend within the Service.
            Such credentials are encrypted at rest using AES-256, but you
            are responsible for the security of those credentials and for
            any usage charges incurred by your configured providers.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-display text-lg font-semibold tracking-tight">
            4. Acceptable Use
          </h2>
          <p>You agree not to:</p>
          <ul className="ml-6 list-disc space-y-1">
            <li>
              Use the Service for any unlawful purpose or in violation of
              any applicable law or regulation;
            </li>
            <li>
              Attempt to execute write operations (INSERT, UPDATE, DELETE,
              DROP, CREATE, ALTER, TRUNCATE, etc.) against any connected
              data source — the Service enforces read-only SELECT queries,
              and circumventing this restriction is prohibited;
            </li>
            <li>
              Upload or connect to data sources containing malware,
              ransomware, or other malicious code;
            </li>
            <li>
              Use the Service to analyze data that you do not have
              lawful rights to access or analyze;
            </li>
            <li>
              Attempt to access, tamper with, or use non-public areas of
              the Service, our systems, or other users&apos; data;
            </li>
            <li>
              Interfere with or disrupt the Service, servers, or networks
              connected to the Service, including by submitting queries
              designed to consume excessive resources (denial-of-service);
            </li>
            <li>
              Reverse engineer, decompile, or otherwise attempt to derive
              the source code of the Service, except as permitted by
              applicable law;
            </li>
            <li>
              Use the Service to develop, train, or improve competing AI
              or data analysis products without our prior written consent.
            </li>
          </ul>
          <p>
            Violations of these acceptable use terms may result in
            immediate suspension or termination of your account, without
            notice.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-display text-lg font-semibold tracking-tight">
            5. User Data and Content
          </h2>
          <p>
            You retain all right, title, and interest in and to any data
            you upload to, or connect through, the Service, including
            uploaded files, database query results, and AI-generated
            analyses based on your data (&ldquo;User Content&rdquo;).
          </p>
          <p>
            You grant Datellix a limited, non-exclusive, worldwide,
            royalty-free license to access, process, and transmit your
            User Content solely as necessary to provide the Service to
            you. This includes executing read-only SQL queries against
            your connected data sources, processing query results in
            isolated Python sandboxes, and transmitting User Content to
            your configured LLM provider for analysis.
          </p>
          <p>
            You are solely responsible for ensuring that you have all
            necessary rights, consents, and permissions to upload,
            connect, and process your User Content through the Service,
            including where User Content contains personal data subject
            to applicable privacy laws.
          </p>
          <p>
            User Content may be processed by third-party LLM providers
            (such as OpenAI, Anthropic, or GLM) that you configure. You
            are responsible for reviewing and complying with the terms of
            service and data processing policies of any such provider.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-display text-lg font-semibold tracking-tight">
            6. Data Retention and Deletion
          </h2>
          <p>
            User Content, including chat sessions, generated artifacts
            (charts, tables, reports), and data source configurations, is
            retained for the lifetime of your account unless you delete
            it. You may delete individual sessions, data sources, and
            saved charts at any time through the Service interface.
            Deletion is permanent and cannot be undone.
          </p>
          <p>
            Upon account termination, we will make commercially
            reasonable efforts to delete your User Content within thirty
            (30) days, except where retention is required by law or to
            comply with legal obligations.
          </p>
          <p>
            Conversation memory (LangGraph checkpoints) and ephemeral
            sandbox state may persist in our systems for up to 30 days
            after deletion for operational reliability, after which they
            are automatically purged.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-display text-lg font-semibold tracking-tight">
            7. Third-Party Services
          </h2>
          <p>
            The Service integrates with and relies upon various
            third-party services, including but not limited to:
          </p>
          <ul className="ml-6 list-disc space-y-1">
            <li>
              <strong>Supabase</strong> — authentication and PostgreSQL
              database hosting;
            </li>
            <li>
              <strong>Daytona</strong> — isolated Python sandbox
              execution;
            </li>
            <li>
              <strong>LLM providers</strong> (OpenAI, Anthropic, GLM, and
              user-configured OpenAI-compatible endpoints) — AI model
              inference;
            </li>
            <li>
              <strong>Vercel Blob and S3-compatible storage</strong> —
              file storage for uploaded data;
            </li>
            <li>
              <strong>Resend</strong> — transactional email delivery for
              verification codes;
            </li>
            <li>
              <strong>Cloudflare Turnstile</strong> — bot protection for
              the signup flow.
            </li>
            <li>
              <strong>Upstash Redis</strong> — distributed rate limit
              counter store for API abuse prevention (production only).
            </li>
          </ul>
          <p>
            We are not responsible for the practices or policies of these
            third-party services. Your use of such services is subject to
            their respective terms and privacy policies. We disclaim all
            liability for any loss or damage arising from your use of
            third-party services.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-display text-lg font-semibold tracking-tight">
            8. Intellectual Property
          </h2>
          <p>
            The Service, including its software, design, documentation,
            and underlying algorithms, is the proprietary property of
            Datellix and is protected by intellectual property laws. No
            title to or ownership of any part of the Service is
            transferred to you pursuant to these Terms.
          </p>
          <p>
            AI-generated analyses, SQL queries, charts, and reports
            produced through your use of the Service are considered User
            Content and belong to you, subject to any rights of the
            underlying LLM provider in its outputs as specified in that
            provider&apos;s terms of service.
          </p>
          <p>
            You may not copy, modify, distribute, sell, or lease any part
            of the Service without our prior written consent. You may not
            use our trademarks, service marks, or branding without
            explicit written permission.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-display text-lg font-semibold tracking-tight">
            9. Disclaimer of Warranties
          </h2>
          <p>
            THE SERVICE IS PROVIDED &ldquo;AS IS&rdquo; AND
            &ldquo;AS AVAILABLE&rdquo; WITHOUT WARRANTIES OF ANY KIND,
            WHETHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
            IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
            PARTICULAR PURPOSE, AND NON-INFRINGEMENT.
          </p>
          <p>
            We do not warrant that the Service will be uninterrupted,
            error-free, secure, or that AI-generated analyses will be
            accurate, complete, or fit for any particular purpose.
            AI-generated outputs may contain errors, hallucinations, or
            misleading information. You are solely responsible for
            evaluating and validating any analysis before relying on it
            for any decision-making purpose.
          </p>
          <p>
            Project-default LLM credentials may run out of quota and are
            not guaranteed to be available. We disclaim all
            responsibility for any unavailability of the Service arising
            from third-party provider outages or quota exhaustion.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-display text-lg font-semibold tracking-tight">
            10. Limitation of Liability
          </h2>
          <p>
            TO THE FULLEST EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT
            SHALL DATELLIX, ITS OFFICERS, DIRECTORS, EMPLOYEES, OR
            AFFILIATES BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL,
            CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR ANY LOSS OF PROFITS,
            DATA, OR BUSINESS OPPORTUNITY, ARISING OUT OF OR RELATED TO
            YOUR USE OF, OR INABILITY TO USE, THE SERVICE, WHETHER BASED
            ON WARRANTY, CONTRACT, TORT (INCLUDING NEGLIGENCE), OR
            OTHERWISE, WHETHER OR NOT WE HAVE BEEN ADVISED OF THE
            POSSIBILITY OF SUCH DAMAGES.
          </p>
          <p>
            THE TOTAL AGGREGATE LIABILITY OF DATELLIX FOR ALL CLAIMS
            ARISING OUT OF OR RELATED TO THESE TERMS OR THE SERVICE SHALL
            NOT EXCEED THE AMOUNT YOU HAVE PAID TO DATELLIX IN THE TWELVE
            (12) MONTHS PRECEDING THE CLAIM, OR ONE HUNDRED U.S. DOLLARS
            ($100.00), WHICHEVER IS GREATER.
          </p>
          <p>
            SOME JURISDICTIONS DO NOT ALLOW THE EXCLUSION OR LIMITATION
            OF CERTAIN DAMAGES, SO SOME OF THE ABOVE LIMITATIONS MAY NOT
            APPLY TO YOU.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-display text-lg font-semibold tracking-tight">
            11. Indemnification
          </h2>
          <p>
            You agree to indemnify, defend, and hold harmless Datellix,
            its officers, directors, employees, and affiliates from and
            against any and all claims, damages, losses, liabilities,
            costs, and expenses (including reasonable attorneys&apos;
            fees) arising out of or related to: (a) your User Content;
            (b) your violation of these Terms; (c) your violation of
            applicable law or the rights of any third party; or (d) your
            misuse of the Service, including any unauthorized write
            operations or resource-exhaustion attacks.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-display text-lg font-semibold tracking-tight">
            12. Subscription, Fees, and Payment
          </h2>
          <p>
            The Service may offer both free and paid subscription tiers.
            If you subscribe to a paid plan, you agree to pay all
            applicable fees as described at the time of purchase. Fees
            are billed in advance on a recurring basis (monthly or
            annually, depending on your plan) and are non-refundable
            except as required by law.
          </p>
          <p>
            You are responsible for all usage charges incurred by
            third-party providers (LLM API calls, sandbox execution
            time, storage) that you configure within the Service. Such
            charges are billed directly by those providers and are
            separate from any fees paid to Datellix.
          </p>
          <p>
            We may change our fees upon reasonable notice. Fee changes
            will take effect at the start of your next billing cycle
            following the notice.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-display text-lg font-semibold tracking-tight">
            13. Term and Termination
          </h2>
          <p>
            These Terms begin on the date you first use the Service and
            continue until terminated. You may terminate your account at
            any time by using the &ldquo;Delete account&rdquo; option in
            the Settings page, which permanently deletes your account and
            all associated data as described in our Privacy Policy. Simply
            signing out does not terminate your account.
          </p>
          <p>
            We may suspend or terminate your account at any time, with
            or without cause, and with or without notice, including for
            violations of these Terms or acceptable use policies.
          </p>
          <p>
            Upon termination, all licenses granted to you under these
            Terms will immediately cease. Sections that by their nature
            should survive termination shall survive, including
            intellectual property, disclaimer of warranties,
            limitation of liability, and indemnification.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-display text-lg font-semibold tracking-tight">
            14. Privacy
          </h2>
          <p>
            Our data practices are described in our Privacy Policy,
            available at <a href="/legal/privacy" className="text-primary underline-offset-4 hover:underline">/legal/privacy</a>,
            which is incorporated into these Terms by reference. By using
            the Service, you consent to the collection and processing of
            information as described in the Privacy Policy.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-display text-lg font-semibold tracking-tight">
            15. Modifications to These Terms
          </h2>
          <p>
            We may modify these Terms from time to time. When we do, we
            will revise the &ldquo;Last updated&rdquo; date at the top of
            this page. For material changes that adversely affect your
            rights, we will provide notice through the Service or by
            email at least thirty (30) days before the changes take
            effect.
          </p>
          <p>
            Your continued use of the Service after the effective date of
            any changes constitutes acceptance of the revised Terms. If
            you do not agree to the revised Terms, you must stop using
            the Service before the changes take effect.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-display text-lg font-semibold tracking-tight">
            16. Governing Law and Dispute Resolution
          </h2>
          <p>
            These Terms shall be governed by and construed in accordance
            with the laws of the jurisdiction in which Datellix is
            established, without regard to its conflict of law
            provisions.
          </p>
          <p>
            Any dispute, claim, or controversy arising out of or
            relating to these Terms or the Service shall first be
            attempted to be resolved through good-faith negotiations
            between the parties. If the dispute cannot be resolved
            through negotiation within thirty (30) days, it shall be
            submitted to binding arbitration in the jurisdiction where
            Datellix is established, in accordance with the rules of a
            mutually agreed arbitration provider.
          </p>
          <p>
            You agree that you will not bring any claim as a plaintiff
            or class member in any class action or representative
            proceeding against Datellix.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-display text-lg font-semibold tracking-tight">
            17. Audit and Logging
          </h2>
          <p>
            We maintain logs of API requests, authentication events, and
            sandbox executions for security, operational, and billing
            purposes. These logs may include metadata such as
            timestamps, IP addresses, query counts, and token usage,
            but do not include the contents of your User Content unless
            required to debug a specific failure you report.
          </p>
          <p>
            Logs are retained for up to ninety (90) days and are
            accessible only to authorized Datellix personnel and
            infrastructure providers (e.g., Supabase, Vercel) for
            operational purposes.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-display text-lg font-semibold tracking-tight">
            18. Children&apos;s Privacy
          </h2>
          <p>
            The Service is not intended for use by anyone under the age
            of 18. We do not knowingly collect personal information from
            children. If you believe we have collected information from
            a child, please contact us using the details below, and we
            will promptly delete it.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-display text-lg font-semibold tracking-tight">
            19. General Provisions
          </h2>
          <p>
            If any provision of these Terms is held to be unenforceable
            or invalid, that provision will be limited or eliminated to
            the minimum extent necessary, and the remaining provisions
            will remain in full force and effect.
          </p>
          <p>
            Our failure to act on or enforce any right or provision of
            these Terms shall not constitute a waiver of that right or
            provision. No waiver shall be effective unless in writing
            and signed by an authorized representative of Datellix.
          </p>
          <p>
            These Terms, together with the Privacy Policy, constitute
            the entire agreement between you and Datellix regarding the
            Service, and supersede all prior agreements and
            understandings, whether written or oral.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-display text-lg font-semibold tracking-tight">
            20. Contact Us
          </h2>
          <p>
            If you have any questions, concerns, or notices regarding
            these Terms, please contact us at:
          </p>
          <p className="rounded-md border border-border bg-muted/30 p-3 font-mono text-xs">
            Datellix Legal
            <br />
            Email: support@wesluma.com
          </p>
        </section>
      </div>
    </article>
  );
}
