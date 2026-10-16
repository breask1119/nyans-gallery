// astro.config.mjs
import { defineConfig } from "astro/config";
import tailwind from "@astrojs/tailwind";
import sitemap from "@astrojs/sitemap";
import AstroPWA from "@vite-pwa/astro";

/**
 * Astroの全体設定ファイルです。
 * Tailwind CSS、Sitemapの統合、PWA化、および外部画像の最適化許可設定を含みます。
 */
export default defineConfig({
  // サイトの公開URL（Sitemap生成やPWAのマニフェストなどに使用します）
  site: "https://xx-ai-girls-miu.com",

  integrations: [
    // Tailwind CSSの有効化
    tailwind(),

    // サイトマップ自動生成の有効化
    sitemap(),

    // PWAの有効化と設定
    AstroPWA({
      registerType: "autoUpdate",
      // マニフェストの設定です。ホーム画面に追加した際のアプリアイコンや名前を定義します。
      manifest: {
        name: "Miu's Gallery | AI Girls Gallery",
        short_name: "Miu's Gallery",
        description: "Tactile Maximalism & Bento Grid Gallery",
        start_url: "/",
        scope: "/",
        theme_color: "#050505",
        background_color: "#050505",
        display: "standalone", // ネイティブアプリのようにブラウザUIを非表示にします
        orientation: "portrait",
        icons: [
          {
            src: "/pwa-192x192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "/pwa-512x512.png",
            sizes: "512x512",
            type: "image/png",
          },
          {
            src: "/pwa-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable", // Android向けのアダプティブアイコン対応です
          },
        ],
      },
      // Service Worker (Workbox) の設定です。キャッシュ戦略を定義します。
      workbox: {
        navigateFallback: "/",
        globPatterns: ["**/*.{css,js,html,svg,png,ico,txt}"],
        runtimeCaching: [
          {
            // Google Fontsのスタイルシートをキャッシュします
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "google-fonts-cache",
              expiration: {
                maxEntries: 10,
                maxAgeSeconds: 60 * 60 * 24 * 365, // 365日
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
          {
            // Google Fontsのフォントファイル自体をキャッシュします
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "gstatic-fonts-cache",
              expiration: {
                maxEntries: 10,
                maxAgeSeconds: 60 * 60 * 24 * 365, // 365日
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
          {
            // 外部の画像（WPからのAI生成画像やUnsplashなど）をキャッシュします
            urlPattern: /\.(?:png|jpg|jpeg|svg|webp)$/i,
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "external-images-cache",
              expiration: {
                maxEntries: 200,
                maxAgeSeconds: 60 * 60 * 24 * 30, // 30日
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
        ],
      },
    }),
  ],

  image: {
    /**
     * 外部ドメインの画像最適化許可設定。
     * Astroの <Image /> や getImage() を使って外部画像をWebP化する場合に使用します。
     * ※ネイティブの<img>タグを使用している場合は不要ですが、念のため残しています。
     */
    domains: [
      "images.unsplash.com", // プレースホルダー用
      "api.xx-ai-girls-miu.com", // 実際のWordPressのメディアドメイン
    ],
  },
});
