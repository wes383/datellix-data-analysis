import type { ReactNode } from "react";
import type { Metadata } from "next";
import { NextIntlClientProvider, hasLocale } from "next-intl";
import { notFound } from "next/navigation";
import { setRequestLocale, getTranslations, getMessages } from "next-intl/server";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { ThemeToaster } from "@/components/theme/theme-toaster";
import { LOCALES, type Locale, isLocale } from "@/i18n/routing";

interface Props {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}

/** Generate static params for all supported locales (enables static rendering). */
export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

/** Localised metadata for the <html> head. */
export async function generateMetadata({
  params,
}: Omit<Props, "children">): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslations({ locale, namespace: "Metadata" });
  return {
    title: t("appTitle"),
    description: t("appDescription"),
  };
}

/** Suppress static-generation errors for non-static locales. */
export const dynamicParams = false;

export default async function LocaleLayout({ children, params }: Props) {
  const { locale } = await params;

  // Validate locale — show 404 for unknown locale codes.
  if (!hasLocale(LOCALES, locale)) {
    notFound();
  }

  // Tell next-intl which locale this render is for (enables static rendering).
  setRequestLocale(locale as Locale);

  // Explicitly load messages and pass to the client provider. Without this,
  // client components (useTranslations) fall back to empty messages.
  const messages = await getMessages();

  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      <ThemeProvider>
        {children}
        <ThemeToaster />
      </ThemeProvider>
    </NextIntlClientProvider>
  );
}
