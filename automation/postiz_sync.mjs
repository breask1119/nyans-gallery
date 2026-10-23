#!/usr/bin/env node

/**
 * ============================================================================
 * Nyans Gallery - Postiz Integration (STEP 7B.1: Live Schedule & Strict Guard)
 * ============================================================================
 * 
 * EmDashに登録済みのArtwork 1件について、
 * 1. 予約日時未来チェック（30分以上先、即時投稿禁止）
 * 2. 二重予約防止チェック（scheduled/published/post_id存在時は停止）
 * 3. perumofu Instagram Integration検証（GET /api/public/v1/integrations）
 * 4. 画像アップロード（POST /api/public/v1/upload）
 * 5. 投稿予約作成（POST /api/public/v1/posts, type="schedule" のみ）
 * 6. EmDash status更新（update-status API経由のみ。SQLiteフォールバック完全無効化）
 * を安全に実行します。
 * 
 * [SAFETY RULES]
 * - --slug=<slug> の指定が必須（一括処理禁止）。
 * - 即時投稿（type="now"）は絶対禁止。
 * - 予約日時が現在から30分以上未来でなければ停止。
 * - liveモードでupdate-status APIが失敗した場合、SQLite直接UPDATEは行わずエラー停止。
 * - 秘密情報（API Key, Token, Channel ID全文）をログに出力しません。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// Environment Variables Loader
// ============================================================================

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return false;
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
  return true;
}

const rootEnvPath = path.resolve(__dirname, '.env');
const aiWorkEnvPath = path.resolve(__dirname, '.ai-work', '.env');
loadEnvFile(rootEnvPath) || loadEnvFile(aiWorkEnvPath);

// セルフホストPostizでは /api プレフィックスが必要
let rawPostizUrl = (process.env.POSTIZ_API_URL || 'https://postiz.xx-ai-girls-miu.com').replace(/\/+$/, '');
const POSTIZ_BASE_URL = rawPostizUrl.endsWith('/api') ? rawPostizUrl : `${rawPostizUrl}/api`;

const POSTIZ_API_KEY = process.env.POSTIZ_API_KEY || '';
const NYANS_POSTIZ_CHANNEL_ID = process.env.NYANS_POSTIZ_CHANNEL_ID || '';
const NYANS_IMPORT_TOKEN = process.env.NYANS_IMPORT_TOKEN || '';

const NYANS_EMDASH_API_URL = (process.env.NYANS_EMDASH_API_URL || 'http://localhost:4321').replace(/\/+$/, '');
const NYANS_UPDATE_STATUS_URL = process.env.NYANS_UPDATE_STATUS_URL || `${NYANS_EMDASH_API_URL}/api/nyans/update-status`;

const NYANS_POSTIZ_DRY_RUN = process.env.NYANS_POSTIZ_DRY_RUN !== '0';

const GALLERY_ROOT = path.resolve(__dirname, '../gallery');
const DB_PATH = path.resolve(GALLERY_ROOT, 'data.db');
const UPLOADS_DIR = path.resolve(GALLERY_ROOT, 'uploads');

// ============================================================================
// Helpers
// ============================================================================

export function maskSecret(str) {
  if (!str) return '(not configured)';
  if (str.length <= 8) return '****';
  return str.slice(0, 4) + '...' + str.slice(-4);
}

// ============================================================================
// Postiz API Client Helpers
// ============================================================================

/**
 * 接続済みIntegration一覧を取得し、perumofu の Channel ID を厳格に検証
 */
export async function verifyPostizChannel(baseUrl, apiKey, expectedChannelId) {
  const endpoint = `${baseUrl}/public/v1/integrations`;
  console.log(`[Postiz API] Verifying Channel via GET ${endpoint} ...`);

  const response = await fetch(endpoint, {
    method: 'GET',
    headers: {
      Authorization: apiKey,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Integration一覧取得失敗: HTTP ${response.status} - ${errorText.slice(0, 300)}`);
  }

  const integrations = await response.json();
  if (!Array.isArray(integrations)) {
    throw new Error('Integrationsレスポンスが配列ではありません。');
  }

  const match = integrations.find((item) => item.id === expectedChannelId);
  if (!match) {
    throw new Error(`指定のChannel ID (${maskSecret(expectedChannelId)}) がPostizの接続済みIntegrationに見つかりません。`);
  }

  const identifier = match.providerIdentifier || match.identifier || match.provider || '';
  const name = match.name || '';
  const profile = match.profile || '';

  console.log(`[Postiz API] Channel verified:`);
  console.log(`  - Masked ID:   ${maskSecret(expectedChannelId)}`);
  console.log(`  - Platform:    ${identifier}`);
  console.log(`  - Name:        ${name}`);
  console.log(`  - Profile:     ${profile || '(none)'}`);

  // perumofu または猫アカウントであることを確認
  const isPerumofu = profile.toLowerCase().includes('perumofu') || 
                     name.includes('ペル') || 
                     name.includes('凛') || 
                     name.includes('ひなた');

  if (!isPerumofu) {
    throw new Error(`【安全停止】Channel ID (${maskSecret(expectedChannelId)}) は perumofu アカウントではありません！(検出: name='${name}', profile='${profile}')。美羽用などの別アカウントへの誤投稿を防止するため停止しました。`);
  }

  if (!identifier.includes('instagram')) {
    throw new Error(`【安全停止】Channel ID (${maskSecret(expectedChannelId)}) は Instagram Integration ではありません (provider='${identifier}')。`);
  }

  return match;
}

/**
 * 画像ファイルをPostizへアップロード (POST /api/public/v1/upload)
 */
export async function uploadMediaToPostiz(baseUrl, apiKey, filePath, mimeType) {
  const endpoint = `${baseUrl}/public/v1/upload`;
  const fileName = path.basename(filePath);

  if (!fs.existsSync(filePath)) {
    throw new Error(`アップロード対象ファイルが存在しません: ${filePath}`);
  }

  const fileBuffer = fs.readFileSync(filePath);
  const blob = new Blob([fileBuffer], { type: mimeType || 'image/jpeg' });
  const formData = new FormData();
  formData.append('file', blob, fileName);

  console.log(`[Postiz API] Uploading media: ${fileName} (${(fileBuffer.length / 1024).toFixed(1)} KB) ...`);

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: apiKey,
    },
    body: formData,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`画像アップロード失敗: HTTP ${response.status} - ${errText.slice(0, 300)}`);
  }

  const result = await response.json();
  const mediaId = result.id || result.mediaId;
  const mediaPath = result.path || result.url;

  if (!mediaPath || typeof mediaPath !== 'string') {
    throw new Error(`アップロードレスポンスに有効な path がありません: ${JSON.stringify(result)}`);
  }

  console.log(`[Postiz API] Upload success: ID=${mediaId || '(none)'}, Path=${mediaPath}`);
  return {
    id: mediaId,
    path: mediaPath,
    mimeType: result.mimeType || mimeType,
  };
}

/**
 * 予約投稿を作成 (POST /api/public/v1/posts, type="schedule")
 */
export async function createScheduledPost(baseUrl, apiKey, payload) {
  const endpoint = `${baseUrl}/public/v1/posts`;
  console.log(`[Postiz API] Creating scheduled post via POST ${endpoint} ...`);

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const respText = await response.text();
  let json = null;
  try {
    json = JSON.parse(respText);
  } catch {
    throw new Error(`投稿作成APIが不正なJSONを返しました (HTTP ${response.status}): ${respText.slice(0, 300)}`);
  }

  if (!response.ok) {
    throw new Error(`投稿作成失敗: HTTP ${response.status} - ${respText.slice(0, 300)}`);
  }

  // Post IDの抽出（Postizのレスポンス構造に柔軟に対応）
  const postId = json.id || 
                 json.postId || 
                 (Array.isArray(json) && (json[0]?.postId || json[0]?.id)) ||
                 json.posts?.[0]?.id || 
                 json.data?.id || 
                 null;

  console.log(`[Postiz API] Schedule post HTTP status: ${response.status}`);
  console.log(`[Postiz API] Full response:`, JSON.stringify(json, null, 2));
  console.log(`[Postiz API] Extracted Post ID: ${postId}`);

  if (!postId) {
    console.warn(`[Postiz API Warning] Post ID could not be cleanly extracted from top-level. Check full response above.`);
  }

  return {
    httpStatus: response.status,
    postId: postId || 'unknown_post_id',
    rawResponse: json,
  };
}

// ============================================================================
// EmDash Status Updater (LiveモードではSQLiteフォールバック完全無効化)
// ============================================================================

export async function updateEmDashStatusLive(slug, updateFields) {
  console.log(`[EmDash Live Update] Updating status for artwork '${slug}' via ${NYANS_UPDATE_STATUS_URL} ...`);

  const res = await fetch(NYANS_UPDATE_STATUS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NYANS_IMPORT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      slug,
      postiz_status: updateFields.postiz_status,
      postiz_post_id: updateFields.postiz_post_id ?? null,
      postiz_last_error: updateFields.postiz_last_error ?? null,
    }),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    // 【要件3】live時はSQLiteフォールバックを行わず、明示的エラーを投げる
    throw new Error(`【EmDash同期失敗】update-status APIが失敗しました (HTTP ${res.status}): ${errorBody.slice(0, 300)}。安全のためSQLite直接UPDATEは行いませんでした。`);
  }

  const data = await res.json();
  console.log(`[EmDash Live Update] Status successfully updated via API:`, data);
  return data;
}

// ============================================================================
// Main Runner
// ============================================================================

export async function runPostizSync(options = {}) {
  const targetSlug = options.slug || null;
  const forceLive = options.live === true;
  const isDryRun = forceLive ? false : (options.dryRun !== undefined ? options.dryRun : NYANS_POSTIZ_DRY_RUN);

  console.log('====================================================');
  console.log('🐱 Nyans Gallery - Postiz Live/Dry-Run Sync Pipeline');
  console.log('====================================================');
  console.log(`Mode:            ${isDryRun ? 'DRY-RUN (API未送信 / DB変更なし)' : 'LIVE (実予約投稿作成)'}`);
  console.log(`Postiz API URL:  ${POSTIZ_BASE_URL}`);
  console.log(`API Key:         ${maskSecret(POSTIZ_API_KEY)}`);
  console.log(`Channel ID:      ${maskSecret(NYANS_POSTIZ_CHANNEL_ID)}`);
  console.log(`Target Slug:     ${targetSlug || '(ERROR: NOT SPECIFIED)'}`);
  console.log('----------------------------------------------------');

  // 1. 対象指定の必須チェック
  if (!targetSlug || typeof targetSlug !== 'string' || !targetSlug.trim()) {
    throw new Error('【安全停止】--slug=<artwork-slug> の指定が必須です。事故防止のため全件自動処理は禁止されています。');
  }

  if (!fs.existsSync(DB_PATH)) {
    throw new Error(`EmDash DBが見つかりません: ${DB_PATH}`);
  }

  const db = new DatabaseSync(DB_PATH);

  // 2. Artwork取得
  const artwork = db.prepare(`
    SELECT id, slug, title, cat_slug, postiz_status, postiz_post_id, instagram_caption, instagram_publish_at 
    FROM ec_artworks 
    WHERE slug = ?
  `).get(targetSlug);

  if (!artwork) {
    throw new Error(`【安全停止】指定されたArtwork '${targetSlug}' が見つかりません。`);
  }

  console.log(`\n[Artwork Found] ${artwork.slug} (${artwork.title})`);
  console.log(`Cat:            ${artwork.cat_slug}`);
  console.log(`Postiz Status:  ${artwork.postiz_status}`);
  console.log(`Postiz Post ID: ${artwork.postiz_post_id || '(none)'}`);
  console.log(`Caption:        ${(artwork.instagram_caption || '').slice(0, 60)}...`);
  console.log(`Publish At:     ${artwork.instagram_publish_at || '(null)'}`);

  // 3. 二重予約防止チェック
  if (artwork.postiz_status === 'scheduled' || artwork.postiz_status === 'published' || artwork.postiz_post_id) {
    throw new Error(`【二重予約防止】Artwork '${artwork.slug}' は既に postiz_status='${artwork.postiz_status}', post_id='${artwork.postiz_post_id}' です。重複予約を防止するため処理を停止しました。`);
  }

  // 4. 予約日時の未来チェック（即時投稿禁止）
  if (!artwork.instagram_publish_at) {
    throw new Error('【安全停止】instagram_publish_at が設定されていません。即時投稿 (type="now") は禁止されています。');
  }

  const publishTime = new Date(artwork.instagram_publish_at).getTime();
  if (Number.isNaN(publishTime)) {
    throw new Error(`【安全停止】instagram_publish_at の形式が不正です: ${artwork.instagram_publish_at}`);
  }

  const nowTime = Date.now();
  if (publishTime <= nowTime) {
    throw new Error(`【安全停止】予約日時 (${artwork.instagram_publish_at}) が現在時刻以前（過去）です。未来日時を指定してください。`);
  }

  const minDiffMs = 30 * 60 * 1000; // 30分
  if (publishTime - nowTime < minDiffMs) {
    const diffMinutes = Math.floor((publishTime - nowTime) / (60 * 1000));
    throw new Error(`【安全停止】予約日時 (${artwork.instagram_publish_at}) が現在時刻から ${diffMinutes} 分後です。安全のため最低30分以上未来の日時を指定してください。予約日時を変更してください。`);
  }

  const publishIso = new Date(publishTime).toISOString();
  console.log(`[Schedule Verification] 予約日時は現在から約 ${Math.round((publishTime - nowTime) / (60 * 60 * 1000))} 時間後の未来です: ${publishIso} (OK)`);

  // 5. 子画像の取得（gallery_visibleに関係なく全画像、sort_order昇順）
  const imageRows = db.prepare(`
    SELECT id, artwork_slug, image, sort_order, gallery_visible 
    FROM ec_artwork_images 
    WHERE artwork_slug = ? 
    ORDER BY sort_order ASC
  `).all(artwork.slug);

  console.log(`[Images] 紐づく画像総数: ${imageRows.length} 枚 (gallery_visible含む)`);
  if (imageRows.length === 0) {
    throw new Error(`【安全停止】Artwork '${artwork.slug}' に紐づく画像が0枚です。`);
  }
  if (imageRows.length > 20) {
    throw new Error(`【安全停止】画像枚数が20枚を超えています (${imageRows.length} 枚)。Instagramの上限は20枚です。`);
  }

  const images = [];
  let lastOrder = 0;
  for (const row of imageRows) {
    let imageObj = null;
    try {
      imageObj = JSON.parse(row.image);
    } catch (err) {
      throw new Error(`画像メタデータのパース失敗 (ID: ${row.id}): ${err.message}`);
    }

    const storageKey = imageObj?.meta?.storageKey || null;
    const localFilePath = storageKey ? path.resolve(UPLOADS_DIR, storageKey) : null;
    const exists = localFilePath ? fs.existsSync(localFilePath) : false;

    if (!exists) {
      throw new Error(`【安全停止】画像の実体ファイルが存在しません: ${localFilePath}`);
    }

    if (row.sort_order <= lastOrder) {
      throw new Error(`【安全停止】sort_order の順序が不正です: 現在 ${row.sort_order}, 前回 ${lastOrder}`);
    }
    lastOrder = row.sort_order;

    images.push({
      id: row.id,
      sort_order: row.sort_order,
      gallery_visible: Boolean(row.gallery_visible),
      filename: imageObj?.filename || 'unknown',
      localFilePath,
      mimeType: imageObj?.mimeType || 'image/jpeg',
    });

    console.log(`  - Order ${row.sort_order}: [${row.gallery_visible ? 'Gallery: ON ' : 'Gallery: OFF'}] ${imageObj?.filename || row.id}`);
  }

  // 6. DRY-RUN の場合
  if (isDryRun) {
    console.log('\n[NYANS POSTIZ] DRY RUN');
    console.log(`Artwork:    ${artwork.slug}`);
    console.log(`Images:     ${images.length} (gallery_visible: ${images.filter(i => i.gallery_visible).length} on, ${images.filter(i => !i.gallery_visible).length} off)`);
    console.log(`Caption:    ${artwork.instagram_caption || '(empty)'}`);
    console.log(`Publish at: ${publishIso}`);
    console.log(`Channel:    ${NYANS_POSTIZ_CHANNEL_ID ? 'configured' : 'missing'}`);
    console.log('Payload validation: OK');

    const dryRunPayload = {
      type: 'schedule',
      date: publishIso,
      shortLink: false,
      tags: [],
      posts: [
        {
          integration: { id: NYANS_POSTIZ_CHANNEL_ID },
          value: [
            {
              content: artwork.instagram_caption || '',
              image: images.map(img => img.localFilePath),
            },
          ],
          settings: {
            __type: 'instagram-standalone',
            post_type: 'post',
          },
        },
      ],
    };
    console.log('\n[Generated Postiz Payload Preview (Dry-Run)]');
    console.log(JSON.stringify(dryRunPayload, null, 2));

    console.log('\n[Dry-Run] Postiz APIへの送信はスキップされました。');
    console.log('[Dry-Run] EmDash DBの更新はスキップされました。');
    return { dryRun: true, slug: artwork.slug, publishIso, imageCount: images.length };
  }

  // ==========================================================================
  // LIVE 実行フェーズ
  // ==========================================================================

  console.log('\n🚀 Starting LIVE Execution...');

  if (!POSTIZ_API_KEY) {
    throw new Error('【安全停止】POSTIZ_API_KEY が未設定です。.env に設定してください。');
  }
  if (!NYANS_POSTIZ_CHANNEL_ID) {
    throw new Error('【安全停止】NYANS_POSTIZ_CHANNEL_ID が未設定です。.env に設定してください。');
  }

  // 7. Channel事前検証 (GET /api/public/v1/integrations)
  let channelInfo;
  try {
    channelInfo = await verifyPostizChannel(POSTIZ_BASE_URL, POSTIZ_API_KEY, NYANS_POSTIZ_CHANNEL_ID);
  } catch (err) {
    throw new Error(`【安全停止】Channel検証に失敗しました: ${err.message}`);
  }

  const integrationIdentifier = channelInfo.providerIdentifier || channelInfo.identifier || 'instagram-standalone';

  // 8. 画像アップロード (POST /api/public/v1/upload)
  const uploadedMedia = [];
  try {
    for (const img of images) {
      const mediaResult = await uploadMediaToPostiz(POSTIZ_BASE_URL, POSTIZ_API_KEY, img.localFilePath, img.mimeType);
      uploadedMedia.push({
        id: mediaResult.id,
        path: mediaResult.path,
      });
    }
  } catch (uploadErr) {
    console.error('\n❌ 画像アップロード中にエラーが発生しました。Postiz posts API の呼び出しは直ちに中止します。');
    console.error('エラー詳細:', uploadErr.message);

    // EmDash statusは pending のまま、last_error に記録 (API経由)
    try {
      await updateEmDashStatusLive(artwork.slug, {
        postiz_status: 'pending',
        postiz_last_error: `Media upload failed: ${uploadErr.message.slice(0, 200)}`,
      });
    } catch (e) {
      console.error('Status update failed:', e.message);
    }

    throw uploadErr;
  }

  // 9. 投稿Payload構築
  const livePayload = {
    type: 'schedule', // 厳格に schedule のみ (type="now" 禁止)
    date: publishIso,
    shortLink: false,
    tags: [],
    posts: [
      {
        integration: {
          id: NYANS_POSTIZ_CHANNEL_ID,
        },
        value: [
          {
            content: artwork.instagram_caption || '',
            image: uploadedMedia, // アップロードされたPostiz media objects
          },
        ],
        settings: {
          __type: integrationIdentifier,
          post_type: 'post',
        },
      },
    ],
  };

  console.log('\n[Postiz Live Payload]');
  console.log(JSON.stringify(livePayload, null, 2));

  // 10. 投稿作成 (POST /api/public/v1/posts)
  let postResult;
  try {
    postResult = await createScheduledPost(POSTIZ_BASE_URL, POSTIZ_API_KEY, livePayload);
  } catch (postErr) {
    console.error('\n❌ 予約投稿作成中にエラーが発生しました。');
    console.error('エラー詳細:', postErr.message);

    // EmDash statusを failed に更新 (API経由)
    try {
      await updateEmDashStatusLive(artwork.slug, {
        postiz_status: 'failed',
        postiz_post_id: null,
        postiz_last_error: `Post schedule failed: ${postErr.message.slice(0, 200)}`,
      });
    } catch (e) {
      console.error('Status update failed:', e.message);
    }

    throw postErr;
  }

  // 11. EmDash ステータス更新（成功時、API経由のみ）
  console.log('\n[EmDash Sync] Updating EmDash postiz_status to "scheduled" via API ...');
  const updateResult = await updateEmDashStatusLive(artwork.slug, {
    postiz_status: 'scheduled',
    postiz_post_id: postResult.postId,
    postiz_last_error: null,
  });

  console.log('\n====================================================');
  console.log('🎉 予約投稿の作成が正常に完了しました！');
  console.log(`Artwork:         ${artwork.slug}`);
  console.log(`Postiz Post ID:  ${postResult.postId}`);
  console.log(`Publish Date:    ${publishIso}`);
  console.log(`EmDash Status:   scheduled`);
  console.log(`Update Method:   update-status API (SQLite direct update was NOT used)`);
  console.log('====================================================');

  return {
    success: true,
    slug: artwork.slug,
    postId: postResult.postId,
    publishIso,
    updateResult,
  };
}

// CLI実行時
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let slug = null;
  let forceLive = false;
  let forceDryRun = false;

  for (const arg of args) {
    if (arg.startsWith('--slug=')) {
      slug = arg.slice('--slug='.length);
    } else if (arg === '--slug') {
      const idx = args.indexOf(arg);
      if (args[idx + 1]) slug = args[idx + 1];
    } else if (arg === '--live') {
      forceLive = true;
    } else if (arg === '--dry-run') {
      forceDryRun = true;
    }
  }

  runPostizSync({
    slug,
    live: forceLive,
    dryRun: forceDryRun ? true : undefined,
  }).catch((err) => {
    console.error('\n[EXIT ERROR]', err.message);
    process.exit(1);
  });
}
