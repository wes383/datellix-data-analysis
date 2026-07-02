"use client";

import { useSearchParams } from "next/navigation";
import { SourceForm } from "@/components/sources/source-form";

/**
 * New data source page. Delegates to the shared <SourceForm> in create mode.
 * The optional `sessionId` query param binds the new source to a session.
 */
export default function NewSourcePage() {
  const searchParams = useSearchParams();
  const sessionId = searchParams.get("sessionId") ?? undefined;

  return (
    <SourceForm
      mode="create"
      sessionId={sessionId}
      doneHref={sessionId ? `/chat/${sessionId}` : "/sources"}
      cancelHref={sessionId ? `/chat/${sessionId}` : "/sources"}
    />
  );
}
