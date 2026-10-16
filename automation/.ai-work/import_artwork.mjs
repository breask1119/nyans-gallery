import fs from 'node:fs/promises';
import {
  readFileSync,
  existsSync,
} from 'node:fs';

import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/* ============================================================
 * 基本
 * ============================================================ */

const __filename =
  fileURLToPath(import.meta.url);

const __dirname =
  path.dirname(__filename);

/* ============================================================
 * .env 読み込み
 * ============================================================ */

const envPath =
  path.join(
    __dirname,
    '.env'
  );

if (existsSync(envPath)) {
  const envContent =
    readFileSync(
      envPath,
      'utf-8'
    );

  for (
    const line
    of envContent.split(/\r?\n/)
  ) {
    const trimmed =
      line.trim();

    if (
      !trimmed ||
      trimmed.startsWith('#')
    ) {
      continue;
    }

    const eqIdx =
      trimmed.indexOf('=');

    if (eqIdx === -1) {
      continue;
    }

    const key =
      trimmed
        .slice(0, eqIdx)
        .trim();

    const value =
      trimmed
        .slice(eqIdx + 1)
        .trim()
        .replace(
          /^['"](.*)['"]$/,
          '$1'
        );

    if (!process.env[key]) {
      process.env[key] =
        value;
    }
  }
}

/* ============================================================
 * API設定
 * ============================================================ */

const API_URL =
  process.env.MIU_IMPORT_API_URL ||
  'https://api.xx-ai-girls-miu.com/wp-json/miu/v1/import-artwork';

const API_TOKEN =
  process.env.MIU_IMPORT_API_TOKEN ||
  '';

const GEMINI_API_KEY =
  process.env.MIU_GEMINI_API_KEY ||
  process.env.GEMINI_API_KEY ||
  '';

const JEV_API_KEY =
  process.env.JEV_API_KEY ||
  '';

const GEMINI_TAG_MODEL =
  process.env.MIU_GEMINI_TAG_MODEL ||
  'gemini-3.5-flash-lite';

const JEV_MODEL =
  process.env.JEV_MODEL ||
  'jev-latest';

/*
 * Patreon Worker
 */
const PATREON_WORKER_DIR =
  process.env.MIU_PATREON_WORKER_DIR ||
  path.join(
    os.homedir(),
    'miu-patreon-auth'
  );

/*
 * Geminiへ送る最大画像枚数
 */
const MAX_IMAGES_FOR_ANALYSIS =
  Math.max(
    1,
    Number(
      process.env.MIU_AI_MAX_IMAGES ||
      12
    )
  );

/*
 * Postiz 管理画面URL
 */
const POSTIZ_BASE_URL =
  process.env.POSTIZ_URL ||
  process.env.POSTIZ_BASE_URL ||
  'https://postiz.xx-ai-girls-miu.com';


/* ============================================================
 * 対応画像形式
 * ============================================================ */

const ALLOWED_EXTS =
  new Set([
    '.png',
    '.jpg',
    '.jpeg',
    '.webp',
    '.gif',
  ]);

const ALLOWED_RATINGS =
  new Set([
    'SAFE',
    'MILD',
    'SENSITIVE',
    'EXPLICIT',
    'REVIEW',
  ]);

/* ============================================================
 * 日時
 * ============================================================ */

function normalizeJstPublishAt(
  value
) {
  if (!value) {
    return null;
  }

  const raw =
    String(value).trim();

  if (
    /(?:Z|[+\-]\d{2}:?\d{2})$/i
      .test(raw)
  ) {
    return raw;
  }

  const match =
    raw.match(
      /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/
    );

  if (!match) {
    throw new Error(
      `公開日時の形式が不正です: ${raw}\n例: 2026-09-28 20:00:00`
    );
  }

  const year =
    Number(match[1]);

  const month =
    Number(match[2]);

  const day =
    Number(match[3]);

  const hour =
    Number(match[4]);

  const minute =
    Number(match[5]);

  const second =
    Number(
      match[6] || 0
    );

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    throw new Error(
      `公開日時の値が不正です: ${raw}`
    );
  }

  const pad =
    number =>
      String(number)
        .padStart(2, '0');

  return (
    `${year}-` +
    `${pad(month)}-` +
    `${pad(day)} ` +
    `${pad(hour)}:` +
    `${pad(minute)}:` +
    `${pad(second)}`
  );
}

/* ============================================================
 * Rating specification
 * ============================================================ */

function parseSpec(
  specStr
) {
  const map = {};

  if (!specStr) {
    return map;
  }

  const tokens =
    specStr
      .split(/[,、\n]+/)
      .map(
        token =>
          token.trim()
      )
      .filter(Boolean);

  for (
    const token
    of tokens
  ) {
    const match =
      token.match(
        /^(\d+)(?:[-~〜](\d+))?\s+([A-Za-z_]+)$/
      );

    if (!match) {
      console.warn(
        `[警告] 書式を解釈できません: ${token}`
      );

      continue;
    }

    const start =
      Number(match[1]);

    const end =
      match[2]
        ? Number(match[2])
        : start;

    const keyword =
      match[3]
        .toUpperCase();

    for (
      let index = start;
      index <= end;
      index++
    ) {
      if (!map[index]) {
        map[index] = {};
      }

      if (
        ALLOWED_RATINGS.has(
          keyword
        )
      ) {
        map[index].rating =
          keyword;

        continue;
      }

      if (
        [
          'NO_THREADS',
          'NOTHREADS',
          'THREADS_NG',
        ].includes(keyword)
      ) {
        map[index].threads_allowed =
          false;

        continue;
      }

      if (
        [
          'THREADS',
          'THREADS_OK',
        ].includes(keyword)
      ) {
        map[index].threads_allowed =
          true;

        continue;
      }

      if (
        [
          'GALLERY',
          'GALLERY_OK',
          'SHOW_GALLERY',
        ].includes(keyword)
      ) {
        map[index].gallery_visible =
          true;

        continue;
      }

      if (
        [
          'NO_GALLERY',
          'HIDE_GALLERY',
        ].includes(keyword)
      ) {
        map[index].gallery_visible =
          false;

        continue;
      }

      console.warn(
        `[警告] 未知の指定: ${keyword}`
      );
    }
  }

  return map;
}

/* ============================================================
 * ファイル自然順
 * ============================================================ */

function naturalSort(
  a,
  b
) {
  return a.localeCompare(
    b,
    'ja',
    {
      numeric: true,
      sensitivity: 'base',
    }
  );
}

/* ============================================================
 * MIME
 * ============================================================ */

function getMimeType(
  filePath
) {
  const ext =
    path
      .extname(filePath)
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

  if (ext === '.gif') {
    return 'image/gif';
  }

  throw new Error(
    `未対応画像形式: ${ext}`
  );
}

/* ============================================================
 * JSON抽出
 * ============================================================ */

function extractJson(
  text
) {
  const cleaned =
    String(text)
      .trim()
      .replace(
        /^```json\s*/i,
        ''
      )
      .replace(
        /^```\s*/i,
        ''
      )
      .replace(
        /\s*```$/,
        ''
      )
      .trim();

  try {
    return JSON.parse(
      cleaned
    );
  } catch {
    const firstBrace =
      cleaned.indexOf('{');

    const lastBrace =
      cleaned.lastIndexOf('}');

    if (
      firstBrace !== -1 &&
      lastBrace !== -1 &&
      lastBrace > firstBrace
    ) {
      return JSON.parse(
        cleaned.slice(
          firstBrace,
          lastBrace + 1
        )
      );
    }

    throw new Error(
      `JSON解析失敗:\n${text}`
    );
  }
}

/* ============================================================
 * タグ整理
 * ============================================================ */

function cleanTags(
  tags
) {
  if (!Array.isArray(tags)) {
    return [];
  }

  return tags
    .map(
      tag =>
        String(tag).trim()
    )
    .filter(Boolean)
    .filter(
      (
        tag,
        index,
        array
      ) =>
        array.indexOf(tag)
        === index
    );
}

/* ============================================================
 * 画像解析対象を均等抽出
 * ============================================================ */

function selectAnalysisImages(
  imagePaths,
  maxImages
) {
  if (
    imagePaths.length
    <= maxImages
  ) {
    return imagePaths;
  }

  const selected =
    [];

  for (
    let index = 0;
    index < maxImages;
    index++
  ) {
    const selectedIndex =
      Math.round(
        index *
        (
          imagePaths.length - 1
        ) /
        (
          maxImages - 1
        )
      );

    selected.push(
      imagePaths[
      selectedIndex
      ]
    );
  }

  return [
    ...new Set(
      selected
    ),
  ];
}

/* ============================================================
 * Manifest生成
 * ============================================================ */

async function buildManifest(
  folderPath,
  title,
  model,
  specStr = '',
  publishAt = null,
  comment = '',
  includeGalleryCta = true
) {
  const absoluteFolder =
    path.resolve(
      folderPath
    );

  const entries =
    await fs.readdir(
      absoluteFolder
    );

  const files =
    entries
      .filter(file =>
        ALLOWED_EXTS.has(
          path
            .extname(file)
            .toLowerCase()
        )
      )
      .sort(naturalSort);

  if (
    files.length === 0
  ) {
    throw new Error(
      `画像がありません: ${absoluteFolder}`
    );
  }

  if (
    files.length > 120
  ) {
    throw new Error(
      `画像上限120枚を超えています: ${files.length}枚`
    );
  }

  const specMap =
    parseSpec(
      specStr
    );

  const images =
    [];

  const fileMap =
    {};

  for (
    let index = 0;
    index < files.length;
    index++
  ) {
    const file =
      files[index];

    const number =
      index + 1;

    const clientId =
      `img-${String(number).padStart(3, '0')}`;

    const spec =
      specMap[number] ||
      {};

    /*
     * 未指定はSAFEにしない。
     * REVIEWへ倒す。
     */
    const rating =
      spec.rating ||
      'REVIEW';

    const imageDef = {
      client_id:
        clientId,

      file_name:
        file,

      content_rating:
        rating,

      sort_order:
        number,
    };

    if (
      Object.prototype
        .hasOwnProperty
        .call(
          spec,
          'gallery_visible'
        )
    ) {
      imageDef.gallery_visible =
        spec.gallery_visible;
    }

    if (
      Object.prototype
        .hasOwnProperty
        .call(
          spec,
          'threads_allowed'
        )
    ) {
      imageDef.threads_allowed =
        spec.threads_allowed;
    }

    images.push(
      imageDef
    );

    fileMap[clientId] =
      path.join(
        absoluteFolder,
        file
      );
  }

  const now =
    new Date();

  const timestamp =
    now
      .toISOString()
      .replace(
        /[-:T]/g,
        ''
      )
      .slice(
        0,
        14
      );

  const random =
    crypto
      .randomBytes(4)
      .toString('hex');

  const clientRequestId =
    `miu-${timestamp}-${random}`;

  const artworkDef = {
    title,
    model,
    status:
      'publish',

    include_gallery_cta:
      includeGalleryCta,
  };

  if (publishAt) {
    artworkDef.publish_at =
      normalizeJstPublishAt(
        publishAt
      );
  }

  if (comment) {
    artworkDef.comment =
      comment;
  }

  const manifest = {
    mode:
      'validate',

    client_request_id:
      clientRequestId,

    artwork:
      artworkDef,

    images,
  };

  return {
    manifest,
    fileMap,
    absoluteFolder,
  };
}

/* ============================================================
 * Gemini
 *
 * 作品フォルダ全体を解析
 * ============================================================ */

async function generateArtworkTagsWithGemini(
  fileMap
) {
  if (!GEMINI_API_KEY) {
    throw new Error(
      'MIU_GEMINI_API_KEY / GEMINI_API_KEY がありません。'
    );
  }

  const imagePaths =
    Object
      .values(fileMap);

  const selectedImages =
    selectAnalysisImages(
      imagePaths,
      MAX_IMAGES_FOR_ANALYSIS
    );

  const imageParts =
    selectedImages.map(
      filePath => ({
        inline_data: {
          mime_type:
            getMimeType(
              filePath
            ),

          data:
            readFileSync(
              filePath
            )
              .toString(
                'base64'
              ),
        },
      })
    );

  const prompt = `
あなたはAI画像ギャラリーの作品整理担当です。

添付されている複数画像は、
すべて同じ1作品に含まれる画像です。

個々の画像ではなく、
作品全体を横断して確認し、
WordPressの親作品 artwork に付与する
検索・絞り込み用タグを生成してください。

【最重要ルール】

タグは「作品全体」を表します。

1枚だけに存在する特徴より、
複数画像に共通する特徴や
作品全体を代表する特徴を優先してください。

【カテゴリ】

scene_tags
- 季節
- 時間帯
- 場所
- 屋内 / 屋外
- 背景・シーン

fashion_tags
- 作品内で中心となる服装
- 帽子
- 靴
- アクセサリー
- ファッション小物

appearance_tags
- 髪色
- 髪型
- 髪の長さ
- 作品内で共通する外見特徴

expression_tags
- 笑顔
- ウインク
- 真顔
- 視線
- 代表的な表情

composition_tags
- 全身
- 上半身
- バストアップ
- 正面
- 横顔
- 立ち姿
- 座り
など代表的な構図

mood_tags
- 明るい
- クール
- 幻想的
- 落ち着いた
- かわいらしい
など作品全体の雰囲気

【ルール】

- 日本語
- 各カテゴリ0〜4個程度
- 全体8〜14個程度
- 画像から確認できる特徴だけ
- 人物名・モデル名は付けない
- 同義語を重複させない
- 他作品でも使いやすい粒度にする
- 商品説明のような細かすぎる表現は避ける

【Fashionの粒度】

「デニムミニスカート」
より
「ミニスカート」

「オフショルダーニット」
より
「ニット」

「柄タイツ」
より
「タイツ」

「赤いベレー帽」
より
「ベレー帽」

を優先してください。

【避けるタグ】

美しい
素敵
最高
魅力的
完璧
AI美女
AI画像

summaryには、
作品全体がどのような作品なのかを
客観的に1文で説明してください。
`.trim();

  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      GEMINI_TAG_MODEL
    )}:generateContent?key=${encodeURIComponent(
      GEMINI_API_KEY
    )}`;

  const response =
    await fetch(
      endpoint,
      {
        method:
          'POST',

        headers: {
          'Content-Type':
            'application/json',
        },

        body:
          JSON.stringify({
            contents: [
              {
                parts: [
                  ...imageParts,

                  {
                    text:
                      prompt,
                  },
                ],
              },
            ],

            generationConfig: {
              temperature:
                0.2,

              maxOutputTokens:
                1800,

              responseMimeType:
                'application/json',

              responseJsonSchema: {
                type:
                  'object',

                properties: {
                  summary: {
                    type:
                      'string',
                  },

                  scene_tags: {
                    type:
                      'array',

                    items: {
                      type:
                        'string',
                    },

                    maxItems:
                      4,
                  },

                  fashion_tags: {
                    type:
                      'array',

                    items: {
                      type:
                        'string',
                    },

                    maxItems:
                      4,
                  },

                  appearance_tags: {
                    type:
                      'array',

                    items: {
                      type:
                        'string',
                    },

                    maxItems:
                      4,
                  },

                  expression_tags: {
                    type:
                      'array',

                    items: {
                      type:
                        'string',
                    },

                    maxItems:
                      4,
                  },

                  composition_tags: {
                    type:
                      'array',

                    items: {
                      type:
                        'string',
                    },

                    maxItems:
                      4,
                  },

                  mood_tags: {
                    type:
                      'array',

                    items: {
                      type:
                        'string',
                    },

                    maxItems:
                      4,
                  },
                },

                required: [
                  'summary',
                  'scene_tags',
                  'fashion_tags',
                  'appearance_tags',
                  'expression_tags',
                  'composition_tags',
                  'mood_tags',
                ],
              },
            },
          }),

        signal:
          AbortSignal.timeout(
            180000
          ),
      }
    );

  const responseText =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `Gemini API ${response.status}: ${responseText.slice(0, 1500)}`
    );
  }

  const data =
    JSON.parse(
      responseText
    );

  const finishReason =
    data
      ?.candidates?.[0]
      ?.finishReason ||
    '';

  const generatedText =
    (
      data
        ?.candidates?.[0]
        ?.content?.parts ||
      []
    )
      .map(
        part =>
          part.text || ''
      )
      .join('\n')
      .trim();

  if (!generatedText) {
    throw new Error(
      'Geminiからタグ生成結果が返りませんでした。'
    );
  }

  const result =
    extractJson(
      generatedText
    );

  if (
    typeof result.summary
    !== 'string'
  ) {
    throw new Error(
      'Gemini結果にsummaryがありません。'
    );
  }

  const categories = {
    scene:
      cleanTags(
        result.scene_tags
      ),

    fashion:
      cleanTags(
        result.fashion_tags
      ),

    appearance:
      cleanTags(
        result.appearance_tags
      ),

    expression:
      cleanTags(
        result.expression_tags
      ),

    composition:
      cleanTags(
        result.composition_tags
      ),

    mood:
      cleanTags(
        result.mood_tags
      ),
  };

  const allTags =
    cleanTags([
      ...categories.scene,
      ...categories.fashion,
      ...categories.appearance,
      ...categories.expression,
      ...categories.composition,
      ...categories.mood,
    ]);

  if (
    allTags.length === 0
  ) {
    throw new Error(
      'Geminiタグが0件でした。'
    );
  }

  return {
    summary:
      result.summary.trim(),

    categories,

    allTags,

    analyzedImageCount:
      selectedImages.length,

    finishReason,
  };
}

/* ============================================================
 * Jev判定
 * ============================================================ */

async function judgeTagsWithJev(
  geminiResult
) {
  if (!JEV_API_KEY) {
    throw new Error(
      'JEV_API_KEY がありません。'
    );
  }

  const response =
    await fetch(
      'https://api.typesafe.ai/v1/systemone',
      {
        method:
          'POST',

        headers: {
          Authorization:
            `Bearer ${JEV_API_KEY}`,

          'Content-Type':
            'application/json',

          Accept:
            'application/json',
        },

        body:
          JSON.stringify({
            model:
              JEV_MODEL,

            state: {
              purpose:
                'AI作品ギャラリーの親作品artworkに付与する検索・絞り込み用タグの選定',

              summary:
                geminiResult.summary,

              categories:
                geminiResult.categories,

              all_tags:
                geminiResult.allTags,

              tag_policy: [
                '1枚単位ではなく作品全体を代表するタグであること',
                '複数画像に共通する特徴を優先する',
                '一部画像だけの特殊な特徴を過剰に採用しない',
                '作品横断検索に使いやすい粒度を優先する',
                '画像から確認できる特徴だけを採用する',
                'Fashionは商品説明ほど細かくしない',
                'ExpressionとAppearanceを混同しない',
                'CompositionとMoodを混同しない',
                '主観的すぎるタグを避ける',
                '重複タグを避ける',
                '人物名・モデル名を含めない',
              ],
            },

            questions: {
              decision: {
                type:
                  'choice',

                instructions:
                  'このタグ群を親作品artworkの検索・分類タグとして採用してよいか判断してください。',

                criteria: {
                  accept:
                    '作品全体を適切に表しており、そのまま自動採用してよい。',

                  review:
                    '利用可能だが、一部に改善余地がある。',

                  reject:
                    '作品全体を表すタグとして問題があり、再生成すべき。',
                },
              },

              overall_quality: {
                type:
                  'score',

                instructions:
                  '作品全体の検索・分類タグとしての品質を評価してください。',

                criteria: [
                  '低品質。作品タグとして不適切。',
                  '改善が必要。',
                  '十分実用的。',
                  '非常に具体的で実用的。',
                ],
              },

              category_separation: {
                type:
                  'score',

                instructions:
                  'Scene / Fashion / Appearance / Expression / Composition / Mood が適切に分類されているか評価してください。',

                criteria: [
                  '分類が混在している。',
                  '一部混在している。',
                  'ほぼ適切に分離されている。',
                  '非常に明確に分離されている。',
                ],
              },

              too_detailed: {
                type:
                  'noul',

                instructions:
                  '候補タグは細かすぎて、作品横断検索に使いにくくなっていますか？',

                criteria: {
                  true:
                    '細かすぎて他作品と共有しにくい。',

                  false:
                    '検索・分類に適した粒度になっている。',
                },
              },

              needs_human_review: {
                type:
                  'noul',

                instructions:
                  '明確な分類ミスや不自然なタグがあり、人間が確認すべきですか？',

                criteria: {
                  true:
                    '明確な問題があり、人間確認が必要。',

                  false:
                    '多少の改善余地があっても、自動利用して問題ない。',
                },
              },
            },
          }),

        signal:
          AbortSignal.timeout(
            60000
          ),
      }
    );

  const responseText =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `Jev API ${response.status}: ${responseText.slice(0, 1500)}`
    );
  }

  return JSON.parse(
    responseText
  );
}

/* ============================================================
 * Miu最終判定
 * ============================================================ */

function makeFinalAiDecision(
  jevResult
) {
  const answers =
    jevResult?.answers ||
    {};

  const decision =
    answers
      ?.decision
      ?.choice ||
    '';

  const overallQuality =
    Number(
      answers
        ?.overall_quality
        ?.score
    );

  const categorySeparation =
    Number(
      answers
        ?.category_separation
        ?.score
    );

  const tooDetailed =
    Number(
      answers
        ?.too_detailed
        ?.noul
    );

  const humanReview =
    Number(
      answers
        ?.needs_human_review
        ?.noul
    );

  if (
    decision === 'reject' ||
    (
      Number.isFinite(
        overallQuality
      ) &&
      overallQuality < 1.3
    ) ||
    (
      Number.isFinite(
        tooDetailed
      ) &&
      tooDetailed >= 0.7
    )
  ) {
    return {
      result:
        'REGENERATE',

      decision,
      overallQuality,
      categorySeparation,
      tooDetailed,
      humanReview,
    };
  }

  if (
    decision !== 'reject' &&

    Number.isFinite(
      overallQuality
    ) &&
    overallQuality >= 1.8 &&

    Number.isFinite(
      categorySeparation
    ) &&
    categorySeparation >= 2.0 &&

    Number.isFinite(
      tooDetailed
    ) &&
    tooDetailed < 0.45
  ) {
    return {
      result:
        'AUTO ACCEPT',

      decision,
      overallQuality,
      categorySeparation,
      tooDetailed,
      humanReview,
    };
  }

  return {
    result:
      'REVIEW',

    decision,
    overallQuality,
    categorySeparation,
    tooDetailed,
    humanReview,
  };
}

/* ============================================================
 * AI解析
 * ============================================================ */

async function analyzeArtworkWithAi(
  fileMap
) {
  console.log('');
  console.log(
    '========================================'
  );

  console.log(
    ' AIタグ解析'
  );

  console.log(
    '========================================'
  );

  const gemini =
    await generateArtworkTagsWithGemini(
      fileMap
    );

  console.log(
    `Gemini解析画像: ${gemini.analyzedImageCount}枚`
  );

  console.log('');
  console.log(
    `Scene: ${gemini.categories.scene.join(' / ') || 'なし'}`
  );

  console.log(
    `Fashion: ${gemini.categories.fashion.join(' / ') || 'なし'}`
  );

  console.log(
    `Appearance: ${gemini.categories.appearance.join(' / ') || 'なし'}`
  );

  console.log(
    `Expression: ${gemini.categories.expression.join(' / ') || 'なし'}`
  );

  console.log(
    `Composition: ${gemini.categories.composition.join(' / ') || 'なし'}`
  );

  console.log(
    `Mood: ${gemini.categories.mood.join(' / ') || 'なし'}`
  );

  const jev =
    await judgeTagsWithJev(
      gemini
    );

  const finalDecision =
    makeFinalAiDecision(
      jev
    );

  console.log('');
  console.log(
    '--- Jev ---'
  );

  console.log(
    `decision: ${finalDecision.decision}`
  );

  console.log(
    `overall: ${finalDecision.overallQuality}`
  );

  console.log(
    `separation: ${finalDecision.categorySeparation}`
  );

  console.log(
    `too detailed: ${Number.isFinite(finalDecision.tooDetailed)
      ? `${(finalDecision.tooDetailed * 100).toFixed(1)}%`
      : '-'
    }`
  );

  console.log(
    `human review: ${Number.isFinite(finalDecision.humanReview)
      ? `${(finalDecision.humanReview * 100).toFixed(1)}%`
      : '-'
    } ※参考値`
  );

  console.log(
    `AI最終判定: ${finalDecision.result}`
  );

  if (
    finalDecision.result
    === 'REGENERATE'
  ) {
    console.warn(
      '[AI警告] Jevが再生成推奨と判定しました。今回は判定結果を保存して処理を続行します。'
    );
  }

  return {
    ai_summary:
      gemini.summary,

    ai_tags: {
      scene:
        gemini.categories.scene,

      fashion:
        gemini.categories.fashion,

      appearance:
        gemini.categories.appearance,

      expression:
        gemini.categories.expression,

      composition:
        gemini.categories.composition,

      mood:
        gemini.categories.mood,
    },

    jev: {
      decision:
        finalDecision.decision,

      overall_quality:
        finalDecision.overallQuality,

      category_separation:
        finalDecision.categorySeparation,

      too_detailed:
        finalDecision.tooDetailed,

      human_review:
        finalDecision.humanReview,

      result:
        finalDecision.result,

      checked_at:
        new Date()
          .toISOString(),
    },
  };
}

/* ============================================================
 * WordPress API送信
 * ============================================================ */

async function sendRequest(
  manifest,
  fileMap = null,
  token = ''
) {
  if (!token) {
    throw new Error(
      'MIU_IMPORT_API_TOKEN が未設定です。'
    );
  }

  const headers = {
    Authorization:
      `Bearer ${token}`,
  };

  /*
   * Validate
   */
  if (
    manifest.mode ===
    'validate'
  ) {
    const body =
      new URLSearchParams();

    body.append(
      'manifest',
      JSON.stringify(
        manifest
      )
    );

    const response =
      await fetch(
        API_URL,
        {
          method:
            'POST',

          headers,

          body,

          signal:
            AbortSignal.timeout(
              60000
            ),
        }
      );

    const text =
      await response.text();

    let json;

    try {
      json =
        JSON.parse(
          text
        );
    } catch {
      json = {
        ok:
          false,

        raw:
          'レスポンスJSONパース失敗',

        raw_text:
          text.slice(
            0,
            1000
          ),
      };
    }

    return {
      status:
        response.status,

      data:
        json,
    };
  }

  /*
   * Commit
   */
  const form =
    new FormData();

  form.append(
    'manifest',
    JSON.stringify(
      manifest
    )
  );

  for (
    const [
      clientId,
      filePath,
    ]
    of Object.entries(
      fileMap || {}
    )
  ) {
    const buffer =
      await fs.readFile(
        filePath
      );

    const mime =
      getMimeType(
        filePath
      );

    const blob =
      new Blob(
        [
          buffer,
        ],
        {
          type:
            mime,
        }
      );

    form.append(
      `files[${clientId}]`,
      blob,
      path.basename(
        filePath
      )
    );
  }

  const response =
    await fetch(
      API_URL,
      {
        method:
          'POST',

        headers,

        body:
          form,

        signal:
          AbortSignal.timeout(
            600000
          ),
      }
    );

  const text =
    await response.text();

  let json;

  try {
    json =
      JSON.parse(
        text
      );
  } catch {
    json = {
      ok:
        false,

      raw:
        'レスポンスJSONパース失敗',

      raw_text:
        text.slice(
          0,
          1000
        ),
    };
  }

  return {
    status:
      response.status,

    data:
      json,
  };
}

/* ============================================================
 * 確認
 * ============================================================ */

function promptConfirm(
  question
) {
  const rl =
    readline
      .createInterface({
        input:
          process.stdin,

        output:
          process.stdout,
      });

  return new Promise(
    resolve => {
      rl.question(
        question,
        answer => {
          rl.close();

          resolve(
            answer
              .trim()
              .toLowerCase()
          );
        }
      );
    }
  );
}

/* ============================================================
 * Patreon Worker
 * ============================================================ */

function runPatreonWorkerOnce() {
  return new Promise(
    (
      resolve,
      reject
    ) => {
      const scriptPath =
        path.join(
          PATREON_WORKER_DIR,
          'patreon-worker.mjs'
        );

      if (
        !existsSync(
          scriptPath
        )
      ) {
        console.warn(
          `[Patreon連動] Workerが見つかりません: ${scriptPath}`
        );

        resolve('');
        return;
      }

      console.log('');
      console.log(
        `[Patreon連動] Workerを起動: ${scriptPath}`
      );

      const worker =
        spawn(
          process.execPath,
          [
            '--title=patreon-worker',
            scriptPath,
            '--once',
          ],
          {
            cwd:
              PATREON_WORKER_DIR,

            stdio:
              [
                'ignore',
                'pipe',
                'pipe',
              ],

            shell:
              false,
          }
        );

      let patreonPostUrl = '';
      const patreonUrlsByAudience = {};

      if (worker.stdout) {
        worker.stdout.on(
          'data',
          chunk => {
            process.stdout.write(chunk);

            const text =
              chunk.toString();

            // PATREON_JOB_RESULT: audience=xxx url=yyy を抽出
            const resultMatches = text.matchAll(/PATREON_JOB_RESULT:\s*audience=([^\s]+)\s+url=([^\s\r\n]+)/g);
            for (const rm of resultMatches) {
              const aud = rm[1];
              const u = rm[2];
              if (u && u !== 'https://www.patreon.com/posts') {
                patreonUrlsByAudience[aud] = u;
              }
            }

            // 一般的なPatreonの投稿URLを抽出 (例: https://www.patreon.com/posts/112345678, https://www.patreon.com/.../posts/.../edit)
            const match =
              text.match(
                /https:\/\/(?:www\.)?patreon\.com\/(?:[^\s\/]+\/)?posts\/[0-9a-zA-Z_-]+(?:\/edit)?/
              );

            if (match && !match[0].endsWith('/posts/new')) {
              patreonPostUrl = match[0];
            }
          }
        );
      }

      if (worker.stderr) {
        worker.stderr.on(
          'data',
          chunk => {
            process.stderr.write(chunk);
          }
        );
      }

      worker.on(
        'close',
        code => {
          if (code === 0) {
            console.log(
              '[Patreon連動] Worker正常終了'
            );

            resolve({
              defaultUrl: patreonPostUrl,
              byAudience: patreonUrlsByAudience,
            });

            return;
          }

          reject(
            new Error(
              `Patreon Workerが終了コード ${code} で終了しました。`
            )
          );
        }
      );

      worker.on(
        'error',
        error => {
          reject(
            new Error(
              `Patreon Worker起動失敗: ${error.message}`
            )
          );
        }
      );
    }
  );
}

/* ============================================================
 * 投稿完了後の整理処理（クリーンアップ＆【済】付与）
 * ============================================================ */

async function cleanupAndMarkCompleted(
  approvedFolderInput
) {
  const approvedDir =
    path.resolve(
      approvedFolderInput
    );

  console.log('');
  console.log(
    '========================================'
  );
  console.log(
    ' 5. 投稿完了後の整理処理'
  );
  console.log(
    '========================================'
  );

  let sourceFolder =
    null;
  let manifestData =
    null;

  const manifestJsonPath =
    path.join(
      approvedDir,
      'manifest.json'
    );

  if (
    existsSync(
      manifestJsonPath
    )
  ) {
    try {
      manifestData =
        JSON.parse(
          readFileSync(
            manifestJsonPath,
            'utf8'
          )
        );

      if (manifestData.source_folder) {
        sourceFolder =
          path.resolve(
            manifestData.source_folder
          );
      }
    } catch (e) {
      console.warn(
        `[整理] manifest.json の読み込みスキップ: ${e.message}`
      );
    }
  }

  /*
   * 1. artwork-review の削除
   */
  const approvedBaseDir =
    path.join(
      __dirname,
      'artwork-approved'
    );

  const reviewBaseDir =
    path.join(
      __dirname,
      'artwork-review'
    );

  const reviewCandidates = new Set();

  // (A) manifest.json に記録された review_folder
  if (manifestData?.review_folder) {
    reviewCandidates.add(path.resolve(manifestData.review_folder));
  }

  // (B) source_folder から推測 (例: artwork-inbox/05.美玖/花魁美玖ちゃん -> artwork-review/05.美玖/花魁美玖ちゃん)
  if (sourceFolder) {
    const inboxBaseDir = path.join(__dirname, 'artwork-inbox');
    if (sourceFolder.startsWith(inboxBaseDir)) {
      const relFromInbox = path.relative(inboxBaseDir, sourceFolder);
      reviewCandidates.add(path.join(reviewBaseDir, relFromInbox));
    }
  }

  // (C) approvedDir の相対パス (例: artwork-review/美玖/花魁美玖ちゃん)
  if (approvedDir.startsWith(approvedBaseDir)) {
    const relFromApproved = path.relative(approvedBaseDir, approvedDir);
    reviewCandidates.add(path.join(reviewBaseDir, relFromApproved));
  }

  // (D) テーマ名一致による探索 (例: artwork-review/*/花魁美玖ちゃん)
  const currentTheme = path.basename(approvedDir);
  if (existsSync(reviewBaseDir)) {
    try {
      const modelEntries = await fs.readdir(reviewBaseDir, { withFileTypes: true });
      for (const mEntry of modelEntries) {
        if (mEntry.isDirectory()) {
          const cand = path.join(reviewBaseDir, mEntry.name, currentTheme);
          if (existsSync(cand)) {
            reviewCandidates.add(cand);
          }
        }
      }
    } catch (e) {
      // ignore
    }
  }

  for (const reviewTargetDir of reviewCandidates) {
    if (existsSync(reviewTargetDir)) {
      try {
        await fs.rm(
          reviewTargetDir,
          {
            recursive: true,
            force: true,
          }
        );

        console.log(
          `[整理] artwork-review を削除しました: ${reviewTargetDir}`
        );

        try {
          const modelDir = path.dirname(reviewTargetDir);
          const remaining = await fs.readdir(modelDir);
          if (remaining.length === 0) {
            await fs.rmdir(modelDir);
          }
        } catch {}
      } catch (err) {
        console.warn(
          `[整理] artwork-review の削除失敗 (${reviewTargetDir}): ${err.message}`
        );
      }
    }
  }

  /*
   * 2. artwork-approved の削除
   */
  if (
    existsSync(
      approvedDir
    )
  ) {
    try {
      await fs.rm(
        approvedDir,
        {
          recursive: true,
          force: true,
        }
      );

      console.log(
        `[整理] artwork-approved を削除しました: ${approvedDir}`
      );

      try {
        const modelDir =
          path.dirname(
            approvedDir
          );

        const remaining =
          await fs.readdir(
            modelDir
          );

        if (
          remaining.length === 0
        ) {
          await fs.rmdir(
            modelDir
          );
        }
      } catch {}
    } catch (err) {
      console.warn(
        `[整理] artwork-approved の削除失敗: ${err.message}`
      );
    }
  }

  /*
   * 3. artwork-inbox フォルダ名に【済】を付与
   */
  if (
    sourceFolder &&
    existsSync(
      sourceFolder
    )
  ) {
    const parentDir =
      path.dirname(
        sourceFolder
      );

    const currentName =
      path.basename(
        sourceFolder
      );

    if (
      !currentName.startsWith(
        '【済】'
      )
    ) {
      const newName =
        `【済】${currentName}`;

      const newPath =
        path.join(
          parentDir,
          newName
        );

      try {
        await fs.rename(
          sourceFolder,
          newPath
        );

        console.log(
          `[整理] artwork-inbox フォルダ名を更新しました: ${currentName} -> ${newName}`
        );
      } catch (err) {
        console.warn(
          `[整理] artwork-inbox フォルダ名のリネーム失敗: ${err.message}`
        );
      }
    } else {
      console.log(
        `[整理] artwork-inbox フォルダは既に【済】が付いています: ${currentName}`
      );
    }
  }
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ============================================================
 * 6. 完了リンク表示 & 通知
 * ============================================================ */

async function displayAndSaveCompletionLinks({
  title,
  model,
  patreonWorkerResult,
  postizUrl,
  artworkId,
  editUrl,
}) {
  let defaultPatreonUrl = 'https://www.patreon.com/posts';
  let patreonUrlsByAudience = {};

  if (typeof patreonWorkerResult === 'string') {
    defaultPatreonUrl = patreonWorkerResult || 'https://www.patreon.com/posts';
  } else if (patreonWorkerResult && typeof patreonWorkerResult === 'object') {
    defaultPatreonUrl = patreonWorkerResult.defaultUrl || 'https://www.patreon.com/posts';
    patreonUrlsByAudience = patreonWorkerResult.byAudience || {};
  }

  const pzUrl =
    postizUrl ||
    'https://postiz.xx-ai-girls-miu.com';

  const publicUrl = patreonUrlsByAudience.public || defaultPatreonUrl;
  const freeMembersUrl = patreonUrlsByAudience.free_members || defaultPatreonUrl;
  const paidMembersUrl = patreonUrlsByAudience.paid_members || defaultPatreonUrl;

  console.log('');
  console.log('============================================================');
  console.log(' ★ 投稿完了！ 管理・投稿画面リンク');
  console.log('============================================================');
  console.log('');
  console.log('【Patreon 各投稿の編集・確認画面】');
  console.log(`  🌐 ① 一般向け:       ${publicUrl}`);
  console.log(`  🎁 ② 無料会員向け:   ${freeMembersUrl}`);
  console.log(`  🔒 ③ 会員限定:       ${paidMembersUrl}`);
  console.log('');
  console.log('【Patreon 投稿管理（全体一覧）】');
  console.log(`  https://www.patreon.com/posts`);
  console.log('');
  console.log('【Postiz 管理画面】');
  console.log(`  ${pzUrl}`);
  console.log('');
  if (editUrl) {
    console.log('【WordPress 編集画面】');
    console.log(`  ${editUrl}`);
    console.log('');
  }
  console.log('============================================================');
  console.log('');

  // 1. JSON保存（レビューサーバーや他ツールが状態検知できるようにする）
  const completionInfo = {
    timestamp: new Date().toISOString(),
    status: 'completed',
    title: title || '',
    model: model || '',
    artwork_id: artworkId || null,
    edit_url: editUrl || '',
    patreon_post_url: defaultPatreonUrl,
    patreon_urls: {
      public: publicUrl,
      free_members: freeMembersUrl,
      paid_members: paidMembersUrl,
      manager: 'https://www.patreon.com/posts',
    },
    postiz_url: pzUrl,
  };

  const completionJsonPath =
    path.join(
      __dirname,
      'post-completion.json'
    );

  try {
    await fs.writeFile(
      completionJsonPath,
      JSON.stringify(completionInfo, null, 2),
      'utf8'
    );
  } catch (err) {
    console.warn(`[WARN] post-completion.json の保存失敗: ${err.message}`);
  }

  // 2. 完了通知HTMLを生成
  const htmlPath =
    path.join(
      __dirname,
      'post-completed.html'
    );

  const htmlContent = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>投稿完了 - ${escapeHtml(title || '作品')}</title>
<style>
  :root {
    --bg: #0f172a;
    --card: #1e293b;
    --card-border: #334155;
    --text: #f8fafc;
    --text-muted: #94a3b8;
    --patreon: #ff424d;
    --postiz: #6366f1;
    --accent: #22c55e;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Hiragino Sans", "BIZ UDPGothic", Meiryo, sans-serif;
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 100vh;
    padding: 24px;
  }
  .card {
    background: var(--card);
    border: 1px solid var(--card-border);
    border-radius: 16px;
    padding: 36px 32px;
    max-width: 640px;
    width: 100%;
    box-shadow: 0 20px 40px rgba(0,0,0,0.5);
  }
  .header {
    text-align: center;
    margin-bottom: 24px;
  }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: rgba(34, 197, 94, 0.15);
    color: var(--accent);
    padding: 6px 14px;
    border-radius: 999px;
    font-size: 13px;
    font-weight: 700;
    margin-bottom: 12px;
    border: 1px solid rgba(34, 197, 94, 0.3);
  }
  h1 {
    font-size: 22px;
    font-weight: 800;
    margin-bottom: 8px;
  }
  .meta {
    font-size: 14px;
    color: var(--text-muted);
  }
  .patreon-summary {
    background: #0f172a;
    border: 1px solid #334155;
    border-radius: 10px;
    padding: 16px;
    margin: 20px 0;
  }
  .patreon-summary-title {
    font-size: 14px;
    font-weight: 700;
    color: #ff858d;
    margin-bottom: 12px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .tier-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .tier-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.06);
    padding: 10px 14px;
    border-radius: 8px;
  }
  .tier-tag {
    font-weight: 700;
    font-size: 13px;
    color: #f1f5f9;
  }
  .tier-desc {
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 2px;
  }
  .tier-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: linear-gradient(135deg, #ff424d 0%, #e0323c 100%);
    color: #fff;
    text-decoration: none;
    font-size: 12px;
    font-weight: 700;
    padding: 6px 12px;
    border-radius: 6px;
    transition: transform 0.15s, opacity 0.15s;
    white-space: nowrap;
  }
  .tier-btn:hover {
    transform: translateY(-1px);
    opacity: 0.9;
  }
  .notice-text {
    font-size: 11px;
    color: #94a3b8;
    margin-top: 12px;
    line-height: 1.4;
  }
  .links {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-bottom: 24px;
  }
  .btn-link {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 18px;
    border-radius: 12px;
    text-decoration: none;
    color: #fff;
    font-weight: 700;
    font-size: 14px;
    transition: transform 0.15s, filter 0.15s, box-shadow 0.15s;
    box-shadow: 0 4px 12px rgba(0,0,0,0.25);
  }
  .btn-link:hover {
    transform: translateY(-2px);
    filter: brightness(1.1);
    box-shadow: 0 8px 20px rgba(0,0,0,0.35);
  }
  .btn-patreon {
    background: rgba(255, 66, 77, 0.15);
    border: 1px solid rgba(255, 66, 77, 0.4);
    color: #ff858d;
  }
  .btn-postiz {
    background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%);
  }
  .btn-title-box {
    display: flex;
    align-items: center;
  }
  .btn-icon {
    font-size: 20px;
    margin-right: 12px;
  }
  .btn-arrow {
    font-size: 18px;
    opacity: 0.8;
  }
  .url-preview {
    font-size: 11px;
    opacity: 0.8;
    font-weight: 400;
    margin-top: 3px;
    word-break: break-all;
  }
  .wp-link-box {
    text-align: center;
    padding-top: 14px;
    border-top: 1px solid var(--card-border);
  }
  .wp-link-box a {
    color: #38bdf8;
    text-decoration: none;
    font-size: 13px;
  }
  .wp-link-box a:hover {
    text-decoration: underline;
  }
</style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="badge">✓ COMPLETE</div>
      <h1>投稿が完了しました！</h1>
      <div class="meta">作品: <strong>${escapeHtml(title || '無題')}</strong> / モデル: <strong>${escapeHtml(model || 'モデル')}</strong></div>
    </div>

    <div class="patreon-summary">
      <div class="patreon-summary-title">🧡 Patreon 登録完了内訳（全3投稿）</div>
      <div class="tier-list">
        <div class="tier-item">
          <div>
            <div class="tier-tag">🌐 ① 一般向け（Public）</div>
            <div class="tier-desc">誰でも閲覧可能</div>
          </div>
          <a href="${publicUrl}" target="_blank" rel="noopener noreferrer" class="tier-btn">
            投稿を確認・編集 ↗
          </a>
        </div>
        <div class="tier-item">
          <div>
            <div class="tier-tag">🎁 ② 無料会員向け（Free members）</div>
            <div class="tier-desc">無料メンバー以上</div>
          </div>
          <a href="${freeMembersUrl}" target="_blank" rel="noopener noreferrer" class="tier-btn">
            投稿を確認・編集 ↗
          </a>
        </div>
        <div class="tier-item">
          <div>
            <div class="tier-tag">🔒 ③ 会員向け（Paid members）</div>
            <div class="tier-desc">有料プラン加入者限定</div>
          </div>
          <a href="${paidMembersUrl}" target="_blank" rel="noopener noreferrer" class="tier-btn">
            投稿を確認・編集 ↗
          </a>
        </div>
      </div>
      <div class="notice-text">
        ※予約投稿のため、上記の「投稿を確認・編集」より各投稿の編集画面（/edit）を直接開くことができます。
      </div>
    </div>

    <div class="links">
      <a href="https://www.patreon.com/posts" target="_blank" rel="noopener noreferrer" class="btn-link btn-patreon">
        <div class="btn-title-box">
          <span class="btn-icon">📋</span>
          <div>
            <div>Patreon 投稿一覧画面（Scheduledタブ）を開く</div>
            <div class="url-preview">https://www.patreon.com/posts</div>
          </div>
        </div>
        <span class="btn-arrow">↗</span>
      </a>
      <a href="${pzUrl}" target="_blank" rel="noopener noreferrer" class="btn-link btn-postiz">
        <div class="btn-title-box">
          <span class="btn-icon">📱</span>
          <div>
            <div>Postiz 管理画面を開く</div>
            <div class="url-preview">${escapeHtml(pzUrl)}</div>
          </div>
        </div>
        <span class="btn-arrow">↗</span>
      </a>
    </div>
    ${editUrl ? `
    <div class="wp-link-box">
      <a href="${editUrl}" target="_blank" rel="noopener noreferrer">WordPress 編集画面はこちら ↗</a>
    </div>` : ''}
  </div>
</body>
</html>`;

  try {
    await fs.writeFile(htmlPath, htmlContent, 'utf8');
    spawn('cmd.exe', ['/c', 'start', '', htmlPath], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  } catch (err) {
    console.warn(`[WARN] post-completed.html の生成/起動失敗: ${err.message}`);
  }
}

/* ============================================================
 * メイン
 * ============================================================ */

async function run(
  folderPath,
  title,
  model,
  specStr = '',
  publishAt = null,
  comment = '',
  includeGalleryCta = true,
  autoConfirm = false,
  aiTagsEnabled = true,
  snsOptimizationEnabled = true,
  performanceGuidanceEnabled = true
) {
  if (!API_TOKEN) {
    throw new Error(
      'MIU_IMPORT_API_TOKEN が設定されていません。'
    );
  }

  console.log('');
  console.log(
    '========================================'
  );

  console.log(
    ' 1. manifest生成'
  );

  console.log(
    '========================================'
  );

  const {
    manifest,
    fileMap,
    absoluteFolder,
  } =
    await buildManifest(
      folderPath,
      title,
      model,
      specStr,
      publishAt,
      comment,
      includeGalleryCta
    );

  console.log(
    `対象フォルダ: ${absoluteFolder}`
  );

  console.log(
    `画像枚数: ${Object.keys(fileMap).length}枚`
  );

  console.log(
    `リクエストID: ${manifest.client_request_id}`
  );

  /*
   * AI解析
   */
  if (aiTagsEnabled) {
    try {
      const aiAnalysis =
        await analyzeArtworkWithAi(
          fileMap
        );

      manifest.artwork.ai_summary =
        aiAnalysis.ai_summary;

      manifest.artwork.ai_tags =
        aiAnalysis.ai_tags;

      manifest.artwork.jev =
        aiAnalysis.jev;

    } catch (error) {
      console.warn('');
      console.warn(
        '========================================'
      );

      console.warn(
        ' AIタグ解析失敗'
      );

      console.warn(
        '========================================'
      );

      console.warn(
        error?.message ||
        error
      );

      console.warn(
        'AIタグなしで既存の投稿フローを続行します。'
      );
    }
  } else {
    console.log('');
    console.log(
      '[AI] --no-ai-tags 指定のためAIタグ解析をスキップします。'
    );
  }

  /*
   * SNSキャプション設定
   * GeminiによるSNS別最適化は行わず、入力されたコメントを全SNS（Instagram, X, Threads, Bluesky）でそのまま使用します。
   */
  const trimmedComment = String(comment || '').trim();
  if (trimmedComment !== '') {
    manifest.artwork.sns_captions = {
      instagram: trimmedComment,
      x: trimmedComment,
      threads: trimmedComment,
      bluesky: trimmedComment,
    };

    console.log('');
    console.log('--- SNSキャプション確認（全SNS共通・入力コメントそのまま） ---');

    console.log('');
    console.log('[Instagram]');
    console.log(manifest.artwork.sns_captions.instagram);

    console.log('');
    console.log('[X]');
    console.log(manifest.artwork.sns_captions.x);

    console.log('');
    console.log('[Threads]');
    console.log(manifest.artwork.sns_captions.threads);

    console.log('');
    console.log('[Bluesky]');
    console.log(manifest.artwork.sns_captions.bluesky);
  } else {
    console.log('');
    console.log('[SNS] コメント未入力のためSNSキャプションは設定されません。');
  }

  /* ========================================================
   * Validate
   * ======================================================== */

  console.log('');
  console.log(
    '========================================'
  );

  console.log(
    ' 2. WordPress validate'
  );

  console.log(
    '========================================'
  );

  manifest.mode =
    'validate';

  const validateResponse =
    await sendRequest(
      manifest,
      null,
      API_TOKEN
    );

  if (
    !validateResponse.data?.ok
  ) {
    console.error(
      `[失敗] バリデーションエラー (Status: ${validateResponse.status})`
    );

    console.error(
      JSON.stringify(
        validateResponse.data,
        null,
        2
      )
    );

    throw new Error(
      'WordPress validateに失敗しました。'
    );
  }

  const preview =
    validateResponse.data
      .preview ||
    {};

  console.log('');
  console.log(
    '----- [登録プレビュー] -----'
  );

  console.log(
    `タイトル: ${preview.title}`
  );

  console.log(
    `モデル: ${preview.model}`
  );

  console.log(
    `ステータス: ${preview.status}`
  );

  console.log(
    `公開日時: ${preview.publish_at || '即時公開'}`
  );

  if (
    preview.publish_at_utc
  ) {
    console.log(
      `公開日時UTC: ${preview.publish_at_utc}`
    );
  }

  console.log(
    `コメント: ${preview.comment || '（定型文）'}`
  );

  console.log(
    `ギャラリー誘導: ${preview.include_gallery_cta}`
  );

  console.log(
    `画像: ${preview.image_count}枚`
  );

  console.log(
    'Ratings:',
    preview.ratings
  );

  console.log(
    'SNS:',
    preview.sns
  );

  console.log(
    'Patreon:',
    preview.patreon
  );

  /*
   * WordPressがAI情報を受け取ったか確認
   */
  if (
    preview.ai_analysis
      ?.enabled
  ) {
    const ai =
      preview.ai_analysis;

    console.log('');
    console.log(
      '--- AIタグ受取確認 ---'
    );

    console.log(
      `Scene: ${(ai.tags?.scene || []).join(' / ')}`
    );

    console.log(
      `Fashion: ${(ai.tags?.fashion || []).join(' / ')}`
    );

    console.log(
      `Appearance: ${(ai.tags?.appearance || []).join(' / ')}`
    );

    console.log(
      `Expression: ${(ai.tags?.expression || []).join(' / ')}`
    );

    console.log(
      `Composition: ${(ai.tags?.composition || []).join(' / ')}`
    );

    console.log(
      `Mood: ${(ai.tags?.mood || []).join(' / ')}`
    );

    console.log(
      `Jev: ${ai.jev?.decision || '-'} / ${ai.jev?.result || '-'}`
    );
  } else {
    console.log('');
    console.log(
      'AIタグ: なし'
    );
  }

  console.log(
    '----------------------------'
  );

  /*
   * dry-run
   */
  if (isDryRun) {
    console.log('');
    console.log(
      '[dry-run] validate完了。本登録は行いません。'
    );

    return;
  }

  /*
   * commit確認
   */
  if (!autoConfirm) {
    const answer =
      await promptConfirm(
        '\nこの内容でWordPressへ本登録しますか？ (y/N): '
      );

    if (answer !== 'y') {
      console.log(
        '[中止] 本登録をキャンセルしました。'
      );

      return;
    }
  } else {
    console.log(
      '[自動承認] --yes により本登録へ進みます。'
    );
  }

  /* ========================================================
   * Commit
   * ======================================================== */

  console.log('');
  console.log(
    '========================================'
  );

  console.log(
    ' 3. WordPress commit'
  );

  console.log(
    '========================================'
  );

  manifest.mode =
    'commit';

  const commitResponse =
    await sendRequest(
      manifest,
      fileMap,
      API_TOKEN
    );

  if (
    !commitResponse.data?.ok
  ) {
    console.error(
      `[失敗] 本登録エラー (Status: ${commitResponse.status})`
    );

    console.error(
      JSON.stringify(
        commitResponse.data,
        null,
        2
      )
    );

    throw new Error(
      'WordPress本登録に失敗しました。'
    );
  }

  const artwork =
    commitResponse.data
      .artwork ||
    {};

  console.log(
    '[成功] WordPress本登録完了'
  );

  console.log(
    `親作品ID: ${artwork.id}`
  );

  console.log(
    `ステータス: ${artwork.status}`
  );

  if (
    artwork.publish_at
  ) {
    console.log(
      `予約公開日時(JST): ${artwork.publish_at}`
    );
  }

  if (
    artwork.publish_at_utc
  ) {
    console.log(
      `予約公開日時(UTC): ${artwork.publish_at_utc}`
    );
  }

  console.log(
    '作成内訳:',
    commitResponse.data
      .created
  );

  console.log(
    `編集画面: ${artwork.edit_url}`
  );

  /*
   * AI保存確認
   */
  if (
    commitResponse.data
      ?.ai_analysis
      ?.saved
  ) {
    console.log('');
    console.log(
      `[AI] WordPress保存: OK`
    );

    console.log(
      `[AI] Jev result: ${commitResponse.data.ai_analysis.jev?.result || '-'}`
    );
  }

  /* ========================================================
   * Patreon Worker
   * ======================================================== */

  console.log('');
  console.log(
    '========================================'
  );

  console.log(
    ' 4. Patreon Worker'
  );

  console.log(
    '========================================'
  );

  const patreonWorkerResult =
    await runPatreonWorkerOnce();

  /* ========================================================
   * 投稿完了後の整理処理
   * ======================================================== */
  await cleanupAndMarkCompleted(
    absoluteFolder
  );

  /* ========================================================
   * 完了リンク表示 & 通知
   * ======================================================== */
  await displayAndSaveCompletionLinks({
    title,
    model,
    patreonWorkerResult,
    postizUrl:
      POSTIZ_BASE_URL,
    artworkId:
      artwork?.id,
    editUrl:
      artwork?.edit_url,
  });
}

/* ============================================================
 * コマンドライン
 * ============================================================ */

const rawArgs =
  process.argv.slice(2);

const autoConfirm =
  rawArgs.includes(
    '--yes'
  );

const includeGalleryCta =
  !rawArgs.includes(
    '--no-gallery-cta'
  );

const isDryRun =
  rawArgs.includes(
    '--dry-run'
  )
  ||
  rawArgs.includes(
    '--validate-only'
  );

const aiTagsEnabled =
  !rawArgs.includes(
    '--no-ai-tags'
  );

const snsOptimizationEnabled =
  !rawArgs.includes(
    '--no-sns-opt'
  );

const performanceGuidanceEnabled =
  !rawArgs.includes(
    '--no-performance-guidance'
  );

/*
 * comment
 */
let comment =
  '';

const commentArg =
  rawArgs.find(
    arg =>
      arg.startsWith(
        '--comment='
      )
  );

if (commentArg) {
  comment =
    commentArg
      .replace(
        /^--comment=/,
        ''
      )
      .replace(
        /^['"](.*)['"]$/,
        '$1'
      );
}

/*
 * -- で始まらない引数のみ
 */
const positionalArgs =
  rawArgs.filter(
    arg =>
      !arg.startsWith('--')
  );

if (
  positionalArgs.length < 3
) {
  console.log('');
  console.log(
    '【使用方法】'
  );

  console.log('');

  console.log(
    'node import_artwork.mjs <フォルダ> <タイトル> <モデル> [レーティング指定] [公開日時] [--comment="コメント"] [--no-gallery-cta] [--no-ai-tags] [--dry-run] [--yes]'
  );

  console.log('');

  console.log(
    '例:'
  );

  console.log(
    'node import_artwork.mjs "imports/美羽テスト" "秋の公園" "美羽" "1 SAFE, 2 MILD, 3 SENSITIVE, 4 EXPLICIT" "2026-09-28 20:00:00" --comment="秋の新作です" --no-gallery-cta --yes'
  );

  process.exit(1);
}

const [
  folder,
  title,
  model,
  spec,
  publishAt,
] =
  positionalArgs;

/* ============================================================
 * 起動
 * ============================================================ */

run(
  folder,
  title,
  model,
  spec || '',
  publishAt || null,
  comment,
  includeGalleryCta,
  autoConfirm,
  aiTagsEnabled,
  snsOptimizationEnabled,
  performanceGuidanceEnabled
)
  .then(() => {
    console.log('');
    console.log(
      '[完了] すべての処理が終了しました。'
    );

    process.exit(0);
  })
  .catch(error => {
    console.error('');
    console.error(
      '[実行エラー]'
    );

    console.error(
      error?.stack ||
      error?.message ||
      error
    );

    process.exit(1);
  });