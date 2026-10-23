import type { APIRoute } from 'astro';
import { getBackendDb, getBackendEnv, safeTokenCompare } from '../../../lib/nyans-backend';

/**
 * 統一JSONエラーレスポンス生成ヘルパー
 */
function errorResponse(
  status: number,
  error: string,
  message: string,
  details: Record<string, unknown> = {}
): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      error,
      message,
      details,
    }),
    {
      status,
      headers: { 'Content-Type': 'application/json' },
    }
  );
}

export const OPTIONS: APIRoute = async () => {
  return new Response(null, {
    status: 204,
    headers: {
      Allow: 'POST, OPTIONS',
    },
  });
};

export const POST: APIRoute = async ({ request, locals }) => {
  // 1. 認証チェック
  const authHeader = request.headers.get('Authorization') || '';
  const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const expectedToken = await getBackendEnv(locals, 'NYANS_IMPORT_TOKEN');

  if (!expectedToken) {
    return errorResponse(500, 'SERVER_MISCONFIGURED', 'NYANS_IMPORT_TOKEN is not configured.');
  }

  if (!tokenMatch || !safeTokenCompare(tokenMatch[1], expectedToken)) {
    return errorResponse(401, 'UNAUTHORIZED', 'Invalid or missing Bearer token.');
  }

  // 2. リクエストJSONのパース
  let body: any;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'INVALID_JSON', 'Request body must be valid JSON.');
  }

  const { slug, postiz_status, postiz_post_id, postiz_published_at, postiz_last_error } = body || {};

  if (!slug || typeof slug !== 'string') {
    return errorResponse(400, 'INVALID_SLUG', 'artwork slug is required.');
  }

  const allowedStatuses = ['pending', 'scheduled', 'published', 'failed'];
  if (!postiz_status || !allowedStatuses.includes(postiz_status)) {
    return errorResponse(400, 'INVALID_STATUS', `postiz_status must be one of: ${allowedStatuses.join(', ')}`);
  }

  // 3. DB更新 (Local: SQLite / Cloudflare: D1)
  let db: any;
  try {
    db = await getBackendDb(locals);

    // 既存Artworkの確認
    const existing = await db
      .selectFrom('ec_artworks')
      .select(['id', 'slug', 'postiz_status', 'postiz_post_id', 'postiz_published_at'])
      .where('slug', '=', slug)
      .executeTakeFirst();

    if (!existing) {
      return errorResponse(404, 'NOT_FOUND', `Artwork with slug '${slug}' not found.`);
    }

    // 更新実行
    const updateData: Record<string, any> = {
      postiz_status,
      postiz_last_error: postiz_last_error !== undefined ? postiz_last_error : null,
      updated_at: new Date().toISOString(),
    };

    if (postiz_post_id !== undefined) {
      updateData.postiz_post_id = postiz_post_id;
    }

    if (postiz_published_at !== undefined) {
      updateData.postiz_published_at = postiz_published_at;
    }

    await db
      .updateTable('ec_artworks')
      .set(updateData)
      .where('slug', '=', slug)
      .execute();

    return new Response(
      JSON.stringify({
        ok: true,
        slug,
        postiz_status,
        postiz_post_id: updateData.postiz_post_id ?? existing.postiz_post_id,
        postiz_published_at: updateData.postiz_published_at ?? existing.postiz_published_at,
        updated_at: updateData.updated_at,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (err: any) {
    return errorResponse(500, 'DB_ERROR', err?.message || 'Database error occurred.');
  } finally {
    if (db && typeof db.destroy === 'function') {
      await db.destroy().catch(() => {});
    }
  }
};
