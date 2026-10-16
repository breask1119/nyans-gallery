/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        brand: {
          dark: "#0F0F11", // 深い黒（OLED対応）
          neon: "#F43F5E", // ネオンカラーのアクセント（ドーパミン・パレット）
        },
      },
      fontFamily: {
        sans: ['"Inter"', "sans-serif"], // 任意のフォントに変更してください
      },
    },
  },
  plugins: [
    // 必要に応じてコンテナクエリのプラグインなどを追加してください
  ],
};
