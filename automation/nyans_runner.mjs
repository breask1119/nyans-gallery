/**
 * Nyans Gallery 日常運用ランナー (Nyans Production Runner)
 * 
 * 1. 本番環境 (PRODUCTION) の明示確認
 * 2. 前回までの予約投稿の公開状態を確認＆Cloudflare本番へ自動同期 (Status Sync)
 * 3. ログ記録 (automation/logs/nyans-run-YYYY-MM.log)
 * 4. Image Organizer の安全起動
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ============================================================================
// 1. 環境設定 & PRODUCTION 固定
// ============================================================================
process.env.NYANS_ENV = 'production';

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

loadEnvFile(path.resolve(__dirname, '.env'));
loadEnvFile(path.resolve(__dirname, '.ai-work', '.env'));

const PROD_BASE_URL = 'https://cats.t2-site.work';
const POSTIZ_BASE_URL = (process.env.POSTIZ_API_URL || 'https://postiz.xx-ai-girls-miu.com').replace(/\/+$/, '') + '/api';
const CHANNEL_ID = process.env.NYANS_POSTIZ_CHANNEL_ID || '';

function maskSecret(str) {
  if (!str) return '(not configured)';
  if (str.length <= 8) return '****';
  return str.slice(0, 4) + '...' + str.slice(-4);
}

// ============================================================================
// 2. ログシステム (automation/logs/nyans-run-YYYY-MM.log)
// ============================================================================
const logsDir = path.resolve(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

function getLogFilePath() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return path.resolve(logsDir, `nyans-run-${year}-${month}.log`);
}

function appendLog(message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}\n`;
  try {
    fs.appendFileSync(getLogFilePath(), line, 'utf8');
  } catch (err) {
    console.error('Failed to write log:', err.message);
  }
}

function logBoth(message) {
  console.log(message);
  appendLog(message);
}

// ============================================================================
// 3. Status Sync の自動実行
// ============================================================================
async function runAutoStatusSync() {
  console.log('\n------------------------------------------------------------');
  console.log('🔄 [Step 1/2] 前回までの予約投稿の公開状態を確認・同期中...');
  console.log('------------------------------------------------------------');
  appendLog('=== Starting Status Sync ===');

  try {
    const statusSyncScript = path.resolve(__dirname, 'postiz_status_sync.mjs');
    const proc = cp.spawnSync(process.execPath, [statusSyncScript, '--prod', '--all', '--live'], {
      cwd: PROJECT_ROOT,
      stdio: 'pipe',
      encoding: 'utf8',
      env: { ...process.env, NYANS_ENV: 'production' }
    });

    const output = (proc.stdout || '') + (proc.stderr || '');
    // ログファイルへ記録
    appendLog(output.trim());

    if (proc.status === 0) {
      if (output.includes('Published:   0') && output.includes('Waiting:     0')) {
        console.log('✅ 同期対象の予約投稿はありません（すべて完了済み、または待機なし）。');
      } else {
        // 結果サマリーを抽出して簡潔表示
        const summaryMatch = output.match(/📊 Sync Summary[\s\S]*?========================================/);
        if (summaryMatch) {
          console.log('✅ 同期結果:');
          console.log(summaryMatch[0]);
        } else {
          console.log('✅ Status Sync が正常に完了しました。');
        }
      }
      appendLog('Status Sync completed successfully.');
    } else {
      console.warn(`⚠️ Status Sync で警告またはエラーが発生しました (終了コード: ${proc.status})。`);
      console.warn('※ オフラインまたはAPI一時障害の可能性がありますが、選別処理は継続可能です。');
      appendLog(`Status Sync exited with code ${proc.status}`);
    }
  } catch (err) {
    console.warn(`⚠️ Status Sync の呼び出しに失敗しました: ${err.message}`);
    console.warn('※ 選別処理は継続可能です。');
    appendLog(`Status Sync call failed: ${err.message}`);
  }
}

// ============================================================================
// 4. Image Organizer 起動
// ============================================================================
async function promptTargetFolder() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question('\n📁 選別対象の画像フォルダパスを入力またはドラッグ＆ドロップしてください\n(未入力でEnterを押すと終了します): ', (answer) => {
      rl.close();
      let cleaned = answer.trim();
      // Windowsのドラッグ＆ドロップによるダブルクォートを除去
      if ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
        cleaned = cleaned.slice(1, -1);
      }
      resolve(cleaned);
    });
  });
}

async function runImageOrganizer(targetFolder) {
  console.log('\n------------------------------------------------------------');
  console.log('🎨 [Step 2/2] Image Organizer を起動します...');
  console.log(`対象フォルダ: ${targetFolder}`);
  console.log('------------------------------------------------------------');
  appendLog(`Launching Image Organizer with folder: ${targetFolder}`);

  const organizerScript = path.resolve(__dirname, '.ai-work', 'image-organizer.mjs');
  
  // Image Organizer をフォアグラウンド実行（HTTPサーバーとブラウザUI）
  const child = cp.spawn(process.execPath, [organizerScript, '--folder', targetFolder], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    env: { ...process.env, NYANS_ENV: 'production' }
  });

  return new Promise((resolve, reject) => {
    child.on('close', (code) => {
      appendLog(`Image Organizer closed with code ${code}`);
      if (code === 0) resolve();
      else resolve(); // ユーザーによる終了 (Ctrl+C など) も正常終了扱い
    });
    child.on('error', (err) => {
      appendLog(`Image Organizer error: ${err.message}`);
      reject(err);
    });
  });
}

// ============================================================================
// メインフロー
// ============================================================================
async function main() {
  console.log('');
  console.log('============================================================');
  console.log('🐱 にゃんずギャラリー 日常運用バッチ (Nyans Production)');
  console.log('============================================================');
  console.log(`実行日時:        ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`);
  console.log(`Environment:     PRODUCTION (Cloudflare本番)`);
  console.log(`Cloudflare API:  ${PROD_BASE_URL}`);
  console.log(`Postiz API:      ${POSTIZ_BASE_URL}`);
  console.log(`Postiz Channel:  ${maskSecret(CHANNEL_ID)} (perumofu / Instagram-standalone)`);
  console.log('============================================================');

  appendLog('=== Nyans Daily Runner Started ===');
  appendLog(`Environment: PRODUCTION, Cloudflare: ${PROD_BASE_URL}, Channel: ${maskSecret(CHANNEL_ID)}`);

  // 1. Status Sync 実行
  await runAutoStatusSync();

  // 2. 引数または入力から対象フォルダを決定
  const rawArgs = process.argv.slice(2);
  let targetFolder = null;

  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if (a === '--folder' && rawArgs[i + 1]) {
      targetFolder = rawArgs[++i];
    } else if (a.startsWith('--folder=')) {
      targetFolder = a.slice('--folder='.length);
    } else if (!a.startsWith('--')) {
      targetFolder = a;
    }
  }

  // クォート除去
  if (targetFolder) {
    targetFolder = targetFolder.replace(/^['"](.*)['"]$/, '$1').trim();
  }

  if (!targetFolder) {
    targetFolder = await promptTargetFolder();
  }

  if (!targetFolder) {
    console.log('\n[終了] フォルダが指定されなかったため、処理を終了しました。');
    appendLog('Exited: No folder specified.');
    return;
  }

  const resolvedPath = path.resolve(targetFolder);
  if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isDirectory()) {
    console.error(`\n❌ [エラー] 指定されたフォルダが存在しません: ${resolvedPath}`);
    appendLog(`Error: Folder not found: ${resolvedPath}`);
    return;
  }

  // 3. Image Organizer 起動
  await runImageOrganizer(resolvedPath);

  console.log('\n[完了] Nyans日常運用バッチを終了しました。');
  appendLog('=== Nyans Daily Runner Finished ===');
}

main().catch((err) => {
  console.error('\n❌ [FATAL ERROR]:', err);
  appendLog(`Fatal error: ${err.message}`);
  process.exit(1);
});
