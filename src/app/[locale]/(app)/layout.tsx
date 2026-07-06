import { createClient } from "@/lib/supabase/server";
import { Sidebar } from "@/components/sidebar/sidebar";
import type { Session } from "@/lib/db/schema";
import { setRequestLocale } from "next-intl/server";
import { redirect } from "@/i18n/navigation";
import { isLocale, type Locale } from "@/i18n/routing";

interface Props {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}

export default async function AppLayout({ children, params }: Props) {
  const { locale } = await params;
  if (!isLocale(locale)) {
    redirect({ href: "/login", locale: "en" });
  }
  setRequestLocale(locale as Locale);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Defensive: middleware should already redirect, but be explicit
  if (!user) {
    redirect({ href: "/login", locale: locale as Locale });
  }

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
      />
      <main className="flex-1 overflow-hidden">{children}</main>
    </div>
  );
}
