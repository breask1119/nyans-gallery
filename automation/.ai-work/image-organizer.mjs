import fs from 'node:fs/promises';

import {
  readFileSync,
  existsSync,
  statSync,
} from 'node:fs';

import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';

import {
  spawn,
} from 'node:child_process';

import {
  fileURLToPath,
} from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadEnv() {
  for (const envPath of [
    path.join(__dirname, '.env'),
    path.join(process.cwd(), '.env'),
  ]) {
    if (!existsSync(envPath)) continue;

    try {
      for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const s = line.trim();

        if (!s || s.startsWith('#') || !s.includes('=')) {
          continue;
        }

        const i = s.indexOf('=');

        const key = s
          .slice(0, i)
          .trim();

        const value = s
          .slice(i + 1)
          .trim()
          .replace(
            /^['"](.*)['"]$/,
            '$1'
          );

        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    } catch {
      // 読み込み失敗時は無視
    }
  }
}

loadEnv();


/* ============================================================
 * Gemini設定
 * ============================================================ */

const GEMINI_API_KEY =
  process.env.MIU_GEMINI_API_KEY ||
  process.env.GEMINI_API_KEY ||
  '';

const ORGANIZER_MODEL =
  process.env.MIU_ORGANIZER_MODEL ||
  'gemini-3.5-flash-lite';

const SINGLE_BATCH_SIZE =
  Math.max(
    1,
    Math.min(
      8,
      Number(
        process.env.MIU_ORGANIZER_BATCH_SIZE ||
        5
      )
    )
  );

const DIFFERENTIATION_MAX_IMAGES =
  Math.max(
    5,
    Math.min(
      60,
      Number(
        process.env.MIU_ORGANIZER_DIFF_MAX_IMAGES ||
        50
      )
    )
  );

const GEMINI_MIN_REQUEST_INTERVAL_MS =
  Math.max(
    4000,
    Number(
      process.env.MIU_GEMINI_MIN_REQUEST_INTERVAL_MS ||
      5000
    )
  );

const GEMINI_MAX_ATTEMPTS = 2;

const GEMINI_RETRY_DELAYS_MS = [
  10000,
  30000,
];

const SINGLE_MEDIA_RESOLUTION =
  process.env.MIU_ORGANIZER_SINGLE_MEDIA_RESOLUTION ||
  'MEDIA_RESOLUTION_MEDIUM';

const DIFF_MEDIA_RESOLUTION =
  process.env.MIU_ORGANIZER_DIFF_MEDIA_RESOLUTION ||
  'MEDIA_RESOLUTION_LOW';

const RATING_ANALYSIS_VERSION = '1';

const FULL_ANALYSIS_VERSION = '4';

const SINGLE_ANALYSIS_VERSION = FULL_ANALYSIS_VERSION;

const DIFFERENTIATION_ANALYSIS_VERSION = '4';

const ALLOWED_EXTS =
  new Set([
    '.png',
    '.jpg',
    '.jpeg',
    '.webp',
  ]);

const FINAL_RATINGS =
  new Set([
    'SAFE',
    'MILD',
    'SENSITIVE',
    'EXPLICIT',
  ]);

/* ============================================================
 * 猫（Cat）設定
 * ============================================================ */

const CAT_OPTIONS = [
  { slug: 'rin', name: '凛ちゃん' },
];



/* ============================================================
 * Gemini使用量
 * ============================================================ */

const GEMINI_USAGE = {
  requests: 0,
  promptTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
};


/* ============================================================
 * レート制御
 * ============================================================ */

let geminiLastRequestStartedAt = 0;
let geminiBlockedUntil = 0;
let geminiConsecutive429Count = 0;

const GEMINI_MAX_CONSECUTIVE_429 = 2;

let geminiRequestQueue =
  Promise.resolve();


/* ============================================================
 * Utility
 * ============================================================ */

function sleep(ms) {
  return new Promise(
    resolve =>
      setTimeout(resolve, ms)
  );
}


function getMimeType(file) {
  const ext =
    path
      .extname(file)
      .toLowerCase();

  if (
    ext === '.jpg' ||
    ext === '.jpeg'
  ) {
    return 'image/jpeg';
  }

  if (ext === '.png') {
    return 'image/png';
  }

  if (ext === '.webp') {
    return 'image/webp';
  }

  return 'application/octet-stream';
}


function sha256(file) {
  return crypto
    .createHash('sha256')
    .update(
      readFileSync(file)
    )
    .digest('hex');
}


function escapeHtml(value) {
  return String(value ?? '')
    .replace(
      /&/g,
      '&amp;'
    )
    .replace(
      /</g,
      '&lt;'
    )
    .replace(
      />/g,
      '&gt;'
    )
    .replace(
      /"/g,
      '&quot;'
    )
    .replace(
      /'/g,
      '&#39;'
    );
}


function sanitizePathSegment(
  value,
  fallback = 'item'
) {
  const s =
    String(value || '')
      .trim()
      .replace(
        /[<>:"/\\|?*\x00-\x1F]/g,
        '_'
      )
      .replace(
        /[. ]+$/g,
        ''
      );

  return s || fallback;
}


/* ============================================================
 * CLI
 * ============================================================ */

function parseCliArgs() {
  const args =
    process.argv.slice(2);

  const options = {
    folder: null,
    dryRun: false,
    force: false,
    fullReview: false,
    model: null,
    theme: null,
    applyReview: null,
    help: false,
  };

  for (
    let i = 0;
    i < args.length;
    i++
  ) {
    const arg =
      args[i];

    if (
      arg === '--help' ||
      arg === '-h'
    ) {
      options.help =
        true;

    } else if (
      arg === '--dry-run'
    ) {
      options.dryRun =
        true;

    } else if (
      arg === '--force'
    ) {
      options.force =
        true;

    } else if (
      arg === '--full-review'
    ) {
      options.fullReview =
        true;

    } else if (
      arg === '--folder'
    ) {
      options.folder =
        args[++i];

    } else if (
      arg === '--model'
    ) {
      options.model =
        args[++i];

    } else if (
      arg === '--theme'
    ) {
      options.theme =
        args[++i];

    } else if (
      arg === '--apply-review'
    ) {
      options.applyReview =
        args[++i];

    } else if (
      arg.startsWith('--folder=')
    ) {
      options.folder =
        arg.slice(9);

    } else if (
      arg.startsWith('--model=')
    ) {
      options.model =
        arg.slice(8);

    } else if (
      arg.startsWith('--theme=')
    ) {
      options.theme =
        arg.slice(8);

    } else if (
      arg.startsWith('--apply-review=')
    ) {
      options.applyReview =
        arg.slice(15);
    }
  }

  return options;
}


function printUsage() {
  console.log(`
使用方法:

node .ai-work/image-organizer.mjs --folder <フォルダ>

node .ai-work/image-organizer.mjs --apply-review <review-result.json>

オプション:

--dry-run        対象画像一覧・出力先を確認（Gemini呼び出しなし）

--force          既存キャッシュを無視して再解析

--full-review    詳細AIレビュー（画質・構図・表情・差別化・類似度）を実行（デフォルトはRating判定のみ）

--model <名前>   モデル名を手動指定

--theme <名前>   テーマ名を手動指定
`);
}


/* ============================================================
 * Gemini API
 * ============================================================ */

function isRetryableGeminiStatus(
  status
) {
  return [
    429,
    500,
    502,
    503,
    504,
  ].includes(
    Number(status)
  );
}


function parseGeminiRetryAfterMs(
  response,
  text
) {
  const header =
    response
      ?.headers
      ?.get?.(
        'retry-after'
      );

  if (
    header &&
    Number(header) > 0
  ) {
    return Math.ceil(
      Number(header) *
      1000
    );
  }

  const match =
    String(text || '')
      .match(
        /retry\s+in\s+(\d+(?:\.\d+)?)s/i
      );

  if (match) {
    return Math.ceil(
      Number(match[1]) *
      1000
    );
  }

  return null;
}


async function waitForGeminiRateSlot() {
  const now =
    Date.now();

  const wait =
    Math.max(
      0,

      GEMINI_MIN_REQUEST_INTERVAL_MS -
      (
        now -
        geminiLastRequestStartedAt
      ),

      geminiBlockedUntil -
      now
    );

  if (wait > 0) {
    console.log(
      `[RATE] Gemini API制限対策: ${(wait / 1000).toFixed(1)}秒待機`
    );

    await sleep(
      wait
    );
  }

  geminiLastRequestStartedAt =
    Date.now();
}


function runGeminiRateLimited(
  task
) {
  const execute =
    async () => {

      await waitForGeminiRateSlot();

      return task();
    };

  const promise =
    geminiRequestQueue.then(
      execute,
      execute
    );

  geminiRequestQueue =
    promise.catch(
      () => { }
    );

  return promise;
}


async function callGeminiApi({
  body,
  timeoutMs = 120000,
}) {
  if (!GEMINI_API_KEY) {
    throw new Error(
      'GEMINI_API_KEY が設定されていません。'
    );
  }

  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      ORGANIZER_MODEL
    )
    }:generateContent?key=${encodeURIComponent(
      GEMINI_API_KEY
    )
    }`;

  let lastError =
    null;

  for (
    let attempt = 1;
    attempt <= GEMINI_MAX_ATTEMPTS;
    attempt++
  ) {
    try {
      const response =
        await runGeminiRateLimited(
          () =>
            fetch(
              endpoint,
              {
                method:
                  'POST',

                headers: {
                  'Content-Type':
                    'application/json',
                },

                body:
                  JSON.stringify(
                    body
                  ),

                signal:
                  AbortSignal.timeout(
                    timeoutMs
                  ),
              }
            )
        );

      const text =
        await response.text();

      if (response.ok) {
        geminiConsecutive429Count =
          0;

        let parsed;

        try {
          parsed =
            JSON.parse(text);

        } catch {
          const err =
            new Error(
              'GeminiレスポンスJSONの解析に失敗しました。'
            );

          err.code =
            'GEMINI_RESPONSE_JSON_ERROR';

          throw err;
        }

        const usage =
          parsed?.usageMetadata ||
          {};

        GEMINI_USAGE.requests +=
          1;

        GEMINI_USAGE.promptTokens +=
          Number(
            usage.promptTokenCount ||
            0
          );

        GEMINI_USAGE.outputTokens +=
          Number(
            usage.candidatesTokenCount ||
            usage.responseTokenCount ||
            0
          );

        GEMINI_USAGE.totalTokens +=
          Number(
            usage.totalTokenCount ||
            0
          );

        return parsed;
      }

      const status =
        Number(
          response.status
        );

      if (status !== 429) {
        geminiConsecutive429Count =
          0;
      }

      const error =
        new Error(
          `HTTP ${status}: ${text.slice(
            0,
            500
          )}`
        );

      error.httpStatus =
        status;

      error.retryable =
        isRetryableGeminiStatus(
          status
        );

      lastError =
        error;

      if (status === 429) {
        geminiConsecutive429Count +=
          1;

        const serverRetry =
          parseGeminiRetryAfterMs(
            response,
            text
          );

        const fallback =
          GEMINI_RETRY_DELAYS_MS[
          attempt - 1
          ] ||
          30000;

        const retryMs =
          serverRetry
            ?
            Math.max(
              serverRetry +
              5000,

              fallback
            )
            :
            Math.max(
              60000,
              fallback
            );

        if (
          geminiConsecutive429Count >=
          GEMINI_MAX_CONSECUTIVE_429
        ) {
          const rateError =
            new Error(
              'Gemini APIの429（レート制限）が2回連続しました。APIクォータが回復してから再実行してください。'
            );

          rateError.code =
            'GEMINI_RATE_LIMIT_ABORT';

          rateError.httpStatus =
            429;

          rateError.retryAfterMs =
            retryMs;

          throw rateError;
        }

        geminiBlockedUntil =
          Math.max(
            geminiBlockedUntil,

            Date.now() +
            retryMs
          );

        console.warn(
          `[RATE LIMIT] Gemini HTTP 429。${Math.ceil(
            retryMs /
            1000
          )}秒待機して1回だけ再試行します。（連続429: ${geminiConsecutive429Count}/${GEMINI_MAX_CONSECUTIVE_429}）`
        );

        continue;
      }

      if (
        !error.retryable
      ) {
        throw error;
      }

      if (
        attempt <
        GEMINI_MAX_ATTEMPTS
      ) {
        const delay =
          GEMINI_RETRY_DELAYS_MS[
          attempt - 1
          ] ||
          30000;

        console.warn(
          `[WARN] Gemini HTTP ${status}。${Math.round(
            delay /
            1000
          )}秒後に再試行します。`
        );

        await sleep(
          delay
        );

        continue;
      }

      throw error;

    } catch (err) {
      lastError =
        err;

      if (
        err?.code ===
        'GEMINI_RATE_LIMIT_ABORT'
        ||
        err?.code ===
        'GEMINI_RESPONSE_JSON_ERROR'
        ||
        err?.retryable ===
        false
      ) {
        throw err;
      }

      if (
        attempt <
        GEMINI_MAX_ATTEMPTS
      ) {
        const delay =
          GEMINI_RETRY_DELAYS_MS[
          attempt - 1
          ] ||
          30000;

        console.warn(
          `[WARN] Gemini通信エラー: ${err.message}。${Math.round(
            delay /
            1000
          )}秒後に再試行します。`
        );

        await sleep(
          delay
        );

        continue;
      }
    }
  }

  throw (
    lastError ||
    new Error(
      `Gemini ${ORGANIZER_MODEL} の呼び出しに失敗しました。`
    )
  );
}


/* ============================================================
 * 単体評価 (Rating Only)
 * ============================================================ */

const RATING_ONLY_SCHEMA = {
  type: 'object',
  properties: {
    images: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: {
            type: 'string',
          },
          rating: {
            type: 'object',
            properties: {
              candidate: {
                type: 'string',
                enum: [
                  'SAFE',
                  'MILD',
                  'SENSITIVE',
                  'EXPLICIT',
                  'REVIEW',
                ],
              },
              confidence: {
                type: 'number',
              },
            },
            required: [
              'candidate',
              'confidence',
            ],
          },
        },
        required: [
          'file',
          'rating',
        ],
      },
    },
  },
  required: [
    'images',
  ],
};


function buildRatingOnlyPrompt(
  fileNames
) {
  return `あなたはAI生成画像のコンテンツレーティング（Content Rating）判定の専門家です。
提示された各画像の描画内容のみを客観的に確認し、Content Rating（コンテンツ年齢区分・露出レベル）を判定してください。

対象画像ファイル一覧:
${fileNames.map((name, i) => `[画像 ${i + 1}] ${name}`).join('\n')}

■ 判定ルール（極めて重要）:
1. 対象Rating:
   - SAFE: 全年齢向け。露出が少なく健全な日常・一般的なポートレートなど。
   - MILD: 軽微な露出や水着・下着風の軽度な衣装、軽いセクシー要素。
   - SENSITIVE: 高い露出度、センシティブなポーズ・構図、扇情的な描写。
   - EXPLICIT: 明白な性描写、過度な露出、成人向け要素。
   - REVIEW: 判断が曖昧・境界線上・判定に確信が持てない場合。
2. 不確実なら必ず REVIEW に倒してください。
3. エラーや未解析、曖昧な画像を絶対に SAFE に倒してはいけません（unknown → SAFE は厳禁）。
4. モデル名やテーマ名は単なる整理用メタデータです。それらから内容を推測せず、実際の画像内容のみから客観的に判定してください。
5. confidence は 0.00 〜 1.00 の範囲で判定の確信度を指定してください。

必ず対象画像全件について、指定のJSONスキーマに従い1件ずつ返してください。`;
}


async function analyzeRatingOnlyBatch(
  entries
) {
  const parts = [
    {
      text:
        buildRatingOnlyPrompt(
          entries.map(
            entry =>
              entry.fileName
          )
        ),
    },
  ];

  entries.forEach(
    (
      entry,
      index
    ) => {
      parts.push(
        {
          text:
            `[画像 ${index + 1}] ファイル名: ${entry.fileName}`,
        },
        {
          inline_data: {
            mime_type:
              getMimeType(
                entry.filePath
              ),
            data:
              readFileSync(
                entry.filePath
              ).toString(
                'base64'
              ),
          },
        }
      );
    }
  );

  const response =
    await callGeminiApi({
      body: {
        contents: [
          {
            parts,
          },
        ],
        generationConfig: {
          responseMimeType:
            'application/json',
          responseJsonSchema:
            RATING_ONLY_SCHEMA,
          mediaResolution:
            SINGLE_MEDIA_RESOLUTION,
        },
      },
    });

  const text =
    response
      ?.candidates?.[0]
      ?.content
      ?.parts
      ?.map(
        part =>
          part.text
      )
      .join('') ||
    '';

  let parsed;

  try {
    parsed =
      JSON.parse(text);
  } catch (err) {
    const error =
      new Error(
        `Gemini構造化出力JSONの解析に失敗しました: ${err.message}`
      );
    error.code =
      'STRUCTURED_OUTPUT_JSON_ERROR';
    throw error;
  }

  if (
    !Array.isArray(
      parsed?.images
    )
  ) {
    throw new Error(
      'Gemini評価結果に images 配列がありません。'
    );
  }

  return parsed.images;
}


/* ============================================================
 * 単体評価 (Full Review)
 * ============================================================ */

const BATCH_ANALYSIS_SCHEMA = {
  type:
    'object',

  properties: {
    images: {
      type:
        'array',

      items: {
        type:
          'object',

        properties: {
          file: {
            type:
              'string',
          },

          quality: {
            type:
              'object',

            properties: {
              score: {
                type:
                  'integer',
              },

              flags: {
                type:
                  'array',

                items: {
                  type:
                    'string',

                  enum: [
                    'face_artifact',
                    'eye_artifact',
                    'mouth_artifact',
                    'hand_artifact',
                    'limb_artifact',
                    'clothing_artifact',
                    'background_artifact',
                    'hair_artifact',
                    'accessory_artifact',
                    'blur',
                    'low_resolution',
                    'duplicate',
                    'other',
                  ],
                },
              },
            },

            required: [
              'score',
              'flags',
            ],
          },

          composition: {
            type:
              'object',

            properties: {
              subject_framing: {
                type:
                  'integer',
              },

              visual_balance: {
                type:
                  'integer',
              },

              crop_and_spacing: {
                type:
                  'integer',
              },

              pose_readability: {
                type:
                  'integer',
              },

              background_harmony: {
                type:
                  'integer',
              },
            },

            required: [
              'subject_framing',
              'visual_balance',
              'crop_and_spacing',
              'pose_readability',
              'background_harmony',
            ],
          },

          expression: {
            type:
              'object',

            properties: {
              naturalness: {
                type:
                  'integer',
              },

              eye_mouth_consistency: {
                type:
                  'integer',
              },

              emotional_clarity: {
                type:
                  'integer',
              },

              character_presence: {
                type:
                  'integer',
              },
            },

            required: [
              'naturalness',
              'eye_mouth_consistency',
              'emotional_clarity',
              'character_presence',
            ],
          },

          rating: {
            type:
              'object',

            properties: {
              candidate: {
                type:
                  'string',

                enum: [
                  'SAFE',
                  'MILD',
                  'SENSITIVE',
                  'EXPLICIT',
                  'REVIEW',
                ],
              },

              confidence: {
                type:
                  'number',
              },
            },

            required: [
              'candidate',
              'confidence',
            ],
          },

          forced_exclusion: {
            type:
              'boolean',
          },

          forced_exclusion_reason: {
            type: [
              'string',
              'null',
            ],
          },

          reason: {
            type:
              'string',
          },
        },

        required: [
          'file',
          'quality',
          'composition',
          'expression',
          'rating',
          'forced_exclusion',
          'reason',
        ],
      },
    },
  },

  required: [
    'images',
  ],
};


function buildBatchAnalysisPrompt(
  modelName,
  themeName,
  fileNames
) {
  return `
あなたはAI生成画像の投稿候補を選定する品質審査アシスタントです。

整理用メタデータ:
モデル名: ${modelName}
テーマ名: ${themeName}

対象ファイル:
${fileNames
      .map(
        (file, index) =>
          `${index + 1}. ${file}`
      )
      .join('\n')}

【重要】
モデル名・テーマ名は整理用です。
被写体の一致判定には使わず、
画像そのものを評価してください。

A. 画質 quality
0〜35点。

顔・目・口・手指・腕脚・服・髪・小物・背景・ぼけ・解像感・AI生成破綻を見る。

減点目安:
顔重大 -15
目・口 -8
手指 -10
腕・脚 -10
服 -7
背景 -5
髪・小物 -3
ぼけ・低解像 -8

同一原因の重複減点は禁止。

B. 構図 composition
合計25点。

subject_framing 0〜8
visual_balance 0〜6
crop_and_spacing 0〜5
pose_readability 0〜4
background_harmony 0〜2

意図的な寄り構図は減点しない。

C. 表情 expression
合計20点。

naturalness 0〜8
eye_mouth_consistency 0〜5
emotional_clarity 0〜4
character_presence 0〜3

笑顔やウインクを自動加点しない。

D. Content Rating 仮判定

SAFE
MILD
SENSITIVE
EXPLICIT
REVIEW

confidence 0〜1。

不確実ならREVIEW。

E. forced_exclusion

以下の場合のみtrue。

・重大な顔破綻
・身体構造異常
・重大な生成エラー
・投稿不能なぼけ
・投稿不能な低解像

F. reason

画質・構図・表情について
簡潔な日本語で記述。

必ず全ファイルについて
1件ずつ返してください。
`;
}


async function analyzeImageBatch(
  entries,
  modelName,
  themeName
) {
  const parts = [
    {
      text:
        buildBatchAnalysisPrompt(
          modelName,
          themeName,
          entries.map(
            entry =>
              entry.fileName
          )
        ),
    },
  ];

  entries.forEach(
    (
      entry,
      index
    ) => {
      parts.push(
        {
          text:
            `[画像 ${index + 1}] ファイル名: ${entry.fileName}`,
        },

        {
          inline_data: {
            mime_type:
              getMimeType(
                entry.filePath
              ),

            data:
              readFileSync(
                entry.filePath
              ).toString(
                'base64'
              ),
          },
        }
      );
    }
  );

  const response =
    await callGeminiApi({
      body: {
        contents: [
          {
            parts,
          },
        ],

        generationConfig: {
          responseMimeType:
            'application/json',

          responseJsonSchema:
            BATCH_ANALYSIS_SCHEMA,

          mediaResolution:
            SINGLE_MEDIA_RESOLUTION,
        },
      },
    });

  const text =
    response
      ?.candidates?.[0]
      ?.content
      ?.parts
      ?.map(
        part =>
          part.text
      )
      .join('') ||
    '';

  let parsed;

  try {
    parsed =
      JSON.parse(text);

  } catch (err) {
    const error =
      new Error(
        `Gemini構造化出力JSONの解析に失敗しました: ${err.message}`
      );

    error.code =
      'STRUCTURED_OUTPUT_JSON_ERROR';

    throw error;
  }

  if (
    !Array.isArray(
      parsed?.images
    )
  ) {
    throw new Error(
      'Gemini評価結果に images 配列がありません。'
    );
  }

  return parsed.images;
}


/* ============================================================
 * 類似・差別化評価
 * ============================================================ */

const DIFFERENTIATION_SCHEMA = {
  type:
    'object',

  properties: {
    comparisons: {
      type:
        'array',

      items: {
        type:
          'object',

        properties: {
          file: {
            type:
              'string',
          },

          closest_file: {
            type: [
              'string',
              'null',
            ],
          },

          max_similarity: {
            type:
              'number',
          },

          differentiation: {
            type:
              'object',

            properties: {
              composition_difference: {
                type:
                  'integer',
              },

              pose_difference: {
                type:
                  'integer',
              },

              expression_difference: {
                type:
                  'integer',
              },

              camera_distance_difference: {
                type:
                  'integer',
              },

              background_or_direction_difference: {
                type:
                  'integer',
              },
            },

            required: [
              'composition_difference',
              'pose_difference',
              'expression_difference',
              'camera_distance_difference',
              'background_or_direction_difference',
            ],
          },
        },

        required: [
          'file',
          'closest_file',
          'max_similarity',
          'differentiation',
        ],
      },
    },
  },

  required: [
    'comparisons',
  ],
};


async function analyzeDifferentiation(
  entries,
  modelName,
  themeName
) {
  if (
    entries.length <= 1
  ) {
    return entries.map(
      entry => ({
        file:
          entry.fileName,

        closest_file:
          null,

        max_similarity:
          0,

        differentiation: {
          composition_difference:
            6,

          pose_difference:
            5,

          expression_difference:
            4,

          camera_distance_difference:
            3,

          background_or_direction_difference:
            2,
        },
      })
    );
  }

  if (
    entries.length >
    DIFFERENTIATION_MAX_IMAGES
  ) {
    console.warn(
      `[WARN] 類似比較対象が${entries.length}枚あります。最大${DIFFERENTIATION_MAX_IMAGES}枚までを比較します。`
    );

    entries =
      entries.slice(
        0,
        DIFFERENTIATION_MAX_IMAGES
      );
  }

  const names =
    entries.map(
      entry =>
        entry.fileName
    );

  const prompt =
    `同一テーマ内の画像を投稿バリエーションの観点から比較してください。

モデル:
${modelName}

テーマ:
${themeName}

対象:
${names
      .map(
        (file, index) =>
          `${index + 1}. ${file}`
      )
      .join('\n')}

モデル名・テーマ名は整理用です。

各画像について
最も似た画像を1枚選び、
max_similarity 0〜1 を返してください。

目安:

0.90以上
ほぼ同一

0.80〜0.89
かなり似る

0.65〜0.79
やや似る

0.50〜0.64
ある程度異なる

0.50未満
十分異なる

差別化:

composition_difference 0〜6
pose_difference 0〜5
expression_difference 0〜4
camera_distance_difference 0〜3
background_or_direction_difference 0〜2

全画像分返してください。
`;

  const parts = [
    {
      text:
        prompt,
    },
  ];

  entries.forEach(
    (
      entry,
      index
    ) => {
      parts.push(
        {
          text:
            `[画像 ${index + 1}] ${entry.fileName}`,
        },

        {
          inline_data: {
            mime_type:
              getMimeType(
                entry.filePath
              ),

            data:
              readFileSync(
                entry.filePath
              ).toString(
                'base64'
              ),
          },
        }
      );
    }
  );

  const response =
    await callGeminiApi({
      body: {
        contents: [
          {
            parts,
          },
        ],

        generationConfig: {
          responseMimeType:
            'application/json',

          responseJsonSchema:
            DIFFERENTIATION_SCHEMA,

          mediaResolution:
            DIFF_MEDIA_RESOLUTION,
        },
      },

      timeoutMs:
        180000,
    });

  const text =
    response
      ?.candidates?.[0]
      ?.content
      ?.parts
      ?.map(
        part =>
          part.text
      )
      .join('') ||
    '';

  const parsed =
    JSON.parse(text);

  return (
    parsed?.comparisons ||
    []
  );
}


/* ============================================================
 * スコア計算
 * ============================================================ */

function calculateNodeScores(
  single,
  diffResult
) {
  const quality =
    Number(
      single
        ?.quality
        ?.score ||
      0
    );

  const composition =
    single
      ?.composition ||
    {};

  const expression =
    single
      ?.expression ||
    {};

  const differentiation =
    diffResult
      ?.differentiation ||
    {};

  const compositionTotal =
    Number(
      composition.subject_framing ||
      0
    )
    +
    Number(
      composition.visual_balance ||
      0
    )
    +
    Number(
      composition.crop_and_spacing ||
      0
    )
    +
    Number(
      composition.pose_readability ||
      0
    )
    +
    Number(
      composition.background_harmony ||
      0
    );

  const expressionTotal =
    Number(
      expression.naturalness ||
      0
    )
    +
    Number(
      expression.eye_mouth_consistency ||
      0
    )
    +
    Number(
      expression.emotional_clarity ||
      0
    )
    +
    Number(
      expression.character_presence ||
      0
    );

  const differentiationTotal =
    Number(
      differentiation.composition_difference ||
      0
    )
    +
    Number(
      differentiation.pose_difference ||
      0
    )
    +
    Number(
      differentiation.expression_difference ||
      0
    )
    +
    Number(
      differentiation.camera_distance_difference ||
      0
    )
    +
    Number(
      differentiation.background_or_direction_difference ||
      0
    );

  const postScore =
    Math.max(
      0,
      Math.min(
        100,
        Math.round(
          quality +
          compositionTotal +
          expressionTotal +
          differentiationTotal
        )
      )
    );

  const similarity =
    Number(
      diffResult
        ?.max_similarity ||
      0
    );

  const penalty =
    similarity >= 0.90
      ?
      15
      :
      similarity >= 0.80
        ?
        10
        :
        similarity >= 0.70
          ?
          5
          :
          0;

  const adjusted =
    Math.max(
      0,
      postScore -
      penalty
    );

  let recommendation =
    'SKIP';

  if (
    single
      ?.forced_exclusion
  ) {
    recommendation =
      'SKIP';

  } else if (
    adjusted >= 90
  ) {
    recommendation =
      'TOP_PICK';

  } else if (
    adjusted >= 80
  ) {
    recommendation =
      'USE';

  } else if (
    adjusted >= 70
  ) {
    recommendation =
      'REVIEW';

  } else if (
    adjusted >= 60
  ) {
    recommendation =
      'BACKUP';
  }

  return {
    qualityScore:
      quality,

    compositionTotal,

    expressionTotal,

    differentiationTotal,

    postScore,

    similarityPenalty:
      penalty,

    adjustedScore:
      adjusted,

    recommendation,

    compositionDetails:
      composition,

    expressionDetails:
      expression,

    differentiationDetails:
      differentiation,

    maxSimilarity:
      similarity,

    closestFile:
      diffResult
        ?.closest_file ||
      null,
  };
}


/* ============================================================
 * Review HTML
 * ============================================================ */

function generateHtmlReport(
  reviewData
) {
  const dataJson =
    JSON.stringify({
      model:
        reviewData.model,

      theme:
        reviewData.theme,

      source_folder:
        reviewData.source_folder,

      comment:
        reviewData.comment || '',

      publish_at:
        reviewData.publish_at || '',

      custom_rating_spec:
        reviewData.custom_rating_spec || '',

      images:
        reviewData.images,
    })
      .replace(
        /</g,
        '\\u003c'
      );

  const isRatingOnly =
    reviewData.review_mode === 'RATING_ONLY';

  const cards =
    [...reviewData.images]
      .sort(
        (a, b) =>
          (a.original_file ?? '').localeCompare(
            b.original_file ?? '',
            undefined,
            {
              numeric: true,
              sensitivity: 'base',
            }
          )
      )
      .map(
        (
          image,
          index
        ) => {

          if (
            image.analysis_status ===
            'ERROR'
          ) {
            return `
<article class="card error">

<img
  src="images/${encodeURIComponent(
              image.original_file
            )}"
  alt=""
>

<h3>
${escapeHtml(
              image.original_file
            )}
</h3>

<b>
ERROR
</b>

<p>
${escapeHtml(
              image.error_message
            )}
</p>

</article>
`;
          }

          const rating =
            image.rating
              ?.candidate ||
            'REVIEW';

          const humanBoxHtml = `
<div class="human-box">

<label class="select-check">
<input
  type="checkbox"
  class="js-selected"
>
採用する
</label>

<label class="gallery-visible-check">
<input
  type="checkbox"
  class="js-gallery-visible"
  checked
>
☑ ギャラリー掲載
</label>

<label>
並び順
<input
  class="js-order"
  type="number"
  min="1"
  step="1"
  placeholder="例: ${index + 1}"
>
</label>

<label>
メモ
<textarea
  class="js-notes"
  rows="2"
></textarea>
</label>

</div>
`;

          if (isRatingOnly) {
            return `
<article
  class="card review-card"
  data-file="${escapeHtml(
              image.original_file
            )}"
>

<img
  src="images/${encodeURIComponent(
              image.original_file
            )}"
  alt=""
>

<div class="top">

<h3>
${escapeHtml(
              image.original_file
            )}
</h3>

</div>

<p>
AI Rating:
<b>
${escapeHtml(
              rating
            )}
</b>

(${Math.round(
              (
                image.rating
                  ?.confidence ||
                0
              ) *
              100
            )}%)
</p>

${humanBoxHtml}

</article>
`;
          }

          return `
<article
  class="card review-card"
  data-file="${escapeHtml(
            image.original_file
          )}"
>

<img
  src="images/${encodeURIComponent(
            image.original_file
          )}"
  alt=""
>

<div class="top">

<h3>
${escapeHtml(
            image.original_file
          )}
</h3>

<strong class="score">
${image.scores.adjusted_score}
</strong>

</div>

<div class="recommend">
${escapeHtml(
            image.recommendation
          )}
</div>

<div class="scores">

<span>
画質
<b>
${image.scores.quality}/35
</b>
</span>

<span>
構図
<b>
${image.scores.composition}/25
</b>
</span>

<span>
表情
<b>
${image.scores.expression}/20
</b>
</span>

<span>
差別化
<b>
${image.scores.differentiation}/20
</b>
</span>

</div>

<p>
AI Rating:
<b>
${escapeHtml(
            rating
          )}
</b>

(${Math.round(
            (
              image.rating
                ?.confidence ||
              0
            ) *
            100
          )}%)
</p>

<p>
類似度:
${Math.round(
            (
              image.similarity
                ?.max_similarity ||
              0
            ) *
            100
          )}%

<br>

似ている画像:
${escapeHtml(
            image.similarity
              ?.closest_file ||
            '-'
          )}
</p>

${image.forced_exclusion
              ?
              `
<div class="warning">

強制除外:
${escapeHtml(
                image.forced_exclusion_reason ||
                '理由なし'
              )}

</div>
`
              :
              ''
            }

<p class="reason">
${escapeHtml(
              image.reason ||
              ''
            )}
</p>

${humanBoxHtml}

</article>
`;
        }
      )
      .join('\n');

  return `
<!doctype html>

<html lang="ja">

<head>

<meta charset="utf-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>
画像選定レビュー
</title>

<style>

body {
  margin: 0;
  padding: 24px;
  background: #0f172a;
  color: #f8fafc;
  font-family:
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
}

.container {
  max-width: 1500px;
  margin: auto;
}

.header,
.toolbar {
  background: #1e293b;
  border-radius: 12px;
  padding: 18px;
  margin-bottom: 20px;
}

.summary {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.summary span,
.live span {
  padding: 6px 10px;
  background: #334155;
  border-radius: 20px;
}

.grid {
  display: grid;
  grid-template-columns:
    repeat(
      auto-fill,
      minmax(
        310px,
        1fr
      )
    );
  gap: 20px;
}

.card {
  padding: 16px;
  background: #1e293b;
  border-radius: 12px;
}

.card.error {
  border: 1px solid #ef4444;
}

.card img {
  width: 100%;
  height: 320px;
  object-fit: contain;
  background: #000;
  border-radius: 8px;
  cursor: zoom-in;
  transition: transform 0.15s ease;
}

.card img:hover {
  transform: scale(1.01);
}

body.lightbox-open {
  overflow: hidden;
}

.lightbox {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(0, 0, 0, 0.88);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  box-sizing: border-box;
}

.lightbox[hidden] {
  display: none !important;
}

.lightbox-content {
  position: relative;
  max-width: 95vw;
  max-height: 92vh;
  display: flex;
  align-items: center;
  justify-content: center;
}

.lightbox img {
  max-width: 95vw;
  max-height: 92vh;
  width: auto;
  height: auto;
  object-fit: contain;
  border-radius: 6px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.8);
  cursor: zoom-out;
}

.lightbox-close {
  position: fixed;
  top: 16px;
  right: 20px;
  width: 44px;
  height: 44px;
  background: rgba(15, 23, 42, 0.8);
  border: 1px solid #475569;
  border-radius: 50%;
  color: #f8fafc;
  font-size: 28px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: 1010;
  transition: background 0.15s, transform 0.15s;
}

.lightbox-close:hover {
  background: #334155;
  transform: scale(1.1);
}

.top {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-top: 10px;
}

h3 {
  font-size: 13px;
  overflow-wrap: anywhere;
}

.score {
  font-size: 28px;
  color: #38bdf8;
}

.recommend {
  font-weight: 700;
  margin: 6px 0;
}

.scores {
  display: grid;
  grid-template-columns:
    repeat(
      4,
      1fr
    );
  gap: 4px;
  background: #0f172a;
  padding: 8px;
  border-radius: 8px;
}

.scores span {
  text-align: center;
  font-size: 12px;
}

.scores b {
  display: block;
}

.reason {
  color: #cbd5e1;
}

.warning {
  border: 1px solid #ef4444;
  color: #fca5a5;
  padding: 8px;
  border-radius: 6px;
}

.human-box {
  margin-top: 12px;
  padding: 12px;
  background: #111827;
  border-radius: 8px;
  display: grid;
  gap: 10px;
}

.human-box label {
  display: grid;
  gap: 5px;
  font-size: 13px;
}

.human-box .select-check,
.human-box .gallery-visible-check {
  display: flex;
  align-items: center;
  font-weight: 700;
  font-size: 14px;
  gap: 6px;
  cursor: pointer;
}

.human-box .gallery-visible-check {
  color: #38bdf8;
  font-size: 13px;
}

.human-box .select-check input,
.human-box .gallery-visible-check input {
  width: auto;
  cursor: pointer;
}

.human-box input,
.human-box select,
.human-box textarea {
  width: 100%;
  box-sizing: border-box;
  background: #fff;
  color: #111;
  padding: 8px;
  border: 0;
  border-radius: 6px;
}

.selected-card {
  outline: 2px solid #22c55e;
}

.toolbar {
  position: sticky;
  top: 8px;
  z-index: 100;
  transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s ease;
  will-change: transform;
}

.toolbar.toolbar-hidden {
  transform: translateY(calc(-100% - 24px));
  opacity: 0;
  pointer-events: none;
}

.toolbar-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 12px;
}

button {
  padding: 10px 14px;
  border: 0;
  border-radius: 7px;
  cursor: pointer;
  font-weight: 700;
}

.primary {
  background: #22c55e;
  color: #06210f;
}

.secondary {
  background: #38bdf8;
  color: #082f49;
}

.live {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.msg {
  margin-top: 10px;
  white-space: pre-wrap;
}

.msg.error {
  color: #fca5a5;
}

.msg.ok {
  color: #86efac;
}

.post-links-box {
  margin-top: 14px;
  padding: 14px 16px;
  background: #0f172a;
  border: 1px solid #334155;
  border-radius: 8px;
}

.post-links-title {
  font-weight: bold;
  font-size: 15px;
  color: #4ade80;
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.post-links-btns {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.post-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border-radius: 6px;
  color: #fff;
  text-decoration: none;
  font-size: 13px;
  font-weight: bold;
  box-shadow: 0 2px 4px rgba(0,0,0,0.3);
  transition: transform 0.15s, opacity 0.15s;
}

.post-btn:hover {
  transform: translateY(-1px);
  opacity: 0.9;
}

.post-btn-patreon {
  background: #ff424d;
}

.post-btn-postiz {
  background: #6366f1;
}

.post-settings {
  margin-top: 14px;
  background: #0f172a;
  border: 1px solid #334155;
  border-radius: 8px;
  padding: 12px 14px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.post-settings .full-width {
  grid-column: 1 / -1;
}

.post-settings .field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.post-settings label {
  font-size: 13px;
  font-weight: 700;
  color: #94a3b8;
}

.post-settings input,
.post-settings select,
.post-settings textarea {
  width: 100%;
  box-sizing: border-box;
  background: #1e293b;
  color: #f8fafc;
  border: 1px solid #475569;
  border-radius: 6px;
  padding: 8px 10px;
  font-family: inherit;
  font-size: 13px;
}

.post-settings input:focus,
.post-settings select:focus,
.post-settings textarea:focus {
  outline: 2px solid #38bdf8;
  border-color: transparent;
}

.post-settings .datetime-row {
  display: flex;
  gap: 6px;
  align-items: center;
}

.post-settings .mini-btn {
  padding: 8px 12px;
  font-size: 12px;
  white-space: nowrap;
}

.post-settings .hint {
  font-size: 11px;
  color: #64748b;
}

@media (max-width: 800px) {
  .post-settings {
    grid-template-columns: 1fr;
  }
}

</style>

</head>

<body>

<div class="container">

<div class="header">

<h1>
AI画像 投稿候補レビュー
</h1>

<p>

モデル:
<b>
${escapeHtml(
    reviewData.model
  )}
</b>

／

テーマ:
<b>
${escapeHtml(
    reviewData.theme
  )}
</b>

</p>

<p>

使用モデル:
<b>
${escapeHtml(
    ORGANIZER_MODEL
  )}
</b>

／ AIレビュー:
<b>
${isRatingOnly ? 'Ratingのみ' : '詳細'}
</b>

</p>

<div class="summary">
<span>
総数
${reviewData.summary.total_images}
</span>
</div>

</div>

<div class="toolbar">

<div class="live">

<span>
採用
<b id="selectedCount">
0
</b>
枚
</span>

<span>
ギャラリー掲載
<b id="galleryVisibleCount">
0
</b>
枚
</span>

</div>

<div class="post-settings">

<div class="field">

<label for="postCatSlug">
対象の猫 (Cat)
</label>

<select id="postCatSlug">
${CAT_OPTIONS.map(cat => `
  <option value="${escapeHtml(cat.slug)}" ${cat.slug === (reviewData.cat_slug || reviewData.model || 'rin') ? 'selected' : ''}>
    ${escapeHtml(cat.name)} (${escapeHtml(cat.slug)})
  </option>
`).join('')}
</select>

<div class="hint">
※作品が所属する猫を選択してください。
</div>

</div>

<div class="field">

<label for="postTitle">
作品タイトル
</label>

<input
  type="text"
  id="postTitle"
  placeholder="例: 窓辺でまどろむ凛ちゃん"
  value="${escapeHtml(reviewData.title || reviewData.theme || '')}"
>

<div class="hint">
※ギャラリーやInstagramに表示される作品名です。
</div>

</div>

<div class="field full-width">

<label for="postComment">
投稿コメント
</label>

<textarea
  id="postComment"
  rows="2"
  placeholder="投稿に添えるコメントを入力してください（任意）"
>${escapeHtml(reviewData.comment || '')}</textarea>

<div class="hint">
※EmDashの作品コメントおよびInstagram投稿キャプションに使用されます。
</div>

</div>

<div class="field full-width">

<label for="postPublishAt">
公開・投稿予定日時
</label>

<div class="datetime-row">

<input
  type="datetime-local"
  id="postPublishAt"
  value="${escapeHtml(reviewData.publish_at || '')}"
>

<button
  type="button"
  id="clearPublishAt"
  class="secondary mini-btn"
>
即時投稿にする
</button>

</div>

<div
  class="hint"
  id="publishAtStatus"
>
未指定: 即時投稿になります
</div>

</div>

</div>

<div class="toolbar-actions">

<button
  class="secondary"
  id="autoOrder"
>
採用順を自動入力
</button>

<button
  class="primary"
  id="applyResult"
>
承認して投稿用画像を生成
</button>

<button
  class="secondary"
  id="exportResult"
>
JSONのみ書き出す
</button>

</div>

<div
  id="message"
  class="msg"
></div>

</div>

<div class="grid">

${cards}

</div>

<div id="lightbox" class="lightbox" hidden aria-hidden="true">
  <button type="button" class="lightbox-close" id="lightboxClose" aria-label="閉じる">×</button>
  <div class="lightbox-content">
    <img id="lightboxImg" src="" alt="拡大画像">
  </div>
</div>

</div>

<script>

const REVIEW_DATA =
${dataJson};

const cards =
[
  ...document.querySelectorAll(
    '.review-card'
  )
];


function refresh() {
  let selected = 0;
  let galleryVisible = 0;

  cards.forEach(card => {
    const isSelected = card.querySelector('.js-selected').checked;
    card.classList.toggle('selected-card', isSelected);

    if (isSelected) {
      selected++;
      const isVisible = card.querySelector('.js-gallery-visible')?.checked ?? true;
      if (isVisible) {
        galleryVisible++;
      }
    }
  });

  document.getElementById('selectedCount').textContent = selected;
  const gCountEl = document.getElementById('galleryVisibleCount');
  if (gCountEl) {
    gCountEl.textContent = galleryVisible;
  }

  updatePublishAtStatus();
}

function updatePublishAtStatus() {
  const input = document.getElementById('postPublishAt');
  const statusEl = document.getElementById('publishAtStatus');
  if (!input || !statusEl) return;

  if (!input.value) {
    statusEl.textContent = '未指定: 即時投稿になります';
    statusEl.style.color = '#f59e0b';
  } else {
    statusEl.textContent = '予約日時: ' + input.value.replace('T', ' ');
    statusEl.style.color = '#38bdf8';
  }
}


cards.forEach(
  card =>
    card.addEventListener(
      'input',
      refresh
    )
);

const postPublishAtEl =
  document.getElementById('postPublishAt');
if (postPublishAtEl) {
  postPublishAtEl.addEventListener(
    'input',
    updatePublishAtStatus
  );
  postPublishAtEl.addEventListener(
    'change',
    updatePublishAtStatus
  );
}

const clearPublishAtBtn =
  document.getElementById('clearPublishAt');
if (clearPublishAtBtn) {
  clearPublishAtBtn.addEventListener(
    'click',
    () => {
      const input = document.getElementById('postPublishAt');
      if (input) {
        input.value = '';
        updatePublishAtStatus();
      }
    }
  );
}

refresh();

let lastScrollY = window.pageYOffset || document.documentElement.scrollTop;
let accumulatedDelta = 0;
const toolbarEl = document.querySelector('.toolbar');

window.addEventListener('scroll', () => {
  const currentScrollY = window.pageYOffset || document.documentElement.scrollTop;
  const delta = currentScrollY - lastScrollY;

  // 最上部（100px以下）にいるときは常に表示
  if (currentScrollY <= 100) {
    if (toolbarEl && toolbarEl.classList.contains('toolbar-hidden')) {
      toolbarEl.classList.remove('toolbar-hidden');
    }
    accumulatedDelta = 0;
    lastScrollY = currentScrollY;
    return;
  }

  // テキストエリアやテキスト入力欄でタイピング中のみ隠さない
  const activeTag = document.activeElement ? document.activeElement.tagName : '';
  const isTyping = (activeTag === 'TEXTAREA' || (activeTag === 'INPUT' && document.activeElement.type === 'text')) &&
                   toolbarEl && toolbarEl.contains(document.activeElement);
  if (isTyping) {
    lastScrollY = currentScrollY;
    return;
  }

  // スクロール方向が反転したら累積をリセット
  if ((delta > 0 && accumulatedDelta < 0) || (delta < 0 && accumulatedDelta > 0)) {
    accumulatedDelta = 0;
  }
  accumulatedDelta += delta;

  // 下スクロール: 累積で15px以上下にスクロールしたら隠す
  if (accumulatedDelta > 15) {
    if (toolbarEl && !toolbarEl.classList.contains('toolbar-hidden')) {
      toolbarEl.classList.add('toolbar-hidden');
    }
  }
  // 上スクロール: 累積で10px以上上にスクロールしたら再表示
  else if (accumulatedDelta < -10) {
    if (toolbarEl && toolbarEl.classList.contains('toolbar-hidden')) {
      toolbarEl.classList.remove('toolbar-hidden');
    }
  }

  lastScrollY = currentScrollY;
}, { passive: true });

// マウスが画面最上部（y <= 25px）に近づいたときも再表示
window.addEventListener('mousemove', (e) => {
  if (e.clientY <= 25 && toolbarEl && toolbarEl.classList.contains('toolbar-hidden')) {
    toolbarEl.classList.remove('toolbar-hidden');
    accumulatedDelta = 0;
  }
}, { passive: true });


document
  .getElementById(
    'autoOrder'
  )
  .addEventListener(
    'click',
    () => {

      let order =
        1;

      cards.forEach(
        card => {

          const selected =
            card
              .querySelector(
                '.js-selected'
              )
              .checked;

          const input =
            card
              .querySelector(
                '.js-order'
              );

          if (selected) {
            input.value =
              order++;
          } else {
            input.value =
              '';
          }
        }
      );

      refresh();
    }
  );


function buildReviewResult() {
  const message =
    document.getElementById(
      'message'
    );

  message.className =
    'msg';

  const approved = [];
  let visibleCount = 0;

  for (const card of cards) {
    if (!card.querySelector('.js-selected').checked) {
      continue;
    }

    const file = card.dataset.file;
    const order = Number(card.querySelector('.js-order').value);
    const galleryVisible = card.querySelector('.js-gallery-visible')?.checked ?? true;
    const notes = card.querySelector('.js-notes').value.trim();

    if (!Number.isInteger(order) || order < 1) {
      throw new Error(file + ' の並び順を1以上の整数で入力してください。');
    }

    if (galleryVisible) {
      visibleCount++;
    }

    approved.push({
      original_file: file,
      order,
      gallery_visible: galleryVisible,
      notes,
    });
  }

  if (!approved.length) {
    throw new Error('採用画像を1枚以上選んでください。');
  }

  approved.sort((a, b) => a.order - b.order);

  const orders = approved.map(item => item.order);
  if (new Set(orders).size !== orders.length) {
    throw new Error('並び順が重複しています。');
  }

  for (let i = 0; i < approved.length; i++) {
    if (approved[i].order !== i + 1) {
      throw new Error('並び順は1〜' + approved.length + 'の連番にしてください。');
    }
  }

  // ギャラリー掲載0枚チェック（警告確認、強制停止はしない）
  if (visibleCount === 0) {
    const ok = confirm('⚠️ ギャラリー掲載ONの画像が0枚です。\n（Webギャラリーには表示されず、Instagram専用作品となります）\nこのまま処理を続行しますか？');
    if (!ok) {
      throw new Error('処理を中断しました。ギャラリー掲載にチェックを入れてください。');
    }
  }

  const catSlug = document.getElementById('postCatSlug')?.value || 'rin';
  const postTitle = (document.getElementById('postTitle')?.value || '').trim() || REVIEW_DATA.theme || '猫作品';
  const postComment = (document.getElementById('postComment')?.value || '').trim();
  const rawPublishAt = (document.getElementById('postPublishAt')?.value || '').trim();

  let publishAt = '';
  if (rawPublishAt) {
    const dt = rawPublishAt.replace('T', ' ');
    publishAt = dt.length === 16 ? dt + ':00' : dt;
  }

  return {
    schema_version: '2.0',
    created_at: new Date().toISOString(),
    cat_slug: catSlug,
    title: postTitle,
    model: catSlug,
    theme: postTitle,
    source_folder: REVIEW_DATA.source_folder,
    comment: postComment,
    publish_at: publishAt,
    approved,
  };
}


function downloadReviewResult(
  output
) {
  const blob =
    new Blob(
      [
        JSON.stringify(
          output,
          null,
          2
        ),
      ],
      {
        type:
          'application/json',
      }
    );

  const url =
    URL.createObjectURL(
      blob
    );

  const anchor =
    document.createElement(
      'a'
    );

  anchor.href =
    url;

  anchor.download =
    'review-result.json';

  anchor.click();

  setTimeout(
    () =>
      URL.revokeObjectURL(
        url
      ),
    1000
  );
}


document
  .getElementById(
    'exportResult'
  )
  .addEventListener(
    'click',
    () => {
      const message =
        document.getElementById(
          'message'
        );

      try {
        const output =
          buildReviewResult();

        downloadReviewResult(
          output
        );

        message.className =
          'msg ok';

        message.textContent =
          'review-result.json を書き出しました。';

      } catch (err) {
        message.className =
          'msg error';

        message.textContent =
          err.message;
      }
    }
  );


document
  .getElementById(
    'applyResult'
  )
  .addEventListener(
    'click',
    async () => {
      const message =
        document.getElementById(
          'message'
        );

      const button =
        document.getElementById(
          'applyResult'
        );

      try {
        const output =
          buildReviewResult();

        const scheduleDesc =
          output.publish_at
            ? '【予約投稿】 ' + output.publish_at
            : '【即時投稿】 (日時指定なし)';

        const commentDesc =
          output.comment
            ? 'あり (' + (output.comment.length > 30 ? output.comment.slice(0, 30) + '...' : output.comment) + ')'
            : 'なし';

        const specDesc =
          output.custom_rating_spec
            ? output.custom_rating_spec + ' (個別指定)'
            : '自動計算';

        const confirmed =
          window.confirm(
            '【投稿設定の確認】\\n' +
            '----------------------------------------\\n' +
            '・採用枚数: ' + output.approved.length + ' 枚\\n' +
            '・投稿時間: ' + scheduleDesc + '\\n' +
            '・コメント: ' + commentDesc + '\\n' +
            '・個別指定: ' + specDesc + '\\n' +
            '----------------------------------------\\n\\n' +
            'この内容で投稿用画像を生成し、インポートを実行しますか？'
          );

        if (!confirmed) {
          return;
        }

        button.disabled =
          true;

        button.textContent =
          '生成中...';

        message.className =
          'msg';

        message.textContent =
          'review-result.json を保存し、投稿用画像を生成しています...';

        const response =
          await fetch(
            '/api/apply-review',
            {
              method:
                'POST',

              headers: {
                'Content-Type':
                  'application/json',
              },

              body:
                JSON.stringify(
                  output
                ),
            }
          );

        const result =
          await response.json();

        if (
          !response.ok ||
          !result.ok
        ) {
          throw new Error(
            result.message ||
            '投稿用画像の生成に失敗しました。'
          );
        }

        message.className =
          'msg ok';

        message.textContent =
          '承認が完了しました！\n\n' +
          'Cat: ' +
          (result.cat_slug || output.cat_slug || 'rin') +
          '\n' +
          'タイトル: ' +
          (result.title || output.title || '') +
          '\n' +
          '採用画像: ' +
          result.image_count +
          '枚\n' +
          '投稿予定時間: ' +
          (result.publish_at || '即時投稿') +
          '\n' +
          '投稿コメント: ' +
          (result.comment || 'なし') +
          '\n\n' +
          '出力先:\n' +
          result.approved_dir;

        if (result.import_started) {
          const startedAt = Date.now();
          const pollBox = document.createElement('div');
          pollBox.className = 'post-links-box';
          pollBox.innerHTML =
            '<div style="color: #60a5fa; font-weight: bold; margin-bottom: 6px;">' +
            '⏳ run-import.bat を自動起動しました。投稿処理を実行中...' +
            '</div>' +
            '<div style="font-size: 12px; color: #94a3b8;">' +
            'Patreon / Postiz への登録が完了すると、ここに各画面のリンクが表示されます。（別ウィンドウのバッチ画面でも確認できます）' +
            '</div>';
          message.appendChild(pollBox);

          const pollTimer = setInterval(async () => {
            try {
              const res = await fetch('/api/post-completion?since=' + startedAt);
              if (res.ok) {
                const json = await res.json();
                if (json.completed && json.data) {
                  clearInterval(pollTimer);
                  const pUrl = json.data.patreon_post_url || 'https://www.patreon.com/posts';
                  const pUrls = json.data.patreon_urls || {};
                  const pubUrl = pUrls.public || json.data.patreon_post_url || 'https://www.patreon.com/posts';
                  const freeUrl = pUrls.free_members || json.data.patreon_post_url || 'https://www.patreon.com/posts';
                  const paidUrl = pUrls.paid_members || json.data.patreon_post_url || 'https://www.patreon.com/posts';
                  const pzUrl = json.data.postiz_url || 'https://postiz.xx-ai-girls-miu.com';

                  pollBox.innerHTML =
                    '<div class="post-links-title">' +
                    '🎉 投稿が完了しました！' +
                    '</div>' +
                    '<div style="font-size: 12px; color: #cbd5e1; margin-bottom: 8px;">' +
                    '作品: <strong>' + (json.data.title || '') + '</strong> / モデル: <strong>' + (json.data.model || '') + '</strong>' +
                    '</div>' +
                    '<div style="font-size: 11px; color: #94a3b8; background: rgba(0,0,0,0.25); padding: 8px 10px; border-radius: 6px; margin-bottom: 12px; line-height: 1.5;">' +
                    '※ <strong>【一般向け】【無料会員向け】【会員限定】</strong>の3投稿がPatreonへ登録されました。<br>' +
                    '下記のボタンから各投稿の編集・確認画面（/edit）を直接開くことができます。' +
                    '</div>' +
                    '<div style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px;">' +
                    '  <div style="display: flex; align-items: center; justify-content: space-between; background: rgba(255,255,255,0.04); padding: 6px 10px; border-radius: 6px;">' +
                    '    <span style="font-size: 12px; font-weight: bold; color: #f1f5f9;">🌐 ① 一般向け（Public）</span>' +
                    '    <a href="' + pubUrl + '" target="_blank" rel="noopener noreferrer" class="post-btn post-btn-patreon" style="padding: 4px 10px; font-size: 11px;">編集画面を開く ↗</a>' +
                    '  </div>' +
                    '  <div style="display: flex; align-items: center; justify-content: space-between; background: rgba(255,255,255,0.04); padding: 6px 10px; border-radius: 6px;">' +
                    '    <span style="font-size: 12px; font-weight: bold; color: #f1f5f9;">🎁 ② 無料会員向け（Free members）</span>' +
                    '    <a href="' + freeUrl + '" target="_blank" rel="noopener noreferrer" class="post-btn post-btn-patreon" style="padding: 4px 10px; font-size: 11px;">編集画面を開く ↗</a>' +
                    '  </div>' +
                    '  <div style="display: flex; align-items: center; justify-content: space-between; background: rgba(255,255,255,0.04); padding: 6px 10px; border-radius: 6px;">' +
                    '    <span style="font-size: 12px; font-weight: bold; color: #f1f5f9;">🔒 ③ 会員向け（Paid members）</span>' +
                    '    <a href="' + paidUrl + '" target="_blank" rel="noopener noreferrer" class="post-btn post-btn-patreon" style="padding: 4px 10px; font-size: 11px;">編集画面を開く ↗</a>' +
                    '  </div>' +
                    '</div>' +
                    '<div class="post-links-btns">' +
                    '<a href="' + pzUrl + '" target="_blank" rel="noopener noreferrer" class="post-btn post-btn-postiz">' +
                    '📱 Postiz 管理画面を開く ↗' +
                    '</a>' +
                    (json.data.edit_url ? '<a href="' + json.data.edit_url + '" target="_blank" rel="noopener noreferrer" class="post-btn" style="background: #0284c7;">WordPress 編集画面 ↗</a>' : '') +
                    '<a href="https://www.patreon.com/posts" target="_blank" rel="noopener noreferrer" class="post-btn" style="background: #334155; color: #cbd5e1;">📋 Patreon全体一覧 ↗</a>' +
                    '</div>';
                }
              }
            } catch (e) {}
          }, 3000);

          setTimeout(() => clearInterval(pollTimer), 15 * 60 * 1000);
        } else {
          const failBox = document.createElement('div');
          failBox.style.marginTop = '10px';
          failBox.style.color = '#fcd34d';
          failBox.textContent = 'run-import.bat の自動起動に失敗しました。手動で実行してください:\\n' + result.run_import_bat;
          message.appendChild(failBox);
        }

      } catch (err) {
        message.className =
          'msg error';

        message.textContent =
          err.message;

      } finally {
        button.disabled =
          false;

        button.textContent =
          '承認して投稿用画像を生成';
      }
    }
  );

  // --- ライトボックス拡大表示 ---
  const lightboxEl = document.getElementById('lightbox');
  const lightboxImg = document.getElementById('lightboxImg');
  const lightboxCloseBtn = document.getElementById('lightboxClose');

  function openLightbox(src) {
    if (!lightboxEl || !lightboxImg || !src) return;
    lightboxImg.src = src;
    lightboxEl.removeAttribute('hidden');
    lightboxEl.setAttribute('aria-hidden', 'false');
    document.body.classList.add('lightbox-open');
  }

  function closeLightbox() {
    if (!lightboxEl || !lightboxImg) return;
    lightboxEl.setAttribute('hidden', '');
    lightboxEl.setAttribute('aria-hidden', 'true');
    lightboxImg.src = '';
    document.body.classList.remove('lightbox-open');
  }

  document.querySelectorAll('.card img').forEach(img => {
    img.addEventListener('click', (e) => {
      e.stopPropagation();
      openLightbox(img.src);
    });
  });

  if (lightboxCloseBtn) {
    lightboxCloseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeLightbox();
    });
  }

  if (lightboxEl) {
    lightboxEl.addEventListener('click', (e) => {
      if (e.target === lightboxEl || e.target === lightboxImg || e.target.closest('.lightbox-content')) {
        closeLightbox();
      }
    });
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && lightboxEl && !lightboxEl.hasAttribute('hidden')) {
      closeLightbox();
    }
  });
</script>
</body>

</html>
`;
}


/* ============================================================
 * Rating Spec
 * ============================================================ */

function buildRatingSpec(
  approved
) {
  const groups =
    [];

  let start =
    1;

  let current =
    approved[0].rating;

  for (
    let i = 1;
    i <= approved.length;
    i++
  ) {
    const rating =
      i <
        approved.length
        ?
        approved[i].rating
        :
        null;

    if (
      rating !==
      current
    ) {
      const end =
        i;

      groups.push(
        start ===
          end
          ?
          `${start} ${current}`
          :
          `${start}-${end} ${current}`
      );

      start =
        i + 1;

      current =
        rating;
    }
  }

  return groups.join(
    ', '
  );
}


function normalizeAndMergeRatingSpec(
  customSpec,
  approved
) {
  const autoSpec =
    buildRatingSpec(
      approved
    );

  if (!customSpec || !customSpec.trim()) {
    return autoSpec;
  }

  let text =
    customSpec.trim();

  const total =
    approved.length;

  /*
   * 日本語自然言語の変換
   */
  // 例: 「全画像をスレッズには投稿しない」「スレッズ除外」など
  text = text.replace(
    /(?:全(?:画像|部|て)?(?:を|は)?\s*)?(?:スレッズ|threads)(?:に|へ)?(?:は)?\s*(?:投稿し?ない|除外|ng|不可|禁止|なし)/gi,
    `1-${total} NO_THREADS`
  );
  // 例: 「13～23までギャラリー掲載OK」 -> 13-23 GALLERY
  text = text.replace(
    /(\d+)\s*(?:[-~〜～\u301c\uff5e]|から|まで)\s*(\d+)(?:まで)?(?:は)?\s*(?:ギャラリー|gallery)(?:掲載|表示)?(?:ok|公開|可)?/gi,
    '$1-$2 GALLERY'
  );
  text = text.replace(
    /(\d+)\s*(?:ギャラリー|gallery)(?:掲載|表示)?(?:ok|公開|可)?/gi,
    '$1 GALLERY'
  );
  // 例: 「1-12ギャラリー非公開」 -> 1-12 NO_GALLERY
  text = text.replace(
    /(\d+)\s*(?:[-~〜～\u301c\uff5e]|から|まで)\s*(\d+)(?:まで)?(?:は)?\s*(?:ギャラリー|gallery)(?:非表示|非公開|ng|除外|なし)/gi,
    '$1-$2 NO_GALLERY'
  );

  // 句点や改行をカンマに正規化
  text = text
    .replace(/[。\n\r]+/g, ', ')
    .replace(/,\s*,/g, ',')
    .replace(/^,\s*|,\s*$/g, '')
    .trim();

  // もしユーザーの指定に SAFE / MILD / SENSITIVE / EXPLICIT の指定が含まれていなければ、
  // 自動計算されたカードのRating（autoSpec）とマージする！
  const hasRatingKeyword =
    /\b(SAFE|MILD|SENSITIVE|EXPLICIT)\b/i.test(text);

  if (!hasRatingKeyword) {
    return `${autoSpec}, ${text}`;
  }

  return text;
}

/* ============================================================
 * Review Local Server
 * ============================================================ */

function getLocalMimeType(
  filePath
) {
  const ext =
    path
      .extname(filePath)
      .toLowerCase();

  if (ext === '.html') {
    return 'text/html; charset=utf-8';
  }

  if (ext === '.json') {
    return 'application/json; charset=utf-8';
  }

  if (
    ext === '.jpg' ||
    ext === '.jpeg'
  ) {
    return 'image/jpeg';
  }

  if (ext === '.png') {
    return 'image/png';
  }

  if (ext === '.webp') {
    return 'image/webp';
  }

  if (ext === '.css') {
    return 'text/css; charset=utf-8';
  }

  if (ext === '.js') {
    return 'text/javascript; charset=utf-8';
  }

  return 'application/octet-stream';
}


function openBrowser(
  url
) {
  try {
    let child;

    if (
      process.platform ===
      'win32'
    ) {
      child =
        spawn(
          'cmd',
          [
            '/c',
            'start',
            '',
            url,
          ],
          {
            detached:
              true,

            stdio:
              'ignore',

            windowsHide:
              true,
          }
        );

    } else if (
      process.platform ===
      'darwin'
    ) {
      child =
        spawn(
          'open',
          [
            url,
          ],
          {
            detached:
              true,

            stdio:
              'ignore',
          }
        );

    } else {
      child =
        spawn(
          'xdg-open',
          [
            url,
          ],
          {
            detached:
              true,

            stdio:
              'ignore',
          }
        );
    }

    child.unref();

  } catch (err) {
    console.warn(
      `[WARN] ブラウザを自動で開けませんでした: ${err.message}`
    );
  }
}

function runImportBat(
  batPath
) {
  try {
    const child =
      spawn(
        'cmd.exe',
        [
          '/c',
          'start',
          '',
          batPath,
        ],
        {
          detached:
            true,

          stdio:
            'ignore',

          windowsHide:
            false,
        }
      );

    child.unref();

    return true;

  } catch (err) {
    console.warn(
      `[WARN] run-import.bat を起動できませんでした: ${err.message}`
    );

    return false;
  }
}


async function readRequestJson(
  req
) {
  return await new Promise(
    (
      resolve,
      reject
    ) => {
      const chunks =
        [];

      let total =
        0;

      req.on(
        'data',
        chunk => {
          total +=
            chunk.length;

          if (
            total >
            2 * 1024 * 1024
          ) {
            reject(
              new Error(
                '送信データが大きすぎます。'
              )
            );

            req.destroy();
            return;
          }

          chunks.push(
            chunk
          );
        }
      );

      req.on(
        'end',
        () => {
          try {
            const text =
              Buffer
                .concat(
                  chunks
                )
                .toString(
                  'utf8'
                );

            const data =
              JSON.parse(
                text
              );

            resolve(
              data
            );

          } catch (err) {
            reject(
              new Error(
                `JSONを読み込めません: ${err.message}`
              )
            );
          }
        }
      );

      req.on(
        'error',
        reject
      );
    }
  );
}


async function startReviewServer({
  outputDir,
  reviewData,
}) {
  const normalizedRoot =
    path.resolve(
      outputDir
    );

  const server =
    http.createServer(
      async (
        req,
        res
      ) => {
        try {
          const requestUrl =
            new URL(
              req.url ||
              '/',
              'http://127.0.0.1'
            );

          /* ====================================================
           * API: Review Apply
           * ==================================================== */

          if (
            req.method ===
            'POST'
            &&
            requestUrl.pathname ===
            '/api/apply-review'
          ) {
            const data =
              await readRequestJson(
                req
              );

            /*
             * ブラウザから書き換えられた
             * model / theme / source_folder を
             * そのまま信用しない。
             */
            const catSlug = data?.cat_slug || data?.model || 'rin';
            const catValid = CAT_OPTIONS.some(c => c.slug === catSlug);
            if (!catValid) {
              throw new Error(`無効なCatが選択されています: ${catSlug}`);
            }

            const title = (data?.title || data?.theme || '').trim();
            if (!title) {
              throw new Error('作品タイトルを入力してください。');
            }

            if (
              path.resolve(
                String(
                  data?.source_folder ||
                  ''
                )
              ) !==
              path.resolve(
                String(
                  reviewData.source_folder ||
                  ''
                )
              )
            ) {
              throw new Error(
                '元画像フォルダが元レビューと一致しません。'
              );
            }

            const reviewResultPath =
              path.join(
                normalizedRoot,
                'review-result.json'
              );

            await fs.writeFile(
              reviewResultPath,
              JSON.stringify(
                data,
                null,
                2
              ),
              'utf8'
            );

            const applied =
              await applyReviewResult(
                reviewResultPath
              );

            const importStarted =
              applied
                ?.runImportBatPath
                ?
                runImportBat(
                  applied.runImportBatPath
                )
                :
                false;

            res.writeHead(
              200,
              {
                'Content-Type':
                  'application/json; charset=utf-8',

                'Cache-Control':
                  'no-store',
              }
            );

            res.end(
              JSON.stringify({
                ok:
                  true,

                message:
                  '承認結果を保存し、投稿用画像を生成しました。',

                review_result:
                  reviewResultPath,

                approved_dir:
                  applied
                    ?.approvedDir ||
                  '',

                run_import_bat:
                  applied
                    ?.runImportBatPath ||
                  '',

                image_count:
                  applied
                    ?.imageCount ||
                  0,

                cat_slug:
                  applied
                    ?.cat_slug ||
                  '',

                title:
                  applied
                    ?.title ||
                  '',

                publish_at:
                  applied
                    ?.publishAt ||
                  '',

                comment:
                  applied
                    ?.comment ||
                  '',

                import_started:
                  importStarted,
              })
            );

            return;
          }

          /* ====================================================
           * API: Post Completion Status
           * ==================================================== */

          if (
            req.method === 'GET' &&
            requestUrl.pathname === '/api/post-completion'
          ) {
            const completionJsonPath = path.join(
              __dirname,
              'post-completion.json'
            );

            let completionData = null;
            if (existsSync(completionJsonPath)) {
              try {
                const raw = await fs.readFile(
                  completionJsonPath,
                  'utf8'
                );
                completionData = JSON.parse(raw);
              } catch {}
            }

            const since = Number(requestUrl.searchParams.get('since') || 0);

            let isRecent = false;
            if (completionData?.timestamp) {
              const compTime = new Date(completionData.timestamp).getTime();
              if (compTime >= since - 2000) {
                isRecent = true;
              }
            }

            res.writeHead(200, {
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': 'no-store',
            });

            if (completionData && isRecent) {
              res.end(
                JSON.stringify({
                  ok: true,
                  completed: true,
                  data: completionData,
                })
              );
            } else {
              res.end(
                JSON.stringify({
                  ok: true,
                  completed: false,
                })
              );
            }

            return;
          }

          /* ====================================================
           * Static Files
           * ==================================================== */

          if (
            req.method !==
            'GET'
            &&
            req.method !==
            'HEAD'
          ) {
            res.writeHead(
              405,
              {
                'Content-Type':
                  'text/plain; charset=utf-8',
              }
            );

            res.end(
              'Method Not Allowed'
            );

            return;
          }

          let relativePath =
            decodeURIComponent(
              requestUrl.pathname
            );

          if (
            relativePath ===
            '/'
          ) {
            relativePath =
              '/review.html';
          }

          relativePath =
            relativePath.replace(
              /^\/+/,
              ''
            );

          const filePath =
            path.resolve(
              normalizedRoot,
              relativePath
            );

          /*
           * artwork-review の外へ
           * ../ などで抜けるのを防止。
           */
          const relativeCheck =
            path.relative(
              normalizedRoot,
              filePath
            );

          if (
            relativeCheck.startsWith(
              '..'
            )
            ||
            path.isAbsolute(
              relativeCheck
            )
          ) {
            res.writeHead(
              403,
              {
                'Content-Type':
                  'text/plain; charset=utf-8',
              }
            );

            res.end(
              'Forbidden'
            );

            return;
          }

          if (
            !existsSync(
              filePath
            )
            ||
            !statSync(
              filePath
            ).isFile()
          ) {
            res.writeHead(
              404,
              {
                'Content-Type':
                  'text/plain; charset=utf-8',
              }
            );

            res.end(
              'Not Found'
            );

            return;
          }

          const buffer =
            await fs.readFile(
              filePath
            );

          res.writeHead(
            200,
            {
              'Content-Type':
                getLocalMimeType(
                  filePath
                ),

              'Cache-Control':
                'no-store',
            }
          );

          if (
            req.method ===
            'HEAD'
          ) {
            res.end();
            return;
          }

          res.end(
            buffer
          );

        } catch (err) {
          console.error(
            `[Review Server] ${err.message}`
          );

          res.writeHead(
            500,
            {
              'Content-Type':
                'application/json; charset=utf-8',

              'Cache-Control':
                'no-store',
            }
          );

          res.end(
            JSON.stringify({
              ok:
                false,

              message:
                err.message ||
                '処理に失敗しました。',
            })
          );
        }
      }
    );


  await new Promise(
    (
      resolve,
      reject
    ) => {
      server.once(
        'error',
        reject
      );

      server.listen(
        0,
        '127.0.0.1',
        () => {
          server.off(
            'error',
            reject
          );

          resolve();
        }
      );
    }
  );


  const address =
    server.address();

  const port =
    typeof address ===
      'object'
      ?
      address.port
      :
      null;

  if (!port) {
    throw new Error(
      'レビューサーバーのポートを取得できませんでした。'
    );
  }

  const url =
    `http://127.0.0.1:${port}/review.html`;

  console.log('');
  console.log(
    '=================================='
  );

  console.log(
    'レビュー画面を起動しました'
  );

  console.log(
    '=================================='
  );

  console.log(
    url
  );

  console.log('');
  console.log(
    'このウィンドウはレビュー完了まで閉じないでください。'
  );

  console.log(
    '終了するときは Ctrl + C で閉じられます。'
  );

  openBrowser(
    url
  );

  return {
    server,
    url,
  };
}

/* ============================================================
 * Apply Review
 * ============================================================ */

async function createBackupIfNeeded(
  dir
) {
  if (
    !existsSync(dir)
  ) {
    return null;
  }

  const stamp =
    new Date()
      .toISOString()
      .replace(
        /[:.]/g,
        '-'
      );

  const backup =
    `${dir}.backup-${stamp}`;

  await fs.rename(
    dir,
    backup
  );

  return backup;
}


async function applyReviewResult(
  reviewPathInput
) {
  const reviewPath =
    path.resolve(
      reviewPathInput
    );

  if (
    !existsSync(
      reviewPath
    )
  ) {
    throw new Error(
      `review-result.json が見つかりません: ${reviewPath}`
    );
  }

  let data;

  try {
    data =
      JSON.parse(
        readFileSync(
          reviewPath,
          'utf8'
        )
      );

  } catch (err) {
    throw new Error(
      `review-result.json を読めません: ${err.message}`
    );
  }

  const catSlug =
    String(
      data.cat_slug ||
      data.model ||
      'rin'
    ).trim();

  const modelName = catSlug;

  const artworkTitle =
    String(
      data.title ||
      data.theme ||
      '猫作品'
    ).trim();

  const themeName = artworkTitle;

  const sourceFolder =
    path.resolve(
      String(
        data.source_folder ||
        ''
      )
    );

  const postComment =
    String(
      data.comment ||
      ''
    ).trim();

  const rawPublishAt =
    String(
      data.publish_at ||
      ''
    ).trim();

  const publishAt =
    rawPublishAt
      ? rawPublishAt.replace('T', ' ')
      : '';

  const customRatingSpec = '';

  if (
    !catSlug ||
    !artworkTitle ||
    !data.source_folder
  ) {
    throw new Error(
      'cat_slug / title / source_folder が不足しています。'
    );
  }

  if (
    !existsSync(
      sourceFolder
    )
  ) {
    throw new Error(
      `元画像フォルダが見つかりません: ${sourceFolder}`
    );
  }

  const approved =
    Array.isArray(
      data.approved
    )
      ?
      data.approved.map(
        item => ({
          ...item,

          order:
            Number(
              item.order
            ),

          rating:
            String(
              item.rating ||
              ''
            )
              .toUpperCase(),

          notes:
            String(
              item.notes ||
              ''
            ),
        })
      )
      :
      [];

  if (
    !approved.length
  ) {
    throw new Error(
      '採用画像がありません。'
    );
  }

  const orderSet =
    new Set();

  const fileSet =
    new Set();

  for (
    const item
    of approved
  ) {
    if (
      !item.original_file
    ) {
      throw new Error(
        'original_file が空です。'
      );
    }

    if (
      fileSet.has(
        item.original_file
      )
    ) {
      throw new Error(
        `同じ画像が複数回あります: ${item.original_file}`
      );
    }

    fileSet.add(
      item.original_file
    );

    if (
      !Number.isInteger(
        item.order
      )
      ||
      item.order <
      1
    ) {
      throw new Error(
        `${item.original_file}: order は1以上の整数にしてください。`
      );
    }

    if (
      orderSet.has(
        item.order
      )
    ) {
      throw new Error(
        `並び順 ${item.order} が重複しています。`
      );
    }

    orderSet.add(
      item.order
    );

    if (
      !existsSync(
        path.join(
          sourceFolder,
          item.original_file
        )
      )
    ) {
      throw new Error(
        `元画像が見つかりません: ${item.original_file}`
      );
    }
  }

  approved.sort(
    (
      a,
      b
    ) =>
      a.order -
      b.order
  );

  approved.forEach(
    (
      item,
      index
    ) => {
      if (
        item.order !==
        index + 1
      ) {
        throw new Error(
          `並び順は1〜${approved.length}の連番にしてください。`
        );
      }
    }
  );

  const approvedDir =
    path.join(
      __dirname,
      'artwork-approved',
      sanitizePathSegment(
        modelName,
        'model'
      ),
      sanitizePathSegment(
        themeName,
        'theme'
      )
    );

  const backupDir =
    await createBackupIfNeeded(
      approvedDir
    );

  await fs.mkdir(
    approvedDir,
    {
      recursive:
        true,
    }
  );

  const digits =
    Math.max(
      2,
      String(
        approved.length
      ).length
    );

  const manifestItems =
    [];

  for (
    const item
    of approved
  ) {
    const sourcePath =
      path.join(
        sourceFolder,
        item.original_file
      );

    const ext =
      path
        .extname(
          item.original_file
        )
        .toLowerCase();

    const newFile =
      `${String(
        item.order
      ).padStart(
        digits,
        '0'
      )}${ext}`;

    await fs.copyFile(
      sourcePath,
      path.join(
        approvedDir,
        newFile
      )
    );

    manifestItems.push({
      filename:
        newFile,

      sort_order:
        item.order,

      gallery_visible:
        item.gallery_visible !== false,

      new_file:
        newFile,

      order:
        item.order,

      original_file:
        item.original_file,

      notes:
        item.notes || '',
    });
  }

  const manifest = {
    schema_version:
      '2.0',

    created_at:
      new Date()
        .toISOString(),

    cat_slug:
      catSlug,

    title:
      artworkTitle,

    comment:
      postComment,

    publish_at:
      publishAt ||
      null,

    source_folder:
      sourceFolder,

    review_folder:
      path.dirname(reviewPath),

    approved_folder:
      approvedDir,

    image_count:
      manifestItems.length,

    images:
      manifestItems,

    // 互換キー
    model:
      catSlug,

    theme:
      artworkTitle,
  };

  /* ========================================================
   * manifest.json
   * ======================================================== */

  await fs.writeFile(
    path.join(
      approvedDir,
      'manifest.json'
    ),
    JSON.stringify(
      manifest,
      null,
      2
    ),
    'utf8'
  );


  /* ========================================================
   * import-instruction.txt
   * ======================================================== */

  await fs.writeFile(
    path.join(
      approvedDir,
      'import-instruction.txt'
    ),
    `Cat: ${catSlug}
タイトル: ${artworkTitle}
画像: ${manifestItems.length}枚
投稿時間: ${publishAt || '即時投稿'}
コメント: ${postComment || 'なし'}

承認済み画像フォルダ:
${approvedDir}

このフォルダ内の番号付き画像を使用してください。
元画像は変更・削除していません。

Windowsダブルクリック実行用:
run-import.bat

※ import_artwork.mjs は自動実行していません。
`,
    'utf8'
  );


  /* ========================================================
   * run-import.bat
   * ======================================================== */

  const runImportBat =
    `@echo off
chcp 65001 > nul

cd /d "%~dp0\\..\\..\\..\\.."

echo.
echo ==================================
echo Nyans Artwork Import
echo ==================================
echo.
echo Loading manifest.json...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "$m = Get-Content -Raw -Encoding UTF8 '%~dp0manifest.json' | ConvertFrom-Json; $cat = if ($m.cat_slug) { $m.cat_slug } else { $m.model }; $title = if ($m.title) { $m.title } else { $m.theme }; Write-Host ('Cat      : ' + $cat); Write-Host ('Title    : ' + $title); if ($m.publish_at) { Write-Host ('Publish  : ' + $m.publish_at) } else { Write-Host 'Publish  : 即時投稿' }; if ($m.comment) { Write-Host ('Comment  : ' + $m.comment) }; Write-Host ''; Write-Host ('Folder   : ' + $m.approved_folder); Write-Host ''; $a = @($m.approved_folder, $title, $cat); if ($m.publish_at) { $a += [string]$m.publish_at }; if ($m.comment) { $a += ('--comment=' + [string]$m.comment) }; $a += '--yes'; & node '.\\.ai-work\\import_artwork.mjs' @a; exit $LASTEXITCODE"

set EXIT_CODE=%ERRORLEVEL%

echo.
echo ----------------------------------
echo.

if not "%EXIT_CODE%"=="0" (
  echo Import failed.
  echo Exit code: %EXIT_CODE%
) else (
  echo Import completed.
)

echo.
pause

exit /b %EXIT_CODE%
`;

  await fs.writeFile(
    path.join(
      approvedDir,
      'run-import.bat'
    ),
    runImportBat.replace(/\r?\n/g, '\r\n'),
    'utf8'
  );


  /* ========================================================
   * 完了表示
   * ======================================================== */

  console.log(
    '\n=================================='
  );

  console.log(
    'レビュー結果を適用しました'
  );

  console.log(
    '=================================='
  );

  console.log(
    `Cat: ${catSlug}`
  );

  console.log(
    `タイトル: ${artworkTitle}`
  );

  console.log(
    `採用画像: ${manifestItems.length}枚`
  );

  console.log(
    `投稿時間: ${publishAt || '即時投稿'}`
  );

  console.log(
    `コメント: ${postComment || 'なし'}`
  );

  console.log('');

  console.log(
    `出力先: ${approvedDir}`
  );

  console.log(
    '  - 番号付き画像'
  );

  console.log(
    '  - manifest.json'
  );

  console.log(
    '  - rating-spec.txt'
  );

  console.log(
    '  - import-instruction.txt'
  );

  console.log(
    '  - import-command.txt'
  );

  console.log(
    '  - run-import.bat'
  );


  if (backupDir) {
    console.log('');

    console.log(
      `既存フォルダはバックアップしました: ${backupDir}`
    );
  }


  console.log('');

  console.log(
    '元画像は変更・削除していません。'
  );

  console.log(
    'import_artwork.mjs は自動実行していません。'
  );

  console.log(
    '確認後、run-import.bat を実行できます。'
  );

  return {
    approvedDir,

    backupDir,

    manifest,

    imageCount:
      manifestItems.length,

    cat_slug:
      catSlug,

    title:
      artworkTitle,

    publishAt,

    comment:
      postComment,

    runImportBatPath:
      path.join(
        approvedDir,
        'run-import.bat'
      ),
  };
}


/* ============================================================
 * MAIN
 * ============================================================ */

async function main() {
  const options =
    parseCliArgs();

  if (
    options.applyReview
  ) {
    await applyReviewResult(
      options.applyReview
    );

    return;
  }

  if (
    options.help ||
    !options.folder
  ) {
    printUsage();

    if (
      !options.folder
    ) {
      process.exit(1);
    }

    return;
  }

  const targetFolder =
    path.resolve(
      options.folder
    );

  if (
    !existsSync(
      targetFolder
    )
    ||
    !statSync(
      targetFolder
    ).isDirectory()
  ) {
    throw new Error(
      `対象フォルダが見つかりません: ${targetFolder}`
    );
  }

  const themeName =
    options.theme ||
    path.basename(
      targetFolder
    );

  const modelName =
    options.model ||
    path.basename(
      path.dirname(
        targetFolder
      )
    );

  const outputDir =
    path.join(
      __dirname,
      'artwork-review',
      modelName,
      themeName
    );

  const cachePath =
    path.join(
      outputDir,
      'analysis-cache.json'
    );

  const reviewJsonPath =
    path.join(
      outputDir,
      'review.json'
    );

  const reviewHtmlPath =
    path.join(
      outputDir,
      'review.html'
    );

  const imagesDir =
    path.join(
      outputDir,
      'images'
    );

  const dirEntries =
    await fs.readdir(
      targetFolder,
      {
        withFileTypes:
          true,
      }
    );

  const imageFiles =
    dirEntries
      .filter(
        item =>
          item.isFile()
          &&
          ALLOWED_EXTS.has(
            path
              .extname(
                item.name
              )
              .toLowerCase()
          )
      )
      .map(
        item =>
          item.name
      )
      .sort(
        (
          a,
          b
        ) =>
          a.localeCompare(
            b,
            undefined,
            {
              numeric:
                true,

              sensitivity:
                'base',
            }
          )
      );

  if (
    !imageFiles.length
  ) {
    throw new Error(
      '対象画像がありません。'
    );
  }

  const reviewMode =
    options.fullReview ? 'FULL_REVIEW' : 'RATING_ONLY';

  console.log(
    `対象モデル: ${modelName}
対象テーマ: ${themeName}
対象画像: ${imageFiles.length}枚
レビューモード: ${reviewMode === 'RATING_ONLY' ? 'Ratingのみ (RATING_ONLY)' : '詳細レビュー (FULL_REVIEW)'}
画像選定モデル: ${ORGANIZER_MODEL}
一括評価: ${SINGLE_BATCH_SIZE}枚 / request
`
  );

  if (
    options.dryRun
  ) {
    console.log(
      `==================================
[DRY-RUN] 対象確認モード
==================================
モデル: ${modelName}
テーマ: ${themeName}
レビューモード: ${reviewMode === 'RATING_ONLY' ? 'Ratingのみ (RATING_ONLY)' : '詳細レビュー (FULL_REVIEW)'}
画像枚数: ${imageFiles.length}枚
対象画像一覧:`
    );

    imageFiles.forEach(
      (
        file,
        index
      ) =>
        console.log(
          `  [${index + 1}] ${file}`
        )
    );

    const singleReqs = Math.ceil(
      imageFiles.length /
      SINGLE_BATCH_SIZE
    );
    const diffReqs = reviewMode === 'FULL_REVIEW' && imageFiles.length > 1 ? 1 : 0;
    const total = singleReqs + diffReqs;

    console.log(
      `\n単体評価予定リクエスト: ${singleReqs}回
類似比較予定リクエスト: ${diffReqs}回
合計予定: ${total}回

出力予定先: ${outputDir}
  - review.json
  - review.html
※dry-run のため、Gemini呼び出しおよびファイル書き込みは行いません。`
    );

    return;
  }

  if (
    !GEMINI_API_KEY
  ) {
    throw new Error(
      'GEMINI_API_KEY がありません。'
    );
  }

  await fs.mkdir(
    imagesDir,
    {
      recursive:
        true,
    }
  );

  let cache =
    {};

  if (
    !options.force
    &&
    existsSync(
      cachePath
    )
  ) {
    try {
      cache =
        JSON.parse(
          readFileSync(
            cachePath,
            'utf8'
          )
        );

    } catch {
      cache =
        {};
    }
  }


  /* ========================================================
   * 画像一覧
   * ======================================================== */

  const entries =
    imageFiles.map(
      fileName => {

        const filePath =
          path.join(
            targetFolder,
            fileName
          );

        const stat =
          statSync(
            filePath
          );

        return {
          fileName,

          filePath,

          size:
            stat.size,

          mtimeMs:
            stat.mtimeMs,

          sha256:
            sha256(
              filePath
            ),
        };
      }
    );


  /* ========================================================
   * キャッシュ判定
   * ======================================================== */

  const successful =
    new Map();

  const uncached =
    [];

  for (
    const entry
    of entries
  ) {
    const cached =
      cache[
      entry.fileName
      ];

    let valid = false;
    let singleAnalysisToUse = null;

    if (
      !options.force
      &&
      cached
      &&
      cached.size === entry.size
      &&
      cached.mtimeMs === entry.mtimeMs
      &&
      cached.sha256 === entry.sha256
      &&
      cached.analysis_model === ORGANIZER_MODEL
      &&
      cached.single_analysis
    ) {
      if (reviewMode === 'RATING_ONLY') {
        if (
          cached.analysis_version === RATING_ANALYSIS_VERSION
          &&
          cached.single_analysis?.rating?.candidate
        ) {
          valid = true;
          singleAnalysisToUse = cached.single_analysis;
        } else if (
          cached.analysis_version === FULL_ANALYSIS_VERSION
          &&
          cached.single_analysis?.rating?.candidate
        ) {
          valid = true;
          singleAnalysisToUse = {
            file: entry.fileName,
            rating: cached.single_analysis.rating,
          };
        }
      } else {
        if (
          cached.analysis_version === FULL_ANALYSIS_VERSION
          &&
          cached.single_analysis?.quality
        ) {
          valid = true;
          singleAnalysisToUse = cached.single_analysis;
        }
      }
    }

    if (valid && singleAnalysisToUse) {
      successful.set(
        entry.fileName,
        singleAnalysisToUse
      );

      console.log(
        `[CACHE] ${entry.fileName}`
      );

    } else {
      uncached.push(
        entry
      );
    }
  }


  /* ========================================================
   * 5枚ずつ評価
   * ======================================================== */

  for (
    let start = 0;
    start <
    uncached.length;
    start +=
    SINGLE_BATCH_SIZE
  ) {
    const batch =
      uncached.slice(
        start,
        start +
        SINGLE_BATCH_SIZE
      );

    console.log(
      `\n[ANALYZE] ${start + 1}〜${Math.min(
        start +
        batch.length,
        uncached.length
      )} / ${uncached.length}
${batch
        .map(
          item =>
            '  - ' +
            item.fileName
        )
        .join('\n')}`
    );

    let results;

    try {
      if (reviewMode === 'RATING_ONLY') {
        results =
          await analyzeRatingOnlyBatch(
            batch
          );
      } else {
        results =
          await analyzeImageBatch(
            batch,
            modelName,
            themeName
          );
      }

    } catch (err) {
      if (
        err?.code ===
        'GEMINI_RATE_LIMIT_ABORT'
      ) {
        throw err;
      }

      console.error(
        `[エラー] バッチ解析に失敗しました: ${err.message}`
      );

      if (reviewMode === 'RATING_ONLY') {
        for (const entry of batch) {
          const fallbackResult = {
            file: entry.fileName,
            rating: {
              candidate: 'REVIEW',
              confidence: 0,
            },
          };
          successful.set(entry.fileName, fallbackResult);
          console.warn(`[FALLBACK] ${entry.fileName} -> REVIEW (confidence: 0)`);
        }
      }

      continue;
    }

    const resultMap =
      new Map(
        results.map(
          result => [
            result.file,
            result,
          ]
        )
      );

    for (
      const entry
      of batch
    ) {
      const result =
        resultMap.get(
          entry.fileName
        );

      if (!result) {
        console.warn(
          `[WARN] ${entry.fileName}: Gemini結果がありません。`
        );

        if (reviewMode === 'RATING_ONLY') {
          const fallbackResult = {
            file: entry.fileName,
            rating: {
              candidate: 'REVIEW',
              confidence: 0,
            },
          };
          successful.set(entry.fileName, fallbackResult);
        }

        continue;
      }

      successful.set(
        entry.fileName,
        result
      );

      cache[
        entry.fileName
      ] = {
        size:
          entry.size,

        mtimeMs:
          entry.mtimeMs,

        sha256:
          entry.sha256,

        single_analysis:
          result,

        analysis_status:
          'OK',

        analysis_version:
          reviewMode === 'RATING_ONLY'
            ? RATING_ANALYSIS_VERSION
            : FULL_ANALYSIS_VERSION,

        review_mode:
          reviewMode,

        analysis_model:
          ORGANIZER_MODEL,

        media_resolution:
          SINGLE_MEDIA_RESOLUTION,
      };

      if (reviewMode === 'RATING_ONLY') {
        console.log(
          `[OK] ${entry.fileName} rating=${result.rating?.candidate ?? '-'} (${Math.round((result.rating?.confidence ?? 0) * 100)}%)`
        );
      } else {
        console.log(
          `[OK] ${entry.fileName} quality=${result.quality?.score ?? '-'} rating=${result.rating?.candidate ?? '-'}`
        );
      }
    }

    await fs.writeFile(
      cachePath,
      JSON.stringify(
        cache,
        null,
        2
      ),
      'utf8'
    );
  }


  /* ========================================================
   * 類似比較
   * ======================================================== */

  const diffEntries =
    entries.filter(
      entry =>
        successful.has(
          entry.fileName
        )
    );

  let diffMap =
    new Map();

  if (
    reviewMode === 'FULL_REVIEW'
    &&
    diffEntries.length
  ) {
    const fingerprint =
      crypto
        .createHash(
          'sha256'
        )
        .update(
          JSON.stringify({
            version:
              DIFFERENTIATION_ANALYSIS_VERSION,

            model:
              ORGANIZER_MODEL,

            images:
              diffEntries.map(
                item => ({
                  file:
                    item.fileName,

                  sha:
                    item.sha256,
                })
              ),
          })
        )
        .digest(
          'hex'
        );

    let comparisons;

    const cachedDiff =
      cache
        .__differentiation;

    if (
      !options.force
      &&
      cachedDiff
        ?.fingerprint ===
      fingerprint
      &&
      Array.isArray(
        cachedDiff.results
      )
    ) {
      console.log(
        '[CACHE] 類似・差別化解析'
      );

      comparisons =
        cachedDiff.results;

    } else {
      console.log(
        `\n[COMPARE] ${diffEntries.length}枚を全体比較します...`
      );

      comparisons =
        await analyzeDifferentiation(
          diffEntries,
          modelName,
          themeName
        );

      cache.__differentiation = {
        fingerprint,

        analysis_version:
          DIFFERENTIATION_ANALYSIS_VERSION,

        analysis_model:
          ORGANIZER_MODEL,

        created_at:
          new Date()
            .toISOString(),

        results:
          comparisons,
      };

      await fs.writeFile(
        cachePath,
        JSON.stringify(
          cache,
          null,
          2
        ),
        'utf8'
      );
    }

    diffMap =
      new Map(
        comparisons.map(
          result => [
            result.file,
            result,
          ]
        )
      );
  }


  /* ========================================================
   * 最終集計
   * ======================================================== */

  const finalImages =
    [];

  const summary =
    reviewMode === 'RATING_ONLY'
      ? {
          total_images:
            imageFiles.length,

          safe:
            0,

          mild:
            0,

          sensitive:
            0,

          explicit:
            0,

          review:
            0,
        }
      : {
          total_images:
            imageFiles.length,

          top_pick:
            0,

          use:
            0,

          review:
            0,

          backup:
            0,

          skip:
            0,
        };

  for (
    const entry
    of entries
  ) {
    const single =
      successful.get(
        entry.fileName
      );

    if (!single) {
      if (reviewMode === 'RATING_ONLY') {
        summary.review++;

        finalImages.push({
          original_file:
            entry.fileName,

          analysis_status:
            'ERROR',

          error_message:
            '未解析またはGemini解析失敗',

          scores: {
            quality: 0,
            composition: 0,
            expression: 0,
            differentiation: 0,
            post_score: 0,
            similarity_penalty: 0,
            adjusted_score: 0,
          },

          score_details: {
            composition: {
              subject_framing: 0,
              visual_balance: 0,
              crop_and_spacing: 0,
              pose_readability: 0,
              background_harmony: 0,
            },
            expression: {
              naturalness: 0,
              eye_mouth_consistency: 0,
              emotional_clarity: 0,
              character_presence: 0,
            },
            differentiation: {
              composition_difference: 0,
              pose_difference: 0,
              expression_difference: 0,
              camera_distance_difference: 0,
              background_or_direction_difference: 0,
            },
          },

          quality_flags:
            [],

          rating: {
            candidate:
              'REVIEW',

            confidence:
              0,

            final:
              null,
          },

          similarity: {
            max_similarity:
              0,

            closest_file:
              null,
          },

          forced_exclusion:
            false,

          forced_exclusion_reason:
            null,

          recommendation:
            null,

          reason:
            '解析できませんでした。',

          human_review: {
            selected:
              null,

            order:
              null,

            notes:
              '',
          },
        });

      } else {
        summary.skip++;

        finalImages.push({
          original_file:
            entry.fileName,

          analysis_status:
            'ERROR',

          error_message:
            '未解析またはGemini解析失敗',

          recommendation:
            'SKIP',

          scores: {
            quality: 0,
            composition: 0,
            expression: 0,
            differentiation: 0,
            post_score: 0,
            similarity_penalty: 0,
            adjusted_score: 0,
          },

          score_details: {
            composition: {
              subject_framing: 0,
              visual_balance: 0,
              crop_and_spacing: 0,
              pose_readability: 0,
              background_harmony: 0,
            },
            expression: {
              naturalness: 0,
              eye_mouth_consistency: 0,
              emotional_clarity: 0,
              character_presence: 0,
            },
            differentiation: {
              composition_difference: 0,
              pose_difference: 0,
              expression_difference: 0,
              camera_distance_difference: 0,
              background_or_direction_difference: 0,
            },
          },

          quality_flags:
            [],

          rating: {
            candidate:
              'REVIEW',

            confidence:
              0,

            final:
              null,
          },

          similarity: {
            max_similarity:
              0,

            closest_file:
              null,
          },

          forced_exclusion:
            true,

          forced_exclusion_reason:
            '解析エラー',

          reason:
            '解析できませんでした。',

          human_review: {
            selected:
              null,

            order:
              null,

            notes:
              '',
          },
        });
      }

      continue;
    }

    if (reviewMode === 'RATING_ONLY') {
      const cand =
        (single.rating?.candidate || 'REVIEW').toUpperCase();

      if (cand === 'SAFE') {
        summary.safe++;
      } else if (cand === 'MILD') {
        summary.mild++;
      } else if (cand === 'SENSITIVE') {
        summary.sensitive++;
      } else if (cand === 'EXPLICIT') {
        summary.explicit++;
      } else {
        summary.review++;
      }

      finalImages.push({
        original_file:
          entry.fileName,

        analysis_status:
          'OK',

        scores: {
          quality: 0,
          composition: 0,
          expression: 0,
          differentiation: 0,
          post_score: 0,
          similarity_penalty: 0,
          adjusted_score: 0,
        },

        score_details: {
          composition: {
            subject_framing: 0,
            visual_balance: 0,
            crop_and_spacing: 0,
            pose_readability: 0,
            background_harmony: 0,
          },
          expression: {
            naturalness: 0,
            eye_mouth_consistency: 0,
            emotional_clarity: 0,
            character_presence: 0,
          },
          differentiation: {
            composition_difference: 0,
            pose_difference: 0,
            expression_difference: 0,
            camera_distance_difference: 0,
            background_or_direction_difference: 0,
          },
        },

        quality_flags:
          [],

        rating: {
          candidate:
            single.rating?.candidate ||
            'REVIEW',

          confidence:
            single.rating?.confidence ??
            0,

          final:
            null,
        },

        similarity: {
          max_similarity:
            0,

          closest_file:
            null,
        },

        forced_exclusion:
          false,

        forced_exclusion_reason:
          null,

        recommendation:
          null,

        reason:
          '',

        human_review: {
          selected:
            null,

          order:
            null,

          notes:
            '',
        },
      });

    } else {
      const diff =
        diffMap.get(
          entry.fileName
        )
        ||
        {
          closest_file:
            null,

          max_similarity:
            0,

          differentiation: {
            composition_difference: 0,
            pose_difference: 0,
            expression_difference: 0,
            camera_distance_difference: 0,
            background_or_direction_difference: 0,
          },
        };

      const calculated =
        calculateNodeScores(
          single,
          diff
        );

      if (
        calculated.recommendation ===
        'TOP_PICK'
      ) {
        summary.top_pick++;

      } else if (
        calculated.recommendation ===
        'USE'
      ) {
        summary.use++;

      } else if (
        calculated.recommendation ===
        'REVIEW'
      ) {
        summary.review++;

      } else if (
        calculated.recommendation ===
        'BACKUP'
      ) {
        summary.backup++;

      } else {
        summary.skip++;
      }

      finalImages.push({
        original_file:
          entry.fileName,

        analysis_status:
          'OK',

        scores: {
          quality:
            calculated.qualityScore,

          composition:
            calculated.compositionTotal,

          expression:
            calculated.expressionTotal,

          differentiation:
            calculated.differentiationTotal,

          post_score:
            calculated.postScore,

          similarity_penalty:
            calculated.similarityPenalty,

          adjusted_score:
            calculated.adjustedScore,
        },

        score_details: {
          composition:
            calculated.compositionDetails,

          expression:
            calculated.expressionDetails,

          differentiation:
            calculated.differentiationDetails,
        },

        quality_flags:
          single
            ?.quality
            ?.flags ||
          [],

        rating: {
          candidate:
            single
              ?.rating
              ?.candidate ||
            'REVIEW',

          confidence:
            single
              ?.rating
              ?.confidence ??
            0,

          final:
            null,
        },

        similarity: {
          max_similarity:
            calculated.maxSimilarity,

          closest_file:
            calculated.closestFile,
        },

        forced_exclusion:
          Boolean(
            single
              ?.forced_exclusion
          ),

        forced_exclusion_reason:
          single
            ?.forced_exclusion_reason ||
          null,

        recommendation:
          calculated.recommendation,

        reason:
          single
            ?.reason ||
          '',

        human_review: {
          selected:
            null,

          order:
            null,

          notes:
            '',
        },
      });
    }
  }

  const reviewData = {
    schema_version:
      '3.0',

    review_mode:
      reviewMode,

    created_at:
      new Date()
        .toISOString(),

    organizer_model:
      ORGANIZER_MODEL,

    batch_size:
      SINGLE_BATCH_SIZE,

    model:
      modelName,

    theme:
      themeName,

    source_folder:
      targetFolder,

    status:
      'PENDING_REVIEW',

    summary,

    images:
      finalImages,
  };


  /* ========================================================
   * 保存
   * ======================================================== */

  for (
    const entry
    of entries
  ) {
    await fs.copyFile(
      entry.filePath,
      path.join(
        imagesDir,
        entry.fileName
      )
    );
  }

  await fs.writeFile(
    reviewJsonPath,
    JSON.stringify(
      reviewData,
      null,
      2
    ),
    'utf8'
  );

  await fs.writeFile(
    reviewHtmlPath,
    generateHtmlReport(
      reviewData
    ),
    'utf8'
  );

  if (reviewMode === 'RATING_ONLY') {
    console.log(
      `\n==================================
画像整理が完了しました (Ratingのみ)
==================================
画像: ${summary.total_images}枚
SAFE: ${summary.safe}
MILD: ${summary.mild}
SENSITIVE: ${summary.sensitive}
EXPLICIT: ${summary.explicit}
REVIEW: ${summary.review}

Geminiモデル: ${ORGANIZER_MODEL}
API成功リクエスト: ${GEMINI_USAGE.requests}回
入力トークン: ${GEMINI_USAGE.promptTokens.toLocaleString()}
出力トークン: ${GEMINI_USAGE.outputTokens.toLocaleString()}
合計トークン: ${GEMINI_USAGE.totalTokens.toLocaleString()}

review.html: ${reviewHtmlPath}`
    );
  } else {
    console.log(
      `\n==================================
画像整理が完了しました (詳細レビュー)
==================================
画像: ${summary.total_images}枚
TOP_PICK: ${summary.top_pick}
USE: ${summary.use}
REVIEW: ${summary.review}
BACKUP: ${summary.backup}
SKIP: ${summary.skip}

Geminiモデル: ${ORGANIZER_MODEL}
API成功リクエスト: ${GEMINI_USAGE.requests}回
入力トークン: ${GEMINI_USAGE.promptTokens.toLocaleString()}
出力トークン: ${GEMINI_USAGE.outputTokens.toLocaleString()}
合計トークン: ${GEMINI_USAGE.totalTokens.toLocaleString()}

review.html: ${reviewHtmlPath}`
    );
  }

  await startReviewServer({
    outputDir,
    reviewData,
  });
}


/* ============================================================
 * ERROR
 * ============================================================ */

main()
  .catch(
    err => {

      if (
        err?.code ===
        'GEMINI_RATE_LIMIT_ABORT'
      ) {
        console.error(
          `\n==================================
Gemini APIレート制限のため一時停止しました
==================================

429エラーが2回連続したため、
これ以上のAPI呼び出しを停止しました。`
        );

        if (
          Number.isFinite(
            Number(
              err.retryAfterMs
            )
          )
        ) {
          console.error(
            `Gemini推奨待機時間: 約${Math.ceil(
              Number(
                err.retryAfterMs
              ) /
              1000
            )}秒`
          );
        }

        console.error(
          `正常に解析済みのバッチはキャッシュへ保存されています。
時間を空けて同じコマンドを再実行してください。

※ --force は付けないでください。`
        );

        process.exit(2);
      }

      console.error(
        `[エラー] ${err.message}`
      );

      process.exit(1);
    }
  );