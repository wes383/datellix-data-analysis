import { setRequestLocale } from "next-intl/server";
import { redirect } from "@/i18n/navigation";
import { isLocale, type Locale } from "@/i18n/routing";

interface Props {
  params: Promise<{ locale: string }>;
}

/**
 * Home — redirect to a fresh pending session instead of showing a blank
 * placeholder. The pending session (`/chat/new`) doesn't create a DB
 * row until the first message is sent.
 */
export default async function HomePage({ params }: Props) {
  const { locale } = await params;
  if (!isLocale(locale)) {
    redirect({ href: "/chat/new", locale: "en" });
  }
  setRequestLocale(locale as Locale);
  redirect({ href: "/chat/new", locale: locale as Locale });
}
