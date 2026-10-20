// astro.config.mjs
import { defineConfig } from "astro/config";
import node from "@astrojs/node";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";

import emdash, { local } from "emdash/astro";
import { sqlite } from "emdash/db";

export default defineConfig({
  // ---------------------------------------------------------
  // SSR
  // ---------------------------------------------------------
  output: "server",

  adapter: node({
    mode: "standalone",
  }),

  // ---------------------------------------------------------
  // Site URL
  // 環境変数 PUBLIC_SITE_URL またはローカル開発用フォールバック
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
      database: sqlite({
        url: "file:./data.db",
      }),

      storage: local({
        directory: "./uploads",
        baseUrl: "/_emdash/api/media/file",
      }),

      plugins: [],
    }),

    // Sitemap
    sitemap(),
  ],

  // ---------------------------------------------------------
  // Vite
  // Tailwind CSS v4
  // ---------------------------------------------------------
  vite: {
    plugins: [
      tailwindcss(),
    ],
  },

  // ---------------------------------------------------------
  // Astro Image
  // 外部プレースホルダー用
  // ---------------------------------------------------------
  image: {
    domains: [
      "images.unsplash.com",
    ],
  },
});