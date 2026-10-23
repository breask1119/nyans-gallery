/// <reference types="astro/client" />
/// <reference types="@cloudflare/workers-types" />

type D1Database = import("@cloudflare/workers-types").D1Database;
type R2Bucket = import("@cloudflare/workers-types").R2Bucket;

type CloudflareEnv = {
  DB: D1Database;
  MEDIA: R2Bucket;
  NYANS_IMPORT_TOKEN?: string;
  POSTIZ_API_KEY?: string;
  NYANS_POSTIZ_CHANNEL_ID?: string;
  EMDASH_ENCRYPTION_KEY?: string;
  PUBLIC_SITE_URL?: string;
};

type Runtime = import("@astrojs/cloudflare").Runtime<CloudflareEnv>;

declare namespace App {
  interface Locals {
    runtime?: Runtime;
  }
}
