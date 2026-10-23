// gallery/src/lib/nyans-backend.ts
import { Kysely } from 'kysely';
import crypto from 'node:crypto';

/**
 * 実行環境がCloudflare Workersかどうか判定
 */
export function isCloudflareEnvironment(locals?: App.Locals): boolean {
  return (
    process.env.DEPLOY_TARGET === 'cloudflare' ||
    Boolean(locals?.runtime) ||
    typeof (globalThis as any).WebSocketPair !== 'undefined'
  );
}

/**
 * Cloudflare Workersの環境オブジェクトを取得
 */
async function getCloudflareEnv(): Promise<any> {
  try {
    const { env } = await import('cloudflare:workers');
    return env;
  } catch {
    return undefined;
  }
}

/**
 * 環境変数を安全に取得（Cloudflare env または process.env / import.meta.env）
 */
export async function getBackendEnv(locals: App.Locals | undefined, key: string): Promise<string | undefined> {
  const cfEnv = await getCloudflareEnv();
  if (cfEnv && cfEnv[key]) {
    return cfEnv[key];
  }
  if (typeof process !== 'undefined' && process.env && process.env[key]) {
    return process.env[key];
  }
  // Viteの静的置換に対応
  if (key === 'NYANS_IMPORT_TOKEN') {
    return import.meta.env.NYANS_IMPORT_TOKEN;
  }
  if (key === 'POSTIZ_API_KEY') {
    return import.meta.env.POSTIZ_API_KEY;
  }
  if (key === 'NYANS_POSTIZ_CHANNEL_ID') {
    return import.meta.env.NYANS_POSTIZ_CHANNEL_ID;
  }
  if (key === 'EMDASH_ENCRYPTION_KEY') {
    return import.meta.env.EMDASH_ENCRYPTION_KEY;
  }
  if (typeof import.meta !== 'undefined' && (import.meta as any).env) {
    return (import.meta as any).env[key];
  }
  return undefined;
}

/**
 * タイミング攻撃を防ぐ安全なトークン比較
 */
export function safeTokenCompare(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const bufA = Buffer.from(provided);
  const bufB = Buffer.from(expected);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * 環境に応じたKyselyインスタンスを生成（Local: SQLite, Cloudflare: D1）
 */
export async function getBackendDb(locals?: App.Locals): Promise<Kysely<any>> {
  if (isCloudflareEnvironment(locals)) {
    const { createDialect } = await import('@emdash-cms/cloudflare/db/d1');
    const dialect = createDialect({ binding: 'DB' });
    return new Kysely<any>({ dialect });
  } else {
    const { createDialect } = await import('emdash/db/sqlite');
    const dialect = createDialect({ url: 'file:./data.db' });
    return new Kysely<any>({ dialect });
  }
}

/**
 * メディア実ファイルの保存（Local: uploads/, Cloudflare: R2 MEDIA binding）
 */
export async function saveMediaFile(
  storageKey: string,
  buffer: Buffer,
  mimeType: string,
  locals?: App.Locals
): Promise<void> {
  if (isCloudflareEnvironment(locals)) {
    const cfEnv = await getCloudflareEnv();
    const r2 = cfEnv?.MEDIA;
    if (!r2) {
      throw new Error('R2 MEDIA binding is not available in cloudflare:workers env.');
    }
    await r2.put(storageKey, buffer, {
      httpMetadata: {
        contentType: mimeType,
      },
    });
  } else {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const uploadsDir = path.resolve(process.cwd(), 'uploads');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
    const filePath = path.join(uploadsDir, storageKey);
    fs.writeFileSync(filePath, buffer);
  }
}

/**
 * メディア実ファイルの削除（ロールバック用）
 */
export async function deleteMediaFile(
  storageKey: string,
  locals?: App.Locals
): Promise<void> {
  if (isCloudflareEnvironment(locals)) {
    try {
      const cfEnv = await getCloudflareEnv();
      const r2 = cfEnv?.MEDIA;
      if (r2) {
        await r2.delete(storageKey);
      }
    } catch {
      // ignore
    }
  } else {
    try {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const uploadsDir = path.resolve(process.cwd(), 'uploads');
      const filePath = path.join(uploadsDir, storageKey);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // ignore
    }
  }
}
