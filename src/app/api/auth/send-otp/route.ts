import { NextRequest, NextResponse } from "next/server";
import { Resend } from "resend";
import { setOtp, getOtp } from "@/lib/auth/otp-store";
import { rateLimit, getClientIp, LIMITS, rateLimitHeaders } from "@/lib/ratelimit/limiter";
import crypto from "node:crypto";

const resend = new Resend(process.env.RESEND_API_KEY);

/** Verify Cloudflare Turnstile token server-side. */
async function verifyTurnstile(token: string, ip: string): Promise<boolean> {
  const secret = process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY;
  if (!secret) {
    console.error("[send-otp] CLOUDFLARE_TURNSTILE_SECRET_KEY not set");
    return false;
  }
  const res = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response: token, remoteip: ip }),
    },
  );
  const data = (await res.json()) as { success: boolean };
  return data.success === true;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      email?: string;
      turnstileToken?: string;
    };
    const { email, turnstileToken } = body;

    if (!email || !turnstileToken) {
      return NextResponse.json(
        { error: "Missing email or Turnstile token" },
        { status: 400 },
      );
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json(
        { error: "Invalid email address" },
        { status: 400 },
      );
    }

    // Extract client IP (CF-Connecting-IP > X-Forwarded-For > X-Real-IP > 127.0.0.1)
    const ip = getClientIp(req.headers);

    // Rate-limit: 3 OTP requests per 5 min per (IP + email).
    // Identifiers combined to prevent a single attacker from rotating emails
    // to bypass IP-only limits, and vice versa.
    const identifier = `${ip}:${email.toLowerCase()}`;
    const rl = await rateLimit(identifier, LIMITS.OTP_SEND);
    if (!rl.ok) {
      const retryAfterSec = Math.ceil((rl.resetAt - Date.now()) / 1000);
      return NextResponse.json(
        {
          error:
            "Too many verification codes requested. Please wait a few minutes before trying again.",
        },
        {
          status: 429,
          headers: {
            "Retry-After": String(retryAfterSec),
            ...rateLimitHeaders(rl),
          },
        },
      );
    }

    // Verify Turnstile
    const turnstileOk = await verifyTurnstile(turnstileToken, ip);
    if (!turnstileOk) {
      return NextResponse.json(
        { error: "Human verification failed. Please try again." },
        { status: 400 },
      );
    }

    // Rate-limit: block re-send if a fresh OTP (>4 min remaining) exists
    const existing = getOtp(email);
    const now = Date.now();
    if (existing && existing.expiresAt - now > 4 * 60 * 1000) {
      return NextResponse.json(
        {
          error:
            "A verification code was already sent. Please wait before requesting another.",
        },
        { status: 429 },
      );
    }

    // Generate 6-digit OTP using cryptographic random (NOT Math.random which is
    // predictable — see https://v8.dev/blog/math.random).
    const code = String(crypto.randomInt(100000, 1000000));
    setOtp(email, { code, expiresAt: now + 5 * 60 * 1000 });

    // Send via Resend
    const { error: sendError } = await resend.emails.send({
      from: "Datellix <noreply@mail.datellix.wesluma.com>",
      to: email,
      subject: "Your Datellix verification code",
      html: `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Datellix Verification Code</title>
</head>
<body style="margin:0;padding:0;background:#f9f9f9;font-family:'Inter',system-ui,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f9f9;padding:48px 0;">
    <tr>
      <td align="center">
        <table width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;border:1px solid #e5e5e5;overflow:hidden;">
          <tr>
            <td style="padding:32px 40px 24px;border-bottom:1px solid #f0f0f0;">
              <span style="font-family:'Plus Jakarta Sans','Inter',system-ui,sans-serif;font-size:22px;font-weight:700;letter-spacing:-0.03em;color:#0a0a0a;">
                Datellix
              </span>
            </td>
          </tr>
          <tr>
            <td style="padding:36px 40px;">
              <p style="margin:0 0 8px;font-size:15px;color:#525252;line-height:1.5;">
                Your verification code is:
              </p>
              <div style="margin:24px 0;text-align:center;">
                <span style="display:inline-block;font-family:'Inter',monospace;font-size:40px;font-weight:700;letter-spacing:0.18em;color:#0a0a0a;background:#f5f5f5;border-radius:8px;padding:16px 32px;border:1px solid #e5e5e5;">
                  ${code}
                </span>
              </div>
              <p style="margin:0;font-size:13px;color:#737373;line-height:1.6;">
                This code expires in <strong>5 minutes</strong>. If you did not request an account, you can safely ignore this email.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 40px;border-top:1px solid #f0f0f0;background:#fafafa;">
              <p style="margin:0;font-size:12px;color:#a3a3a3;">
                © ${new Date().getFullYear()} Datellix · AI Data Analysis
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
      `.trim(),
    });

    if (sendError) {
      console.error("[send-otp] Resend error:", sendError);
      return NextResponse.json(
        { error: "Failed to send verification email. Please try again." },
        { status: 500 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[send-otp] Unexpected error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
