import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { uploadFile, blobPath } from "@/lib/blob/client";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * File upload interface
 *
 * Request: POST /api/upload
 * form-data: { sessionId: string, file: File }
 *
 * Response: { fileRef: string, filename: string, size: number }
 *
 * Flow: browser → Server Action → Vercel Blob
 *      → later queried directly with DuckDB inside Daytona sandbox
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const formData = await req.formData();
  const sessionId = formData.get("sessionId") as string | null;
  const file = formData.get("file") as File | null;
  if (!sessionId || !file) {
    return NextResponse.json({ error: "Missing sessionId or file" }, { status: 400 });
  }

  // Verify session ownership
  const { data: session } = await supabase
    .from("sessions")
    .select("id, user_id")
    .eq("id", sessionId)
    .single();
  if (!session || session.user_id !== user.id) {
    return NextResponse.json({ error: "Session not found or access denied" }, { status: 404 });
  }

  // Upload to Blob
  const path = blobPath(user.id, sessionId, file.name);
  const url = await uploadFile(path, file);

  return NextResponse.json({
    fileRef: url,
    filename: file.name,
    size: file.size,
    format: detectFormat(file.name),
  });
}

function detectFormat(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  if (ext === "csv") return "csv";
  if (ext === "xlsx" || ext === "xls") return "excel";
  if (ext === "parquet") return "parquet";
  return "unknown";
}
