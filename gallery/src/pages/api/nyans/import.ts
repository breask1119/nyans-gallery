import type { APIRoute } from 'astro';
import { getEmDashCollection, handleContentCreate, handleMediaCreate, ulid } from 'emdash';
import { createDialect } from 'emdash/db/sqlite';
import { Kysely } from 'kysely';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// 最大リクエストボディサイズ (JSON用: 512KB, 単一画像ファイル用: 20MB)
const MAX_JSON_BODY_BYTES = 512 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGES_COUNT = 20;

const ALLOWED_MIME_TYPES = ['image/webp', 'image/jpeg', 'image/png'] as const;

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

/**
 * タイミング攻撃を防ぐ安全な文字列比較
 */
function safeTokenCompare(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const bufA = Buffer.from(provided);
  const bufB = Buffer.from(expected);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * ファイルバッファから画像タイプと幅・高さを抽出（マジックナンバー照合）
 */
function getImageInfo(buf: Buffer): { width: number; height: number; mime: string } | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return { width, height, mime: 'image/png' };
  }

  // JPEG: FF D8 FF
  if (buf.length > 4 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) {
    let offset = 2;
    while (offset < buf.length) {
      if (buf[offset] !== 0xFF) break;
      const marker = buf[offset + 1];
      if (marker === 0xC0 || marker === 0xC2) {
        const height = buf.readUInt16BE(offset + 5);
        const width = buf.readUInt16BE(offset + 7);
        return { width, height, mime: 'image/jpeg' };
      }
      const len = buf.readUInt16BE(offset + 2);
      offset += 2 + len;
    }
    return { width: 1080, height: 1080, mime: 'image/jpeg' };
  }

  // WebP: RIFF .... WEBP
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8X' && buf.length >= 30) {
      const width = 1 + buf.readUIntLE(24, 3);
      const height = 1 + buf.readUIntLE(27, 3);
      return { width, height, mime: 'image/webp' };
    } else if (chunk === 'VP8 ' && buf.length >= 30) {
      const width = buf.readUInt16LE(26) & 0x3fff;
      const height = buf.readUInt16LE(28) & 0x3fff;
      return { width, height, mime: 'image/webp' };
    } else if (chunk === 'VP8L' && buf.length >= 25) {
      const b1 = buf[21], b2 = buf[22], b3 = buf[23], b4 = buf[24];
      const width = 1 + (((b2 & 0x3f) << 8) | b1);
      const height = 1 + (((b4 & 0xf) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6));
      return { width, height, mime: 'image/webp' };
    }
    return { width: 1080, height: 1080, mime: 'image/webp' };
  }

  return null;
}

/**
 * ファイル名を安全にサニタイズ（path traversal防止）
 */
function sanitizeFilename(originalName: string): string {
  const base = path.basename(originalName);
  return base.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * AIタグの6カテゴリ検証
 */
const REQUIRED_AI_TAG_CATEGORIES = [
  'scene',
  'behavior',
  'appearance',
  'expression',
  'composition',
  'mood',
] as const;

function validateAiTags(tags: unknown): { isValid: boolean; error?: string } {
  if (typeof tags !== 'object' || tags === null || Array.isArray(tags)) {
    return { isValid: false, error: 'ai_tagsはオブジェクト形式である必要があります。' };
  }

  const tagObj = tags as Record<string, unknown>;
  for (const cat of REQUIRED_AI_TAG_CATEGORIES) {
    if (!Array.isArray(tagObj[cat])) {
      return {
        isValid: false,
        error: `ai_tags.${cat} は文字列の配列である必要があります。`,
      };
    }
    for (const item of tagObj[cat]) {
      if (typeof item !== 'string') {
        return {
          isValid: false,
          error: `ai_tags.${cat} の全要素は文字列である必要があります。`,
        };
      }
    }
  }

  return { isValid: true };
}

/**
 * GET: 簡易ヘルスチェック
 */
export const GET: APIRoute = async () => {
  return new Response(
    JSON.stringify({
      ok: true,
      service: 'nyans-import',
      mode: 'ready',
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }
  );
};

/**
 * POST: Automation用 Artwork Import API (dry-run & 実登録対応)
 */
export const POST: APIRoute = async ({ request }) => {
  // 1. 認証チェック
  const expectedToken =
    process.env.NYANS_IMPORT_TOKEN ||
    import.meta.env.NYANS_IMPORT_TOKEN;

  if (!expectedToken) {
    console.error('🚨 [nyans-import] NYANS_IMPORT_TOKEN is not configured on the server.');
    return errorResponse(500, 'SERVER_CONFIGURATION_ERROR', 'サーバーの認証設定が完了していません。');
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

  // 2. Content-Type チェックとボディパース
  const contentType = request.headers.get('content-type') || '';
  const isMultipart = contentType.includes('multipart/form-data');
  const isJson = contentType.includes('application/json');

  if (!isMultipart && !isJson) {
    return errorResponse(400, 'INVALID_CONTENT_TYPE', 'Content-Typeはapplication/jsonまたはmultipart/form-dataである必要があります。');
  }

  let body: any;
  let formData: FormData | null = null;

  if (isMultipart) {
    try {
      formData = await request.formData();
    } catch (err) {
      return errorResponse(400, 'READ_ERROR', 'multipart データの読み込みに失敗しました。');
    }

    const metadataEntry = formData.get('metadata');
    if (!metadataEntry || typeof metadataEntry !== 'string') {
      return errorResponse(400, 'VALIDATION_ERROR', 'multipart リクエストには metadata フィールド(JSON文字列)が必要です。');
    }

    try {
      body = JSON.parse(metadataEntry);
    } catch (err) {
      return errorResponse(400, 'INVALID_JSON', 'metadata フィールドのJSON構文が不正です。');
    }
  } else {
    // JSON リクエスト
    let rawBodyText: string;
    try {
      rawBodyText = await request.text();
    } catch (err) {
      return errorResponse(400, 'READ_ERROR', 'リクエストボディの読み込みに失敗しました。');
    }

    if (Buffer.byteLength(rawBodyText, 'utf8') > MAX_JSON_BODY_BYTES) {
      return errorResponse(413, 'PAYLOAD_TOO_LARGE', 'リクエストサイズが上限(512KB)を超えています。');
    }

    try {
      body = JSON.parse(rawBodyText);
    } catch (err) {
      return errorResponse(400, 'INVALID_JSON', 'リクエストボディのJSON構文が不正です。');
    }
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return errorResponse(400, 'INVALID_BODY', 'リクエストボディはJSONオブジェクトである必要があります。');
  }

  const isDryRun = body.dry_run === true;

  // 実登録 (dry_run === false) の場合は multipart/form-data が必須
  if (!isDryRun && !isMultipart) {
    return errorResponse(400, 'MULTIPART_REQUIRED', '実登録(dry_run=false)には画像ファイルが必要です。Content-Type: multipart/form-data でリクエストしてください。');
  }

  // 3. 基本項目バリデーション
  const requestId = typeof body.request_id === 'string' ? body.request_id.trim() : '';
  if (!requestId) {
    return errorResponse(400, 'VALIDATION_ERROR', 'request_id は必須の非空文字列です。');
  }
  if (requestId.length > 100) {
    return errorResponse(400, 'VALIDATION_ERROR', 'request_id は100文字以内である必要があります。');
  }

  const catSlug = typeof body.cat_slug === 'string' ? body.cat_slug.trim() : '';
  if (!catSlug) {
    return errorResponse(400, 'VALIDATION_ERROR', 'cat_slug は必須の非空文字列です。');
  }
  if (catSlug.length > 100) {
    return errorResponse(400, 'VALIDATION_ERROR', 'cat_slug は100文字以内である必要があります。');
  }

  // 4. artwork オブジェクトのバリデーション
  const artwork = body.artwork;
  if (!artwork || typeof artwork !== 'object' || Array.isArray(artwork)) {
    return errorResponse(400, 'VALIDATION_ERROR', 'artwork オブジェクトは必須です。');
  }

  const artworkSlug = typeof artwork.slug === 'string' ? artwork.slug.trim() : '';
  if (!artworkSlug) {
    return errorResponse(400, 'VALIDATION_ERROR', 'artwork.slug は必須の非空文字列です。');
  }
  if (artworkSlug.length > 100) {
    return errorResponse(400, 'VALIDATION_ERROR', 'artwork.slug は100文字以内である必要があります。');
  }

  const title = typeof artwork.title === 'string' ? artwork.title.trim() : '';
  if (!title) {
    return errorResponse(400, 'VALIDATION_ERROR', 'artwork.title は必須の非空文字列です。');
  }
  if (title.length > 200) {
    return errorResponse(400, 'VALIDATION_ERROR', 'artwork.title は200文字以内である必要があります。');
  }

  const comment = typeof artwork.comment === 'string' ? artwork.comment.trim() : '';
  if (comment.length > 2000) {
    return errorResponse(400, 'VALIDATION_ERROR', 'artwork.comment は2000文字以内である必要があります。');
  }

  let publishAtIso = new Date().toISOString();
  if (artwork.publish_at !== undefined && artwork.publish_at !== null) {
    if (typeof artwork.publish_at !== 'string' || isNaN(Date.parse(artwork.publish_at))) {
      return errorResponse(400, 'VALIDATION_ERROR', 'artwork.publish_at は有効なISO-8601日時文字列である必要があります。');
    }
    publishAtIso = new Date(artwork.publish_at).toISOString();
  }

  const aiSummary = typeof artwork.ai_summary === 'string' ? artwork.ai_summary.trim() : '';
  if (aiSummary.length > 2000) {
    return errorResponse(400, 'VALIDATION_ERROR', 'artwork.ai_summary は2000文字以内である必要があります。');
  }

  if (artwork.ai_tags !== undefined && artwork.ai_tags !== null) {
    const aiTagsResult = validateAiTags(artwork.ai_tags);
    if (!aiTagsResult.isValid) {
      return errorResponse(400, 'VALIDATION_ERROR', aiTagsResult.error || 'ai_tags の構造が不正です。');
    }
  }

  const instagramCaption = typeof artwork.instagram_caption === 'string' ? artwork.instagram_caption.trim() : '';
  if (instagramCaption.length > 2200) {
    return errorResponse(400, 'VALIDATION_ERROR', 'artwork.instagram_caption は2200文字以内である必要があります。');
  }

  // 5. images 配列のバリデーション
  const images = body.images;
  if (!Array.isArray(images) || images.length === 0) {
    return errorResponse(422, 'VALIDATION_ERROR', 'images は1件以上の配列である必要があります。');
  }
  if (images.length > MAX_IMAGES_COUNT) {
    return errorResponse(422, 'VALIDATION_ERROR', `images は最大${MAX_IMAGES_COUNT}件までです。`);
  }

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    if (!img || typeof img !== 'object') {
      return errorResponse(400, 'VALIDATION_ERROR', `images[${i}] はオブジェクトである必要があります。`);
    }

    const filename = typeof img.filename === 'string' ? img.filename.trim() : '';
    if (!filename) {
      return errorResponse(400, 'VALIDATION_ERROR', `images[${i}].filename は必須の非空文字列です。`);
    }
    if (filename.length > 255) {
      return errorResponse(400, 'VALIDATION_ERROR', `images[${i}].filename は255文字以内である必要があります。`);
    }

    if (typeof img.sort_order !== 'number' || !Number.isFinite(img.sort_order)) {
      return errorResponse(400, 'VALIDATION_ERROR', `images[${i}].sort_order は有限な数値である必要があります。`);
    }

    if (typeof img.gallery_visible !== 'boolean') {
      return errorResponse(400, 'VALIDATION_ERROR', `images[${i}].gallery_visible はboolean型である必要があります。`);
    }
  }

  // 6. Cat 存在確認 (DB読み取り)
  let cats: any[] = [];
  try {
    const res = await getEmDashCollection('cats', { status: 'published' });
    cats = Array.isArray(res) ? res : (res?.entries || []);
  } catch (err) {
    console.error('🚨 [nyans-import] Error fetching cats:', err);
    return errorResponse(500, 'DATABASE_ERROR', 'Cats コレクションの確認中にエラーが発生しました。');
  }

  const targetCat = cats.find(
    (c: any) => c.slug === catSlug || c.data?.slug === catSlug
  );

  if (!targetCat) {
    return errorResponse(422, 'CAT_NOT_FOUND', '指定されたCatが見つかりません。', {
      cat_slug: catSlug,
    });
  }

  // 7. 重複チェック (import_request_id および artwork.slug)
  let artworks: any[] = [];
  try {
    const res = await getEmDashCollection('artworks');
    artworks = Array.isArray(res) ? res : (res?.entries || []);
  } catch (err) {
    console.error('🚨 [nyans-import] Error fetching artworks:', err);
    return errorResponse(500, 'DATABASE_ERROR', 'Artworks コレクションの確認中にエラーが発生しました。');
  }

  const duplicateRequest = artworks.find(
    (a: any) => a.data?.import_request_id === requestId || a.import_request_id === requestId
  );
  if (duplicateRequest) {
    return errorResponse(409, 'DUPLICATE_REQUEST', '同じrequest_idのArtworkがすでに存在します。', {
      request_id: requestId,
      existing_artwork_slug: duplicateRequest.slug || duplicateRequest.data?.slug,
    });
  }

  const duplicateSlug = artworks.find(
    (a: any) => a.slug === artworkSlug || a.data?.slug === artworkSlug
  );
  if (duplicateSlug) {
    return errorResponse(409, 'DUPLICATE_SLUG', '同じslugのArtworkがすでに存在します。', {
      artwork_slug: artworkSlug,
    });
  }

  // 8. dry-run の場合はここで 200 OK を返却
  if (isDryRun) {
    const visibleImagesCount = images.filter((img: any) => img.gallery_visible === true).length;
    return new Response(
      JSON.stringify({
        ok: true,
        dry_run: true,
        request_id: requestId,
        validated: {
          cat_slug: catSlug,
          artwork_slug: artworkSlug,
          images: images.length,
          gallery_visible_images: visibleImagesCount,
        },
        would_create: {
          artwork: true,
          artwork_images: images.length,
        },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  // =========================================================================
  // 9. 実登録処理 (dry_run === false)
  // =========================================================================

  // 画像ファイルの抽出とバイナリ検証
  const preparedFiles: Array<{
    filename: string;
    buffer: Buffer;
    size: number;
    mime: string;
    width: number;
    height: number;
    sortOrder: number;
    galleryVisible: boolean;
  }> = [];

  const filesList = formData!.getAll('files');

  for (let i = 0; i < images.length; i++) {
    const imgMeta = images[i];
    const safeName = sanitizeFilename(imgMeta.filename);

    // 画像エントリの取得（filename一致、または files[i]、または file_i）
    let fileObj: File | null = null;
    const byName = formData!.get(imgMeta.filename);
    if (byName instanceof File) {
      fileObj = byName;
    } else if (filesList[i] instanceof File) {
      fileObj = filesList[i] as File;
    } else {
      const byIndex = formData!.get(`file_${i}`);
      if (byIndex instanceof File) {
        fileObj = byIndex;
      }
    }

    if (!fileObj) {
      return errorResponse(400, 'FILE_MISSING', `画像ファイルが見つかりません: ${imgMeta.filename}`, {
        index: i,
        filename: imgMeta.filename,
      });
    }

    if (fileObj.size > MAX_FILE_BYTES) {
      return errorResponse(413, 'FILE_TOO_LARGE', `画像サイズが上限(20MB)を超えています: ${imgMeta.filename}`);
    }

    const arrayBuf = await fileObj.arrayBuffer();
    const buf = Buffer.from(arrayBuf);
    const imgInfo = getImageInfo(buf);

    if (!imgInfo || !ALLOWED_MIME_TYPES.includes(imgInfo.mime as any)) {
      return errorResponse(400, 'INVALID_IMAGE_FILE', `サポートされていない画像形式または破損ファイルです: ${imgMeta.filename}`, {
        filename: imgMeta.filename,
        detected_mime: imgInfo?.mime || 'unknown',
        allowed_mimes: ALLOWED_MIME_TYPES,
      });
    }

    preparedFiles.push({
      filename: safeName,
      buffer: buf,
      size: buf.length,
      mime: imgInfo.mime,
      width: imgInfo.width,
      height: imgInfo.height,
      sortOrder: imgMeta.sort_order,
      galleryVisible: imgMeta.gallery_visible,
    });
  }

  // DB接続 & 管理者authorIdの取得
  const dialect = createDialect({ url: 'file:./data.db' });
  const db = new Kysely<any>({ dialect });

  let authorId: string = '01M58QKBNG52A1H7CGXEN583RP';
  try {
    const firstUser = await db.selectFrom('users').select('id').executeTakeFirst();
    if (firstUser?.id) {
      authorId = firstUser.id;
    }
  } catch (err) {
    console.warn('⚠️ [nyans-import] Could not query users table, using fallback authorId:', err);
  }

  // ロールバック用追跡バッファ
  const savedStorageKeys: string[] = [];
  const createdMediaIds: string[] = [];
  let createdArtworkId: string | null = null;
  let createdArtworkGroup: string | null = null;
  const createdArtworkImageIds: string[] = [];
  const createdArtworkImageGroups: string[] = [];

  const uploadsDir = path.resolve(process.cwd(), 'uploads');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  try {
    // -------------------------------------------------------------
    // ステップ A: メディアの保存 & handleMediaCreate
    // -------------------------------------------------------------
    const createdMediaObjects: any[] = [];

    for (const file of preparedFiles) {
      const ext = file.mime === 'image/webp' ? 'webp' : file.mime === 'image/png' ? 'png' : 'jpeg';
      const storageKey = `${ulid()}.${ulid()}.${ext}`;
      const filePath = path.join(uploadsDir, storageKey);

      // 実ファイルを保存
      fs.writeFileSync(filePath, file.buffer);
      savedStorageKeys.push(storageKey);

      const contentHash = `sha1:${crypto.createHash('sha1').update(file.buffer).digest('hex')}`;

      // EmDash公式 handleMediaCreate で media テーブルに登録
      const mediaResult = await handleMediaCreate(db, {
        filename: file.filename,
        mimeType: file.mime,
        size: file.size,
        storageKey,
        contentHash,
        width: file.width,
        height: file.height,
        authorId,
        status: 'ready',
      });

      if (!mediaResult.success) {
        throw new Error(`Media creation failed: ${mediaResult.error?.message || 'unknown error'}`);
      }

      const mediaItem = mediaResult.data.item;
      createdMediaIds.push(mediaItem.id);

      createdMediaObjects.push({
        mediaItem,
        file,
        imageObject: {
          id: mediaItem.id,
          provider: 'local',
          filename: mediaItem.filename,
          mimeType: mediaItem.mimeType,
          width: mediaItem.width,
          height: mediaItem.height,
          alt: '',
          meta: {
            storageKey: mediaItem.storageKey,
            caption: null,
            blurhash: null,
            dominantColor: null,
          },
        },
      });
    }

    // -------------------------------------------------------------
    // ステップ B: Artwork の作成 & Cat リレーション
    // -------------------------------------------------------------
    const artCreateResult = await handleContentCreate(db, 'artworks', {
      slug: artworkSlug,
      status: 'published',
      authorId,
      data: {
        title,
        cat_slug: catSlug,
        comment,
        publish_at: publishAtIso,
        ai_summary: aiSummary,
        ai_tags: artwork.ai_tags || null,
        jev_result: artwork.jev_result || null,
        instagram_caption: instagramCaption,
        instagram_publish_at: artwork.instagram_publish_at ? new Date(artwork.instagram_publish_at).toISOString() : null,
        postiz_status: 'pending',
        postiz_published_at: null,
        postiz_post_id: null,
        postiz_last_error: null,
        import_request_id: requestId,
      },
      references: {
        cat: [targetCat.id],
      },
    });

    if (!artCreateResult.success) {
      throw new Error(`Artwork creation failed: ${artCreateResult.error?.message || 'unknown error'}`);
    }

    const createdArtwork = artCreateResult.data.item;
    createdArtworkId = createdArtwork.id;
    createdArtworkGroup = createdArtwork.translationGroup || createdArtwork.id;

    // -------------------------------------------------------------
    // ステップ C: Artwork Images の作成 & Artwork リレーション
    // -------------------------------------------------------------
    const createdImagesSummary: any[] = [];

    for (let i = 0; i < createdMediaObjects.length; i++) {
      const { mediaItem, file, imageObject } = createdMediaObjects[i];
      const imgTitle = `${title}_${String(i + 1).padStart(2, '0')}`;
      const imgSlug = `${artworkSlug}-${String(i + 1).padStart(2, '0')}`;

      const imgCreateResult = await handleContentCreate(db, 'artwork_images', {
        slug: imgSlug,
        status: 'published',
        authorId,
        data: {
          title: imgTitle,
          artwork_slug: artworkSlug,
          sort_order: file.sortOrder,
          gallery_visible: file.galleryVisible,
          image: imageObject,
        },
        references: {
          artwork: [createdArtwork.id],
        },
      });

      if (!imgCreateResult.success) {
        throw new Error(`Artwork image creation failed at index ${i}: ${imgCreateResult.error?.message || 'unknown error'}`);
      }

      const createdImg = imgCreateResult.data.item;
      createdArtworkImageIds.push(createdImg.id);
      createdArtworkImageGroups.push(createdImg.translationGroup || createdImg.id);

      createdImagesSummary.push({
        id: createdImg.id,
        slug: createdImg.slug,
        title: imgTitle,
        sort_order: file.sortOrder,
        gallery_visible: file.galleryVisible,
      });
    }

    console.log(`✅ [nyans-import] Successfully created artwork: ${artworkSlug} (id: ${createdArtworkId}) with ${createdImagesSummary.length} images`);

    // -------------------------------------------------------------
    // 成功レスポンス: 201 Created
    // -------------------------------------------------------------
    return new Response(
      JSON.stringify({
        ok: true,
        dry_run: false,
        request_id: requestId,
        created: {
          artwork: {
            slug: artworkSlug,
            id: createdArtworkId,
            title,
          },
          images: createdImagesSummary,
        },
      }),
      {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (err: any) {
    console.error('🚨 [nyans-import] Error during import, starting cleanup rollback...', err);

    // ロールバック処理
    try {
      // 1. Artwork Images 削除
      for (const imgId of createdArtworkImageIds) {
        await db.deleteFrom('ec_artwork_images').where('id', '=', imgId).execute().catch(() => {});
      }
      for (const group of createdArtworkImageGroups) {
        await db.deleteFrom('_emdash_content_references').where('parent_group', '=', group).execute().catch(() => {});
      }

      // 2. Artwork 削除
      if (createdArtworkId) {
        await db.deleteFrom('ec_artworks').where('id', '=', createdArtworkId).execute().catch(() => {});
      }
      if (createdArtworkGroup) {
        await db.deleteFrom('_emdash_content_references').where('parent_group', '=', createdArtworkGroup).execute().catch(() => {});
      }

      // 3. Media 削除
      for (const mediaId of createdMediaIds) {
        await db.deleteFrom('media').where('id', '=', mediaId).execute().catch(() => {});
      }

      // 4. 保存済み実ファイルの削除
      for (const key of savedStorageKeys) {
        const filePath = path.join(uploadsDir, key);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      }
      console.log('🧹 [nyans-import] Rollback cleanup completed.');
    } catch (cleanupErr) {
      console.error('🚨 [nyans-import] Secondary error during rollback cleanup:', cleanupErr);
    }

    return errorResponse(500, 'IMPORT_FAILED', '作品登録処理中にエラーが発生しました。変更はロールバックされました。', {
      stage: 'transaction_failed',
      reason: err?.message || 'unknown error',
    });
  }
};
