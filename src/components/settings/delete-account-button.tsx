"use client";

import { useState, useTransition } from "react";
import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { Trash2, AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { deleteAccount } from "@/app/actions/sessions";
import { toast } from "sonner";

/**
 * Two-step delete-account button.
 *
 * Step 1: a muted "Delete account" button.
 * Step 2: an inline confirmation panel with a red "Delete permanently"
 *         button and a "Cancel" button. The destructive action only fires
 *         on the second click.
 *
 * On success the server action signs the user out and revalidates the
 * path; the auth middleware then redirects to /login. On failure a toast
 * is shown and the panel stays open so the user can retry.
 */
export function DeleteAccountButton() {
  const t = useTranslations("Settings");
  const tc = useTranslations("Common");
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function handleConfirm() {
    startTransition(async () => {
      try {
        await deleteAccount();
        // The server action signs the user out; the middleware will
        // redirect to /login on the next navigation. Push explicitly
        // to trigger the redirect promptly.
        router.push("/login");
      } catch (err) {
        console.error("[deleteAccount] failed:", err);
        toast.error(
          err instanceof Error
            ? err.message
            : t("toastDeleteFailed"),
        );
      }
    });
  }

  if (!confirming) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setConfirming(true)}
        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
      >
        <Trash2 className="h-3.5 w-3.5" />
        {t("deleteAccount")}
      </Button>
    );
  }

  return (
    <div className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 p-3">
      <div className="flex items-start gap-2 text-xs text-destructive">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          {t("confirmDeleteBody")}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="destructive"
          size="sm"
          onClick={handleConfirm}
          disabled={pending}
        >
          {pending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
          {t("buttonDeletePermanently")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setConfirming(false)}
          disabled={pending}
        >
          {tc("cancel")}
        </Button>
      </div>
    </div>
  );
}
