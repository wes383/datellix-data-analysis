import type { Metadata } from "next";
import "./globals.css";
import { Toaster } from "sonner";

export const metadata: Metadata = {
  title: "Datellix — AI Data Analysis Agent",
  description:
    "Serverless AI data analysis agent: upload data, ask questions in natural language, get SQL, charts, and insights.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        {children}
        <Toaster
          position="top-right"
          theme="light"
          toastOptions={{
            style: {
              background: "hsl(0 0% 100%)",
              border: "1px solid hsl(0 0% 89.8%)",
              color: "hsl(0 0% 3.9%)",
            },
          }}
        />
      </body>
    </html>
  );
}
