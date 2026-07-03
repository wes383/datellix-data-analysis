/**
 * Shared in-memory OTP store.
 *
 * Next.js module instances are shared within a single server process, so
 * both send-otp and verify-otp routes will reference the same Map as long
 * as they are handled by the same worker (true for local dev and single-
 * instance deployments).
 *
 * For multi-instance / serverless deployments, swap this out for a
 * Redis-backed or DB-backed store.
 */

export interface OtpRecord {
  code: string;
  expiresAt: number; // Unix ms
}

// Module-level singleton — shared across all imports within the same process.
const store = new Map<string, OtpRecord>();

/** Store a new OTP for the given email (overwrites any existing entry). */
export function setOtp(email: string, record: OtpRecord): void {
  store.set(email, record);
}

/** Retrieve the OTP record for the given email, or undefined if not present. */
export function getOtp(email: string): OtpRecord | undefined {
  return store.get(email);
}

/** Remove the OTP record for the given email. */
export function deleteOtp(email: string): void {
  store.delete(email);
}
