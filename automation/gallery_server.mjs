#!/usr/bin/env node

/**
 * ============================================================================
 * Nyans Gallery - Server Manager (STEP 7E.1)
 * ============================================================================
 * 
 * Gallery / EmDash local standalone server (dist/server/entry.mjs) の
 * ライフサイクル管理（ローカル限定化、二重起動防止、ポート4321固定、
 * ヘルスチェック、月別ログ、常駐プロセス監視）。
 * 
 * [SAFETY RULES]
 * - HOST=localhost (ローカル限定、外部LAN非公開)。
 * - ポート 4321 固定。別ポートへの自動フォールバック禁止。
 * - 既に Nyans Gallery が起動中の場合は安全に二重起動をスキップ (exit 0)。
 * - 4321 が別プロセスで使用中の場合はエラー終了 (exit 1)。
 * - サーバー稼働中は常駐監視し、タスクスケジューラ上でも「実行中」を維持。
 * - Astro 標準出力をすべて追記せず、起動・停止・エラーイベントのみログ出力。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GALLERY_ROOT = path.resolve(__dirname, '../gallery');
const ENTRY_FILE = path.resolve(GALLERY_ROOT, 'dist', 'server', 'entry.mjs');
const LOGS_DIR = path.resolve(__dirname, 'logs');
const PORT = 4321;
const HOST = 'localhost'; // ローカル限定 (外部LAN非公開)
const HEALTH_URL = `http://localhost:${PORT}/api/nyans/health`;

// ============================================================================
// Logging
// ============================================================================

function getLogFilePath() {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return path.resolve(LOGS_DIR, `gallery-server-${year}-${month}.log`);
}

export function logServerEvent(level, message, alsoConsole = true) {
  const timestamp = new Date().toISOString();
  const formatted = `[${timestamp}] [${level}] ${message}`;
  if (alsoConsole) {
    if (level === 'ERROR') {
      console.error(formatted);
    } else {
      console.log(formatted);
    }
  }
  try {
    const logPath = getLogFilePath();
    fs.appendFileSync(logPath, `${formatted}\n`, 'utf8');
  } catch (err) {
    console.error('Failed to append to server log file:', err.message);
  }
}

// ============================================================================
// Health Check Helper
// ============================================================================

export async function checkHealth(timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get(HEALTH_URL, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const json = JSON.parse(data);
            if (json && json.service === 'nyans-gallery') {
              return resolve({ status: 'running_nyans', data: json });
            }
          } catch {
            // JSONパース不可
          }
          return resolve({ status: 'running_other', code: res.statusCode });
        }
        return resolve({ status: 'running_other', code: res.statusCode });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 'timeout' });
    });

    req.on('error', (err) => {
      if (err.code === 'ECONNREFUSED') {
        resolve({ status: 'not_running' });
      } else {
        resolve({ status: 'error', error: err.code || err.message });
      }
    });
  });
}

export async function checkUpdateStatusEndpoint(timeoutMs = 3000) {
  return new Promise((resolve) => {
    const options = {
      method: 'OPTIONS',
      hostname: 'localhost',
      port: PORT,
      path: '/api/nyans/update-status',
      timeout: timeoutMs,
    };
    const req = http.request(options, (res) => {
      resolve({ status: res.statusCode });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 'timeout' });
    });

    req.on('error', (err) => {
      resolve({ status: 'error', error: err.code || err.message });
    });

    req.end();
  });
}

// ============================================================================
// Commands
// ============================================================================

async function cmdHealth() {
  console.log(`Checking Gallery server health on http://${HOST}:${PORT}...`);
  const health = await checkHealth();
  if (health.status === 'running_nyans') {
    console.log(`✅ [Nyans Gallery] Server is active and healthy!`);
    console.log(`   Service:   ${health.data.service}`);
    console.log(`   EmDash:    ${health.data.emdash}`);
    console.log(`   Host:      ${HOST} (local-only, not accessible from LAN)`);
    console.log(`   Timestamp: ${health.data.timestamp}`);

    const optRes = await checkUpdateStatusEndpoint();
    console.log(`   Update Status Endpoint: HTTP ${optRes.status} (OPTIONS check)`);
    return 0;
  } else if (health.status === 'not_running') {
    console.log(`❌ [Nyans Gallery] Server is NOT running (connection refused on port ${PORT}).`);
    return 1;
  } else {
    console.log(`⚠️ [Nyans Gallery] Unexpected response on port ${PORT}: status=${health.status}`);
    return 2;
  }
}

async function cmdStart() {
  logServerEvent('INFO', `Starting Nyans Gallery server manager check (Port: ${PORT}, Host: ${HOST})...`);

  // 1. 二重起動チェック
  const initialHealth = await checkHealth();
  if (initialHealth.status === 'running_nyans') {
    console.log('\n========================================');
    console.log('[Nyans Gallery]');
    console.log('Gallery server is already running.');
    console.log('Startup skipped.');
    console.log('========================================\n');
    logServerEvent('SKIPPED', `Gallery server is already running on port ${PORT} (host: ${HOST}). Startup skipped.`);
    return 0;
  }

  if (initialHealth.status === 'running_other') {
    console.error(`\n❌ [ERROR] Port ${PORT} is already in use by another application.`);
    console.error('Please free port 4321 or check running processes.');
    logServerEvent('ERROR', `Port ${PORT} is occupied by another service (HTTP ${initialHealth.code}). Aborted.`);
    return 1;
  }

  // 2. entry.mjs の存在チェック
  if (!fs.existsSync(ENTRY_FILE)) {
    console.error(`\n❌ [ERROR] Standalone entry file not found: ${ENTRY_FILE}`);
    console.error('Please build the gallery project first: npm run build');
    logServerEvent('ERROR', `Standalone entry file missing: ${ENTRY_FILE}. Aborted.`);
    return 1;
  }

  // 3. 起動開始ログ
  logServerEvent('START', `Launching standalone server (Port: ${PORT}, Host: ${HOST}, Entry: dist/server/entry.mjs)...`);
  console.log('========================================');
  console.log('🐱 Launching Nyans Gallery Server');
  console.log(`Host:     ${HOST} (Local-only, NOT accessible from LAN)`);
  console.log(`Port:     ${PORT} (fixed)`);
  console.log(`Root:     ${GALLERY_ROOT}`);
  console.log('========================================');

  // 4. 子プロセスの起動 (親プロセスで常駐監視)
  // タスクスケジューラ等の非対話環境で stdout/stderr バッファ詰まりによるブロックを防ぐため stdio: 'ignore' を使用
  const env = {
    ...process.env,
    HOST,
    PORT: String(PORT),
  };

  const child = spawn(process.execPath, [ENTRY_FILE], {
    cwd: GALLERY_ROOT,
    env,
    stdio: 'ignore',
  });

  child.on('error', (err) => {
    logServerEvent('ERROR', `Failed to spawn Gallery server: ${err.message}`);
    process.exit(1);
  });

  // 5. 起動後ヘルスチェック（最大30秒ポーリング、1秒間隔）
  let isHealthy = false;
  let childExited = false;
  let exitReason = null;

  child.on('exit', (code, signal) => {
    childExited = true;
    exitReason = signal ? `signal ${signal}` : `exit code ${code}`;
  });

  const maxWaitMs = 30000;
  const pollIntervalMs = 1000;
  const pollStart = Date.now();

  while (Date.now() - pollStart < maxWaitMs) {
    if (childExited) {
      break;
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    if (childExited) {
      break;
    }
    const h = await checkHealth(1000);
    if (h.status === 'running_nyans') {
      isHealthy = true;
      break;
    }
  }

  if (isHealthy) {
    logServerEvent('SUCCESS', `Gallery server (PID: ${child.pid}) started successfully and passed health check on port ${PORT} (host: ${HOST}).`);
    console.log(`\n🎉 [Nyans Gallery] Server is READY at http://${HOST}:${PORT}`);
    console.log(`   PID:                    ${child.pid}`);
    console.log(`   Health Endpoint:        http://${HOST}:${PORT}/api/nyans/health`);
    console.log(`   Update Status Endpoint: http://${HOST}:${PORT}/api/nyans/update-status\n`);
  } else {
    logServerEvent('ERROR', `Gallery server health check failed after 30 seconds.${childExited ? ` Process exited prematurely with ${exitReason}.` : ''}`);
    console.error(`\n❌ [ERROR] Gallery server health check failed after 30 seconds.`);

    // 起動した子プロセスが残っている場合は孤立プロセスを残さないよう強制終了
    if (!childExited && child.pid) {
      try {
        if (process.platform === 'win32') {
          const { execSync } = await import('node:child_process');
          execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        try {
          child.kill('SIGTERM');
        } catch {
          // ignore
        }
      }
    }
    return 1;
  }

  // 6. プロセス終了監視 (常駐)
  return new Promise((resolve) => {
    if (childExited) {
      logServerEvent('STOP', `Gallery server process (PID: ${child.pid}) exited with ${exitReason}.`);
      console.log(`[Nyans Gallery] Server process exited (${exitReason}).`);
      resolve(1);
      return;
    }

    child.on('exit', (code, signal) => {
      const reason = signal ? `signal ${signal}` : `exit code ${code}`;
      logServerEvent('STOP', `Gallery server process (PID: ${child.pid}) exited with ${reason}.`);
      console.log(`[Nyans Gallery] Server process exited (${reason}).`);
      resolve(code || 0);
    });
  });
}

// ============================================================================
// Main Dispatcher
// ============================================================================

const action = process.argv[2] || 'start';

if (action === 'health') {
  cmdHealth().then((code) => process.exit(code));
} else if (action === 'start') {
  cmdStart().then((code) => process.exit(code));
} else {
  console.log(`Usage: node automation/gallery_server.mjs [start|health]`);
  process.exit(1);
}
