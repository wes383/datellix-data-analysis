import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// Initialise the next-intl plugin — it wires the request config
// (src/i18n/request.ts) into the Next.js build so messages are loaded
// server-side and streamed to the client via NextIntlClientProvider.
const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: "50mb",
    },
  },
};

// Compose the plugins — next-intl must wrap the base config.
export default withNextIntl(nextConfig);
