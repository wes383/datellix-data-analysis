import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Sidebar } from "@/components/sidebar/sidebar";
import type { Session } from "@/lib/db/schema";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Defensive: middleware should already redirect, but be explicit
  if (!user) redirect("/login");

  const { data: sessions } = await supabase
    .from("sessions")
    .select("id, title, updated_at")
    .order("updated_at", { ascending: false });

  return (
    <div className="flex h-screen">
      <Sidebar
        sessions={(sessions ?? []) as unknown as Pick<
          Session,
          "id" | "title" | "updated_at"
        >[]}
        userEmail={user.email ?? null}
      />
      <main className="flex-1 overflow-hidden">{children}</main>
    </div>
  );
}
