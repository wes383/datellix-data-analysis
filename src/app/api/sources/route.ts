import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { encryptConfig } from "@/lib/db/crypto";
import { indexDataSourceSchema } from "@/lib/agent/schema";
import type { PgConfig } from "@/lib/db/schema";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Create a Postgres data source
 *
 * Request: POST /api/sources
 * body: { name, host, port, database, user, password, ssl?, sessionId? }
 *
 * If sessionId is provided, the data source is bound to that session
 * and schema indexing is triggered immediately.
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const body = (await req.json()) as {
    name?: string;
    host?: string;
    port?: number;
    database?: string;
    user?: string;
    password?: string;
    ssl?: string;
    sessionId?: string;
  };

  if (!body.name || !body.host || !body.database || !body.user || !body.password) {
    return NextResponse.json(
      { error: "Missing required fields: name, host, database, user, password" },
      { status: 400 },
    );
  }

  // Build config
  const config: PgConfig = {
    host: body.host,
    port: body.port ?? 5432,
    database: body.database,
    user: body.user,
    password: body.password,
    ssl: body.ssl ?? "require",
  };

  // Encrypt
  const configEncrypted = await encryptConfig(config);

  // Insert data source
  const { data: dataSource, error: dsError } = await supabase
    .from("data_sources")
    .insert({
      user_id: user.id,
      type: "pg",
      name: body.name,
      config_encrypted: configEncrypted,
      meta: { host: body.host, port: config.port, database: body.database },
    })
    .select("id")
    .single();

  if (dsError || !dataSource) {
    return NextResponse.json(
      { error: `Failed to create data source: ${dsError?.message ?? "unknown"}` },
      { status: 500 },
    );
  }

  // Bind to session if provided
  if (body.sessionId) {
    const { error: sessionError } = await supabase
      .from("sessions")
      .update({ data_source_id: dataSource.id, title: body.name })
      .eq("id", body.sessionId);
    if (sessionError) {
      console.error("[sources] failed to bind session:", sessionError.message);
    }
  }

  // Index schema (best-effort)
  let indexed = false;
  let indexError: string | undefined;
  try {
    await indexDataSourceSchema({
      dataSourceId: dataSource.id,
      userId: user.id,
      type: "pg",
      configEncrypted,
    });
    indexed = true;
  } catch (err) {
    indexError = err instanceof Error ? err.message : "Schema indexing failed";
    console.error("[sources] schema indexing failed:", indexError);
  }

  return NextResponse.json({
    dataSourceId: dataSource.id,
    indexed,
    indexError,
  });
}
