#!/usr/bin/env node

/**
 * ============================================================================
 * Nyans Gallery - Postiz Status Sync (STEP 7D: Automated Batch/Single Sync)
 * ============================================================================
 * 
 * EmDash上の scheduled Artwork（1件または--allで全件）について、
 * Postiz APIから実状態を取得し、Instagram公開完了が確認できた場合のみ
 * update-status API経由で EmDash を published に同期します。
 * 
 * [SAFETY RULES]
 * - 投稿作成（POST /posts、Media Upload等）は一切行いません。状態確認のみ。
 * - 予約時間経過という理由だけで published にしません（Postiz側の実stateを確認）。
 * - EmDash更新は update-status API のみを使用（SQLite直接UPDATE禁止）。
 * - 1件のエラーで全体を停止させず、個別try/catchで安全に集計。
 * - 二重起動防止ロックファイル（.ai-work/postiz-status-sync.lock）を完備。
 * - 秘密情報（API Key, Token, Channel ID全文）をログ・ファイルに出力しません。
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

const PROD_BASE_URL = 'https://cats.t2-site.work';
const LOCAL_BASE_URL = (process.env.NYANS_EMDASH_API_URL || 'http://localhost:4321').replace(/\/+$/, '');

const cliArgs = process.argv.slice(2);
const isProdCli = cliArgs.includes('--prod') || cliArgs.includes('--production');
const isProdEnv = (process.env.NYANS_ENV || '').toLowerCase() === 'production';
const isProduction = isProdCli || isProdEnv;

const NYANS_EMDASH_API_URL = isProduction ? PROD_BASE_URL : LOCAL_BASE_URL;
const NYANS_UPDATE_STATUS_URL = process.env.NYANS_UPDATE_STATUS_URL || `${NYANS_EMDASH_API_URL}/api/nyans/update-status`;
const NYANS_SCHEDULED_POSTS_URL = `${NYANS_EMDASH_API_URL}/api/nyans/scheduled-posts`;

// NYANS_POSTIZ_STATUS_DRY_RUN: '0' のみ live 実行許可。それ以外（1や未設定）は安全のため dry-run
const NYANS_POSTIZ_STATUS_DRY_RUN = process.env.NYANS_POSTIZ_STATUS_DRY_RUN !== '0';

// [Cloudflare D1 移行時の課題メモ]
// 現在はローカル運用の安全設計として、SQLite直接UPDATEは禁止し update-status API 経由で更新していますが、
// scheduled 作品の一覧取得（SELECT）は local の data.db を直接参照しています。
// 将来 Cloudflare D1 移行時はローカルファイルシステム上の data.db がなくなるため、
// 以下の SELECT 処理を EmDash 側の API（例: GET /api/nyans/scheduled-posts）へ移行する必要があります。
const GALLERY_ROOT = path.resolve(__dirname, '../gallery');
const DB_PATH = path.resolve(GALLERY_ROOT, 'data.db');
const LOCK_FILE = path.resolve(__dirname, '.ai-work', 'postiz-status-sync.lock');
const LOGS_DIR = path.resolve(__dirname, 'logs');

// ============================================================================
// Logger & Helpers
// ============================================================================

export function maskSecret(str) {
  if (!str) return '(not configured)';
  if (str.length <= 8) return '****';
  return str.slice(0, 4) + '...' + str.slice(-4);
}

function getLogFilePath() {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return path.resolve(LOGS_DIR, `postiz-status-sync-${year}-${month}.log`);
}

export function logMessage(msg, alsoConsole = true) {
  if (alsoConsole) {
    console.log(msg);
  }
  try {
    const timestamp = new Date().toISOString();
    const logPath = getLogFilePath();
    fs.appendFileSync(logPath, `[${timestamp}] ${msg}\n`, 'utf8');
  } catch (err) {
    console.error('Failed to append to log file:', err.message);
  }
}

// ============================================================================
// Lock Management (二重起動防止)
// ============================================================================

export function acquireLock() {
  const lockDir = path.dirname(LOCK_FILE);
  if (!fs.existsSync(lockDir)) {
    fs.mkdirSync(lockDir, { recursive: true });
  }

  if (fs.existsSync(LOCK_FILE)) {
    try {
      const stats = fs.statSync(LOCK_FILE);
      const ageMs = Date.now() - stats.mtimeMs;
      const MAX_LOCK_AGE_MS = 30 * 60 * 1000; // 30分

      if (ageMs > MAX_LOCK_AGE_MS) {
        logMessage(`[Lock] 古いロックファイル（作成から約 ${Math.round(ageMs / 60000)} 分経過）を検出したため強制解除しました。`);
        fs.unlinkSync(LOCK_FILE);
      } else {
        logMessage(`[Lock] 別の同期処理が実行中のため処理を安全にスキップしました (Lock: ${LOCK_FILE})。`);
        return false;
      }
    } catch (e) {
      logMessage(`[Lock Warning] ロックファイル確認エラー: ${e.message}`);
    }
  }

  try {
    fs.writeFileSync(LOCK_FILE, JSON.stringify({
      pid: process.pid,
      time: new Date().toISOString(),
    }), { flag: 'wx' });
    return true;
  } catch (err) {
    logMessage(`[Lock] ロックファイルの作成に失敗しました (並行実行を検出): ${err.message}`);
    return false;
  }
}

export function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch (e) {
    console.error('[Lock Error] ロックファイルの解除に失敗しました:', e.message);
  }
}

// ============================================================================
// Postiz API Client Helper
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
    throw new Error(`Postiz接続エラー (通信失敗/タイムアウト): ${netErr.message}`);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Postiz posts取得失敗: HTTP ${response.status} - ${errorText.slice(0, 200)}`);
  }

  const data = await response.json();
  const posts = data.posts || [];
  const found = posts.find((p) => p.id === postId || p.postId === postId);

  if (!found) {
    throw new Error(`Postiz上に該当のPost ID (${maskSecret(postId)}) が見つかりませんでした (期間: ${startDate.slice(0, 10)} 〜 ${endDate.slice(0, 10)}, 取得件数: ${posts.length}件)。`);
  }

  return found;
}

// ============================================================================
// EmDash Status Updater (API経由のみ・SQLite直接UPDATE完全禁止)
// ============================================================================

export async function updateEmDashStatusLive(slug, updateFields) {
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
    throw new Error(`【EmDash同期失敗】update-status APIが失敗しました (HTTP ${res.status}): ${errorBody.slice(0, 200)}。安全のためSQLite直接UPDATEは行いませんでした。`);
  }

  return await res.json();
}

// ============================================================================
// Single Artwork Processor
// ============================================================================

export async function processArtwork(artwork, isDryRun) {
  logMessage(`----------------------------------------------------`);
  logMessage(`[Checking Artwork] ${artwork.slug} (${artwork.title})`);
  logMessage(`  Current Status: ${artwork.postiz_status}`);
  logMessage(`  Postiz Post ID: ${maskSecret(artwork.postiz_post_id)}`);
  logMessage(`  Publish At:     ${artwork.instagram_publish_at || '(null)'}`);

  // 1. Postiz実状態取得
  const postizPost = await fetchPostizPost(POSTIZ_BASE_URL, POSTIZ_API_KEY, artwork.postiz_post_id, artwork.instagram_publish_at);

  // 2. Integration再確認 (perumofu Instagram であること)
  const postIntegrationId = postizPost.integration?.id || '';
  const postProvider = postizPost.integration?.providerIdentifier || '';
  const postName = postizPost.integration?.name || '';

  if (postIntegrationId && NYANS_POSTIZ_CHANNEL_ID && postIntegrationId !== NYANS_POSTIZ_CHANNEL_ID) {
    throw new Error(`【安全停止】PostizのIntegration ID (${maskSecret(postIntegrationId)}) が設定値 (${maskSecret(NYANS_POSTIZ_CHANNEL_ID)}) と一致しません。`);
  }

  // 3. 状態の判定
  const state = postizPost.state || '(unknown)';
  const releaseURL = postizPost.releaseURL || null;
  const publishDate = postizPost.publishDate || null;

  logMessage(`  Postiz State:   ${state}`);
  logMessage(`  Release URL:    ${releaseURL || '(none)'}`);

  if (state === 'QUEUE' && !releaseURL) {
    logMessage(`  Result:         予約待機中 (EmDash更新なし, scheduled維持)`);
    return { outcome: 'waiting', slug: artwork.slug, state };
  }

  if (state === 'PUBLISHED' && releaseURL !== null) {
    const publishedAt = publishDate || artwork.instagram_publish_at || new Date().toISOString();
    logMessage(`  Result:         公開完了 (Instagram公開確認済み: ${releaseURL})`);

    if (isDryRun) {
      logMessage(`  [Dry-Run] EmDash更新予定: postiz_status='published', published_at='${publishedAt}' (API未送信)`);
      return { outcome: 'published_dryrun', slug: artwork.slug, state, releaseURL, publishedAt };
    }

    // LIVE 更新
    logMessage(`  [Live Update] update-status API へ送信中 ...`);
    const updateRes = await updateEmDashStatusLive(artwork.slug, {
      postiz_status: 'published',
      postiz_published_at: publishedAt,
      postiz_post_id: artwork.postiz_post_id,
      postiz_last_error: null,
    });
    logMessage(`  [Live Update] EmDash同期成功: postiz_status='published'`);
    return { outcome: 'published', slug: artwork.slug, state, releaseURL, publishedAt, updateRes };
  }

  if (state === 'ERROR' || state === 'FAILED') {
    const errorMsg = `Postiz execution failed (state: ${state})`;
    logMessage(`  Result:         投稿失敗 (state: ${state})`);

    if (isDryRun) {
      logMessage(`  [Dry-Run] EmDash更新予定: postiz_status='failed' (API未送信)`);
      return { outcome: 'failed_dryrun', slug: artwork.slug, state, errorMsg };
    }

    // LIVE 更新
    logMessage(`  [Live Update] update-status API へエラー送信中 ...`);
    await updateEmDashStatusLive(artwork.slug, {
      postiz_status: 'failed',
      postiz_published_at: null,
      postiz_post_id: artwork.postiz_post_id,
      postiz_last_error: errorMsg,
    });
    logMessage(`  [Live Update] EmDash同期成功: postiz_status='failed'`);
    return { outcome: 'failed', slug: artwork.slug, state, errorMsg };
  }

  logMessage(`  Result:         待機中 / 処理中 (state: ${state}, EmDash更新なし)`);
  return { outcome: 'waiting', slug: artwork.slug, state };
}

// ============================================================================
// Main Runner
// ============================================================================

export async function runStatusSync(options = {}) {
  const isAll = options.all === true;
  const targetSlug = options.slug || null;
  const forceLive = options.live === true;
  const isDryRun = forceLive ? false : (options.dryRun !== undefined ? options.dryRun : NYANS_POSTIZ_STATUS_DRY_RUN);
  const dryRunControl = forceLive 
    ? 'CLI (--live)' 
    : (options.dryRun !== undefined 
        ? 'CLI (--dry-run)' 
        : `env: NYANS_POSTIZ_STATUS_DRY_RUN=${process.env.NYANS_POSTIZ_STATUS_DRY_RUN ?? '(unset, default dry-run)'}`);

  if (!isAll && !targetSlug) {
    throw new Error('【安全停止】--all または --slug=<artwork-slug> のいずれかの指定が必須です。');
  }

  // 1. ロックの取得 (二重起動防止)
  if (!acquireLock()) {
    return { skipped: true, reason: 'locked' };
  }

  try {
    logMessage('========================================');
    logMessage('🐱 Nyans Postiz Status Sync');
    logMessage('========================================');
    logMessage(`Environment:   ${isProduction ? 'PRODUCTION' : 'LOCAL'}`);
    logMessage(`Mode:          ${isDryRun ? 'DRY-RUN (EmDash更新なし)' : 'LIVE (実同期実行)'} [${dryRunControl}]`);
    logMessage(`Scope:         ${isAll ? 'ALL scheduled artworks' : `Single artwork (${targetSlug})`}`);
    logMessage(`Postiz API:    ${POSTIZ_BASE_URL}`);
    logMessage(`Channel ID:    ${maskSecret(NYANS_POSTIZ_CHANNEL_ID)}`);
    logMessage(`EmDash API:    ${NYANS_EMDASH_API_URL}`);
    logMessage(`Update URL:    ${NYANS_UPDATE_STATUS_URL}`);
    logMessage('----------------------------------------');

    let targetArtworks = [];

    if (isProduction) {
      // 本番モード: Cloudflare D1 直接参照は禁止。GET /api/nyans/scheduled-posts API から取得
      logMessage(`[Scheduled-Posts API] ${NYANS_SCHEDULED_POSTS_URL} から scheduled 作品を取得中...`);
      const apiRes = await fetch(NYANS_SCHEDULED_POSTS_URL, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${NYANS_IMPORT_TOKEN}`,
          Accept: 'application/json',
        },
      });

      if (!apiRes.ok) {
        const errText = await apiRes.text();
        throw new Error(`scheduled-posts API取得失敗 (HTTP ${apiRes.status}): ${errText.slice(0, 200)}`);
      }

      const apiData = await apiRes.json();
      const allScheduled = apiData.posts || [];

      if (isAll) {
        targetArtworks = allScheduled;
      } else {
        const found = allScheduled.find(a => a.slug === targetSlug);
        if (!found) {
          throw new Error(`【対象外 / 見つかりません】本番APIの scheduled リストに '${targetSlug}' が見つかりませんでした (現在scheduled件数: ${allScheduled.length}件)。既に published 済み、または scheduled 登録されていない可能性があります。`);
        }
        targetArtworks = [found];
      }

      logMessage(`[EmDash Production] 取得対象 scheduled Artwork: ${targetArtworks.length} 件`);
      if (targetArtworks.length === 0) {
        logMessage('[EmDash Production] 現在 scheduled の作品はありません。処理を終了します。');
        logMessage('========================================');
        return { count: 0, checked: 0, published: 0, waiting: 0, failed: 0, syncErrors: 0 };
      }
    } else {
      // ローカルモード: 既存の local SQLite data.db から取得
      if (!fs.existsSync(DB_PATH)) {
        throw new Error(`EmDash DBが見つかりません: ${DB_PATH}`);
      }

      const db = new DatabaseSync(DB_PATH);

      if (isAll) {
        // --all: scheduled かつ postiz_post_id ありの作品のみ取得
        targetArtworks = db.prepare(`
          SELECT id, slug, title, cat_slug, postiz_status, postiz_post_id, instagram_caption, instagram_publish_at, postiz_published_at, postiz_last_error 
          FROM ec_artworks 
          WHERE postiz_status = 'scheduled' 
            AND postiz_post_id IS NOT NULL 
            AND TRIM(postiz_post_id) != ''
          ORDER BY created_at ASC
        `).all();

        logMessage(`[EmDash Local] 取得対象 scheduled Artwork: ${targetArtworks.length} 件`);
        if (targetArtworks.length === 0) {
          logMessage('[EmDash Local] 現在 scheduled の作品はありません。処理を終了します。');
          logMessage('========================================');
          return { count: 0, checked: 0, published: 0, waiting: 0, failed: 0, syncErrors: 0 };
        }
      } else {
        // --slug: 指定の1件
        const artwork = db.prepare(`
          SELECT id, slug, title, cat_slug, postiz_status, postiz_post_id, instagram_caption, instagram_publish_at, postiz_published_at, postiz_last_error 
          FROM ec_artworks 
          WHERE slug = ?
        `).get(targetSlug);

        if (!artwork) {
          throw new Error(`【安全停止】指定されたArtwork '${targetSlug}' がEmDashに見つかりません。`);
        }

        if (artwork.postiz_status === 'published') {
          logMessage(`Artwork:       ${artwork.slug}`);
          logMessage(`Status:        already published (同期済み)`);
          logMessage(`Published At:  ${artwork.postiz_published_at || '(none)'}`);
          logMessage('Result:        既に同期済みのため、処理を終了しました。');
          logMessage('EmDash update: なし');
          logMessage('========================================');
          return { status: 'already_published', slug: artwork.slug };
        }

        if (artwork.postiz_status !== 'scheduled' || !artwork.postiz_post_id) {
          throw new Error(`【対象外】Artwork '${artwork.slug}' のステータスは '${artwork.postiz_status}' です。scheduled かつ postiz_post_id が存在する作品のみが確認対象です。`);
        }

        targetArtworks = [artwork];
      }
    }

    if (!POSTIZ_API_KEY) {
      throw new Error('【安全停止】POSTIZ_API_KEY が未設定です。.env に設定してください。');
    }

    // 2. 1件ずつ処理（1件失敗しても全体を止めない try/catch）
    const stats = {
      checked: 0,
      published: 0,
      waiting: 0,
      failed: 0,
      syncErrors: 0,
    };

    for (const art of targetArtworks) {
      stats.checked++;
      try {
        const result = await processArtwork(art, isDryRun);
        if (result.outcome === 'published' || result.outcome === 'published_dryrun') {
          stats.published++;
        } else if (result.outcome === 'waiting') {
          stats.waiting++;
        } else if (result.outcome === 'failed' || result.outcome === 'failed_dryrun') {
          stats.failed++;
        }
      } catch (err) {
        stats.syncErrors++;
        logMessage(`  ❌ [Sync Error] Artwork '${art.slug}' の処理中にエラーが発生しました: ${err.message}`);
        logMessage(`  -> scheduled ステータスを維持し、次の作品へ進みます。`);
      }
    }

    // 3. サマリー表示
    logMessage('----------------------------------------');
    logMessage('📊 Sync Summary');
    logMessage(`  Checked:     ${stats.checked}`);
    logMessage(`  Published:   ${stats.published}`);
    logMessage(`  Waiting:     ${stats.waiting}`);
    logMessage(`  Failed:      ${stats.failed}`);
    logMessage(`  Sync errors: ${stats.syncErrors}`);
    logMessage('========================================');

    return stats;
  } finally {
    // 確実にロック解除
    releaseLock();
  }
}

// CLI実行時
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let slug = null;
  let isAll = false;
  let forceLive = false;
  let forceDryRun = false;

  for (const arg of args) {
    if (arg === '--all') {
      isAll = true;
    } else if (arg.startsWith('--slug=')) {
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
    all: isAll,
    slug,
    live: forceLive,
    dryRun: forceDryRun ? true : undefined,
  }).catch((err) => {
    console.error('\n[EXIT ERROR]', err.message);
    process.exit(1);
  });
}
