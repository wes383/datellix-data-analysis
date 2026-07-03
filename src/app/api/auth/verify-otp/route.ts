import { NextRequest, NextResponse } from "next/server";
import { getOtp, deleteOtp } from "@/lib/auth/otp-store";

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
