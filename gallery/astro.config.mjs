// astro.config.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isCloudflare = process.env.DEPLOY_TARGET === "cloudflare";

// ---------------------------------------------------------
// Adapter & EmDash Database / Storage Switching
// ---------------------------------------------------------
let adapter;
let emdashDb;
let emdashStorage;

if (isCloudflare) {
  const { default: cloudflare } = await import("@astrojs/cloudflare");
  const { d1, r2 } = await import("@emdash-cms/cloudflare");
  adapter = cloudflare({
    // Cloudflare Images binding (IMAGES) を不要化し、画像は R2 + EmDash media route で配信
    imageService: "passthrough",
  });
  emdashDb = d1({ binding: "DB" });
  emdashStorage = r2({ binding: "MEDIA" });
} else {
  const { default: node } = await import("@astrojs/node");
  const { local } = await import("emdash/astro");
  const { sqlite } = await import("emdash/db");
  adapter = node({ mode: "standalone" });
  emdashDb = sqlite({ url: "file:./data.db" });
  emdashStorage = local({
    directory: "./uploads",
    baseUrl: "/_emdash/api/media/file",
  });
}

const { default: emdash } = await import("emdash/astro");

export default defineConfig({
  // ---------------------------------------------------------
  // SSR
  // ---------------------------------------------------------
  output: "server",

  adapter,

  // ---------------------------------------------------------
  // Site URL
  // ---------------------------------------------------------
  site: process.env.PUBLIC_SITE_URL || "https://nyans-gallery.local",

  // ---------------------------------------------------------
  // Integrations
  // ---------------------------------------------------------
  integrations: [
    // EmDash管理画面用
    react(),

    // EmDash CMS
    emdash({
      database: emdashDb,
      storage: emdashStorage,
      plugins: [],
    }),

    // Sitemap
    sitemap(),
  ],

  // ---------------------------------------------------------
  // Vite
  // Tailwind CSS v4 & Cloudflare Workers externalization
  // ---------------------------------------------------------
  vite: {
    plugins: [
      tailwindcss(),
    ],
    resolve: {
      alias: !isCloudflare
        ? {
            "@emdash-cms/cloudflare/db/d1": path.resolve(__dirname, "src/lib/empty-stub.ts"),
          }
        : {},
    },
    build: {
      rollupOptions: {
        external: [
          "cloudflare:workers",
        ],
      },
    },
    ssr: {
      external: [
        "cloudflare:workers",
      ],
    },
  },

  // ---------------------------------------------------------
  // Astro Image
  // ---------------------------------------------------------
  image: {
    domains: [
      "images.unsplash.com",
    ],
  },
});
