import { NextRequest, NextResponse } from "next/server";
import { getOtp, deleteOtp } from "@/lib/auth/otp-store";
import { rateLimit, getClientIp, LIMITS, rateLimitHeaders } from "@/lib/ratelimit/limiter";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { email?: string; code?: string };
    const { email, code } = body;

    if (!email || !code) {
      return NextResponse.json(
        { error: "Missing email or code" },
        { status: 400 },
      );
    }

    // Extract client IP for rate limiting
    const ip = getClientIp(req.headers);

    // Rate-limit: 5 verification attempts per 5 min per (IP + email).
    // This protects against brute-forcing the 6-digit OTP space (10^6).
    // Without this, an attacker could enumerate all codes within the 5-min TTL.
    // Failed attempts (wrong code) consume quota; successful ones don't matter
    // because the OTP is deleted on success.
    const identifier = `${ip}:${email.toLowerCase()}`;
    const rl = await rateLimit(identifier, LIMITS.OTP_VERIFY);
    if (!rl.ok) {
      const retryAfterSec = Math.ceil((rl.resetAt - Date.now()) / 1000);
      return NextResponse.json(
        {
          error:
            "Too many failed attempts. Please wait a few minutes before trying again, or request a new code.",
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

    const record = getOtp(email);
    const now = Date.now();

    if (!record) {
      return NextResponse.json(
        {
          error:
            "No verification code found for this email. Please request a new one.",
        },
        { status: 400 },
      );
    }

    if (now > record.expiresAt) {
      deleteOtp(email);
      return NextResponse.json(
        { error: "Verification code has expired. Please request a new one." },
        { status: 400 },
      );
    }

    if (record.code !== code.trim()) {
      return NextResponse.json(
        { error: "Incorrect verification code." },
        { status: 400 },
      );
    }

    // Success — remove so it cannot be reused
    deleteOtp(email);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[verify-otp] Unexpected error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
