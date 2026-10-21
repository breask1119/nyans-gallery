#!/usr/bin/env node

/**
 * ============================================================================
 * Nyans Gallery - Postiz Status Sync (STEP 7C: Published Sync & Verification)
 * ============================================================================
 * 
 * EmDash上の scheduled Artwork について、Postizの実状態を確認し、
 * Instagramへの公開完了が確認できた場合のみ EmDash を published に更新します。
 * 
 * [SAFETY RULES]
 * - 投稿作成（POST /posts、Media Upload等）は一切行いません。状態確認のみ。
 * - --slug=<slug> の指定が必須（全件自動処理禁止）。
 * - 予約時間経過という理由だけで published にしません（Postiz側の実stateを確認）。
 * - EmDash更新は update-status API のみを使用（SQLite直接UPDATE禁止）。
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

let rawPostizUrl = (process.env.POSTIZ_API_URL || 'https://postiz.xx-ai-girls-miu.com').replace(/\/+$/, '');
const POSTIZ_BASE_URL = rawPostizUrl.endsWith('/api') ? rawPostizUrl : `${rawPostizUrl}/api`;

const POSTIZ_API_KEY = process.env.POSTIZ_API_KEY || '';
const NYANS_POSTIZ_CHANNEL_ID = process.env.NYANS_POSTIZ_CHANNEL_ID || '';
const NYANS_IMPORT_TOKEN = process.env.NYANS_IMPORT_TOKEN || '';
const NYANS_UPDATE_STATUS_URL = process.env.NYANS_UPDATE_STATUS_URL || 'http://127.0.0.1:4321/api/nyans/update-status';

// NYANS_POSTIZ_STATUS_DRY_RUN: '0' のみ live 実行許可。それ以外は dry-run
const NYANS_POSTIZ_STATUS_DRY_RUN = process.env.NYANS_POSTIZ_STATUS_DRY_RUN !== '0';

const GALLERY_ROOT = path.resolve(__dirname, '../gallery');
const DB_PATH = path.resolve(GALLERY_ROOT, 'data.db');

// ============================================================================
// Helpers
// ============================================================================

export function maskSecret(str) {
  if (!str) return '(not configured)';
  if (str.length <= 8) return '****';
  return str.slice(0, 4) + '...' + str.slice(-4);
}

// ============================================================================
// Postiz Post Fetcher Helper
// ============================================================================

/**
 * 予約日時の前後を含む期間で posts 一覧を取得し、対象の post_id を検索
 */
export async function fetchPostizPost(baseUrl, apiKey, postId, targetDateIso) {
  const baseTime = targetDateIso ? new Date(targetDateIso).getTime() : Date.now();
  const twoDaysMs = 2 * 24 * 60 * 60 * 1000;
  const startDate = new Date(baseTime - twoDaysMs).toISOString();
  const endDate = new Date(baseTime + twoDaysMs).toISOString();

  const endpoint = `${baseUrl}/public/v1/posts?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`;
  console.log(`[Postiz API] Fetching posts for window ${startDate.slice(0, 10)} to ${endDate.slice(0, 10)} ...`);

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        Authorization: apiKey,
        Accept: 'application/json',
      },
    });
  } catch (netErr) {
    throw new Error(`Postiz接続エラー (ネットワーク不通/タイムアウト): ${netErr.message}`);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Postiz posts取得失敗: HTTP ${response.status} - ${errorText.slice(0, 200)}`);
  }

  const data = await response.json();
  const posts = data.posts || [];
  const found = posts.find((p) => p.id === postId || p.postId === postId);

  if (!found) {
    throw new Error(`Postiz上に該当のPost ID (${postId}) が見つかりませんでした (期間: ${startDate.slice(0, 10)} 〜 ${endDate.slice(0, 10)}, 取得件数: ${posts.length}件)。`);
  }

  return found;
}

// ============================================================================
// EmDash Status Updater (API経由のみ・SQLite直接操作禁止)
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
      postiz_published_at: updateFields.postiz_published_at ?? null,
      postiz_last_error: updateFields.postiz_last_error ?? null,
    }),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`【EmDash同期失敗】update-status APIが失敗しました (HTTP ${res.status}): ${errorBody.slice(0, 300)}。安全のためSQLite直接UPDATEは行いませんでした。`);
  }

  const data = await res.json();
  console.log(`[EmDash Live Update] Status successfully updated via API:`, data);
  return data;
}

// ============================================================================
// Main Runner
// ============================================================================

export async function runStatusSync(options = {}) {
  const targetSlug = options.slug || null;
  const forceLive = options.live === true;
  const isDryRun = forceLive ? false : (options.dryRun !== undefined ? options.dryRun : NYANS_POSTIZ_STATUS_DRY_RUN);

  // 1. 対象指定の必須チェック
  if (!targetSlug || typeof targetSlug !== 'string' || !targetSlug.trim()) {
    throw new Error('【安全停止】--slug=<artwork-slug> の指定が必須です。安全のため全件自動処理は行いません。');
  }

  if (!fs.existsSync(DB_PATH)) {
    throw new Error(`EmDash DBが見つかりません: ${DB_PATH}`);
  }

  const db = new DatabaseSync(DB_PATH);

  // 2. Artwork取得 & 対象条件チェック
  const artwork = db.prepare(`
    SELECT id, slug, title, cat_slug, postiz_status, postiz_post_id, instagram_caption, instagram_publish_at, postiz_published_at, postiz_last_error 
    FROM ec_artworks 
    WHERE slug = ?
  `).get(targetSlug);

  if (!artwork) {
    throw new Error(`【安全停止】指定されたArtwork '${targetSlug}' がEmDashに見つかりません。`);
  }

  // 既に published の場合
  if (artwork.postiz_status === 'published') {
    console.log('========================================');
    console.log('🐱 Nyans Postiz Status Sync');
    console.log('========================================');
    console.log(`Artwork:       ${artwork.slug}`);
    console.log(`Status:        already published (同期済み)`);
    console.log(`Published At:  ${artwork.postiz_published_at || '(none)'}`);
    console.log(`Postiz ID:     ${maskSecret(artwork.postiz_post_id)}`);
    console.log('Result:        既に同期済みのため、処理を終了しました。');
    console.log('EmDash update: なし');
    console.log('========================================');
    return { status: 'already_published', slug: artwork.slug };
  }

  // scheduled かつ postiz_post_id がある場合のみ対象
  if (artwork.postiz_status !== 'scheduled' || !artwork.postiz_post_id) {
    throw new Error(`【対象外】Artwork '${artwork.slug}' のステータスは '${artwork.postiz_status}' (post_id: ${artwork.postiz_post_id || 'なし'}) です。scheduled かつ postiz_post_id が存在する作品のみが確認対象です。`);
  }

  if (!POSTIZ_API_KEY) {
    throw new Error('【安全停止】POSTIZ_API_KEY が未設定です。.env に設定してください。');
  }

  // 3. Postiz実状態取得
  let postizPost;
  try {
    postizPost = await fetchPostizPost(POSTIZ_BASE_URL, POSTIZ_API_KEY, artwork.postiz_post_id, artwork.instagram_publish_at);
  } catch (fetchErr) {
    // ネットワークエラーや一時的エラーの場合は Artwork を failed にせず停止
    console.error(`\n[Postiz Sync Error] ${fetchErr.message}`);
    console.log(`EmDash status '${artwork.postiz_status}' を維持して処理を中断しました。`);
    throw fetchErr;
  }

  // 4. Integration再確認 (perumofu Instagram であること)
  const postIntegrationId = postizPost.integration?.id || '';
  const postProvider = postizPost.integration?.providerIdentifier || '';
  const postName = postizPost.integration?.name || '';

  if (postIntegrationId && NYANS_POSTIZ_CHANNEL_ID && postIntegrationId !== NYANS_POSTIZ_CHANNEL_ID) {
    throw new Error(`【安全停止】PostizのIntegration ID (${maskSecret(postIntegrationId)}) が設定値 (${maskSecret(NYANS_POSTIZ_CHANNEL_ID)}) と一致しません。`);
  }

  // 5. 状態の判定
  const state = postizPost.state || '(unknown)';
  const releaseURL = postizPost.releaseURL || null;
  const publishDate = postizPost.publishDate || null;

  let syncResult = 'UNKNOWN';
  let shouldUpdate = false;
  let newStatus = artwork.postiz_status;
  let newPublishedAt = null;
  let newLastError = null;

  if (state === 'QUEUE' && !releaseURL) {
    // 予約待機中
    syncResult = '予約待機中';
    shouldUpdate = false;
  } else if (state === 'PUBLISHED') {
    // 公開完了
    syncResult = '公開完了 (Instagram公開確認済み)';
    shouldUpdate = true;
    newStatus = 'published';
    newPublishedAt = publishDate || artwork.instagram_publish_at || new Date().toISOString();
    newLastError = null;
  } else if (state === 'ERROR' || state === 'FAILED') {
    // 投稿失敗
    syncResult = `投稿失敗 (Postiz state: ${state})`;
    shouldUpdate = true;
    newStatus = 'failed';
    newPublishedAt = null;
    newLastError = `Postiz execution failed (state: ${state})`;
  } else {
    // その他の中間ステータス
    syncResult = `待機中 / 処理中 (state: ${state})`;
    shouldUpdate = false;
  }

  // 6. ログ表示 (要件17フォーマット)
  console.log('\n========================================');
  console.log('🐱 Nyans Postiz Status Sync');
  console.log('========================================');
  console.log(`Artwork:       ${artwork.slug}`);
  console.log(`Postiz ID:     ${maskSecret(artwork.postiz_post_id)}`);
  console.log(`State:         ${state}`);
  console.log(`Release URL:   ${releaseURL || 'なし'}`);
  if (releaseURL) {
    console.log(`Published:     ${releaseURL}`);
  }
  console.log(`Result:        ${syncResult}`);
  console.log(`Mode:          ${isDryRun ? 'DRY-RUN' : 'LIVE'}`);
  console.log(`EmDash update: ${shouldUpdate ? (isDryRun ? `予定 (${newStatus})` : '実行') : 'なし'}`);
  console.log('========================================\n');

  // 7. EmDash更新処理
  if (!shouldUpdate) {
    console.log(`[Result] Postiz側はまだ公開完了していません (state: ${state})。EmDash postiz_status='scheduled' を維持します。`);
    return {
      slug: artwork.slug,
      state,
      releaseURL,
      updated: false,
      status: artwork.postiz_status,
    };
  }

  // 更新が必要な場合（PUBLISHED または FAILED）
  if (isDryRun) {
    console.log(`[Dry-Run] EmDash更新予定内容:`);
    console.log(`  - postiz_status:       ${newStatus}`);
    console.log(`  - postiz_published_at: ${newPublishedAt || 'null'}`);
    console.log(`  - postiz_post_id:      ${artwork.postiz_post_id}`);
    console.log(`  - postiz_last_error:   ${newLastError || 'null'}`);
    console.log(`[Dry-Run] NYANS_POSTIZ_STATUS_DRY_RUN=1 のため、update-status APIの呼び出しはスキップされました。`);
    return {
      slug: artwork.slug,
      state,
      releaseURL,
      dryRun: true,
      pendingUpdate: {
        postiz_status: newStatus,
        postiz_published_at: newPublishedAt,
      },
    };
  }

  // LIVE 実行
  console.log(`[Live Update] Updating EmDash via update-status API ...`);
  const updateRes = await updateEmDashStatusLive(artwork.slug, {
    postiz_status: newStatus,
    postiz_published_at: newPublishedAt,
    postiz_post_id: artwork.postiz_post_id,
    postiz_last_error: newLastError,
  });

  console.log(`🎉 EmDash status successfully synchronized to '${newStatus}'!`);
  return {
    slug: artwork.slug,
    state,
    releaseURL,
    updated: true,
    apiResponse: updateRes,
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

  runStatusSync({
    slug,
    live: forceLive,
    dryRun: forceDryRun ? true : undefined,
  }).catch((err) => {
    console.error('\n[EXIT ERROR]', err.message);
    process.exit(1);
  });
}
