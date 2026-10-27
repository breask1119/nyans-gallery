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

  let db: any;
  try {
    db = await getBackendDb(locals);

    // Postiz Status Sync用途として明確化
    // 取得条件: postiz_status = 'scheduled' AND postiz_post_id IS NOT NULL
    // pending 作品は Status Sync 対象外
    const posts = await db
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
      ])
      .where('postiz_status', '=', 'scheduled')
      .where('postiz_post_id', 'is not', null)
      .where('postiz_post_id', '!=', '')
      .orderBy('publish_at', 'asc')
      .execute();

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
    // 初回デプロイ直後など ec_artworks テーブルが未作成の場合は空配列として安全に返却
    if (err?.message && (err.message.includes('no such table') || err.message.includes('not found'))) {
      return new Response(
        JSON.stringify({
          ok: true,
          count: 0,
          posts: [],
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          },
        }
      );
    }

    console.error('🚨 [nyans-scheduled-posts] Database error:', err);
    return errorResponse(500, 'DATABASE_ERROR', err?.message || 'Failed to fetch scheduled posts.');
  } finally {
    if (db && typeof db.destroy === 'function') {
      await db.destroy().catch(() => {});
    }
  }
};
