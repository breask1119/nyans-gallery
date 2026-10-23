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
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
    }
  );
}

export const OPTIONS: APIRoute = async () => {
  return new Response(null, {
    status: 204,
    headers: {
      Allow: 'GET, OPTIONS',
    },
  });
};

export const GET: APIRoute = async ({ request, locals }) => {
  // 1. 認証チェック
  const expectedToken = await getBackendEnv(locals, 'NYANS_IMPORT_TOKEN');
  if (!expectedToken) {
    return errorResponse(500, 'SERVER_MISCONFIGURED', 'NYANS_IMPORT_TOKEN is not configured on the server.');
  }

  const authHeader = request.headers.get('authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return errorResponse(401, 'UNAUTHORIZED', '有効なAuthorization Bearerトークンが必要です。');
  }

  const providedToken = match[1].trim();
  if (!safeTokenCompare(providedToken, expectedToken)) {
    return errorResponse(401, 'UNAUTHORIZED', 'トークンが無効または一致しません。');
  }

  // 2. クエリパラメータ（フィルタ条件）
  const url = new URL(request.url);
  const statusFilter = url.searchParams.get('status'); // 例: 'all', 'pending', 等

  let db: any;
  try {
    db = await getBackendDb(locals);

    let query = db
      .selectFrom('ec_artworks')
      .select([
        'id',
        'slug',
        'title',
        'cat_slug',
        'postiz_status',
        'postiz_post_id',
        'instagram_publish_at',
        'publish_at',
        'updated_at',
      ]);

    if (statusFilter === 'all') {
      // 全件（管理・調査用）
    } else if (statusFilter) {
      query = query.where('postiz_status', '=', statusFilter);
    } else {
      // デフォルト: Postiz Status Sync 対象（scheduled かつ postiz_post_id が存在する作品のみ）
      query = query
        .where('postiz_status', '=', 'scheduled')
        .where('postiz_post_id', 'is not', null)
        .where('postiz_post_id', '!=', '');
    }

    const posts = await query.orderBy('publish_at', 'asc').execute();

    return new Response(
      JSON.stringify({
        ok: true,
        count: posts.length,
        posts,
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        },
      }
    );
  } catch (err: any) {
    console.error('🚨 [nyans-scheduled-posts] Database error:', err);
    return errorResponse(500, 'DATABASE_ERROR', err?.message || 'Failed to fetch scheduled posts.');
  } finally {
    if (db && typeof db.destroy === 'function') {
      await db.destroy().catch(() => {});
    }
  }
};
