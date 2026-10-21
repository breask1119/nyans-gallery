import fs from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

/* ============================================================
 * 基本設定
 * ============================================================ */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ============================================================
 * .env 読み込み (automation/.ai-work/.env または automation/.env)
 * ============================================================ */

function loadEnv() {
  const envPaths = [
    path.join(__dirname, '.env'),
    path.join(__dirname, '..', '.env'),
  ];

  for (const envPath of envPaths) {
    if (!existsSync(envPath)) continue;
    const envContent = readFileSync(envPath, 'utf-8');

    for (const line of envContent.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim().replace(/^['"](.*)['"]$/, '$1');

      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  }
}

loadEnv();

/* ============================================================
 * API設定
 * ============================================================ */

const API_URL = process.env.NYANS_IMPORT_API_URL || 'http://localhost:4321/api/nyans/import';
const API_TOKEN = process.env.NYANS_IMPORT_TOKEN || '';
const DEFAULT_CAT_SLUG = process.env.NYANS_CAT_SLUG || 'rin';
const IS_ENV_DRY_RUN = process.env.NYANS_IMPORT_DRY_RUN === '1' || process.env.NYANS_IMPORT_DRY_RUN === 'true';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.MIU_GEMINI_API_KEY || '';
const GEMINI_TAG_MODEL = process.env.MIU_GEMINI_TAG_MODEL || 'gemini-3.5-flash-lite';

const JEV_API_KEY = process.env.JEV_API_KEY || '';
const JEV_MODEL = process.env.JEV_MODEL || 'jev-latest';

const MAX_IMAGES_FOR_ANALYSIS = 6;
const ALLOWED_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

/* ============================================================
 * ユーティリティ
 * ============================================================ */

function naturalSort(a, b) {
  return a.localeCompare(b, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}

function selectAnalysisImages(imagePaths, maxCount = 6) {
  if (imagePaths.length <= maxCount) return [...imagePaths];
  const results = [];
  const total = imagePaths.length;
  for (let i = 0; i < maxCount; i++) {
    const idx = Math.floor((i * (total - 1)) / (maxCount - 1));
    results.push(imagePaths[idx]);
  }
  return results;
}

function promptConfirm(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

function normalizeJstPublishAt(input) {
  if (!input) return null;
  const str = String(input).trim();
  const match = str.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
  if (!match) {
    const parsed = new Date(str);
    return isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const [, y, m, d, hh = '0', mm = '0', ss = '0'] = match;
  const pad = n => String(n).padStart(2, '0');
  const isoLocal = `${y}-${pad(m)}-${pad(d)}T${pad(hh)}:${pad(mm)}:${pad(ss)}+09:00`;
  const dateObj = new Date(isoLocal);
  return isNaN(dateObj.getTime()) ? null : dateObj.toISOString();
}

/* ============================================================
 * Gemini 解析 (猫ギャラリー版: Summary & 6カテゴリTags)
 * ============================================================ */

async function generateArtworkTagsWithGemini(fileMap) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY / MIU_GEMINI_API_KEY が設定されていません。');
  }

  const imagePaths = Object.values(fileMap);
  const selectedImages = selectAnalysisImages(imagePaths, MAX_IMAGES_FOR_ANALYSIS);

  const imageParts = selectedImages.map(filePath => ({
    inline_data: {
      mime_type: getMimeType(filePath),
      data: readFileSync(filePath).toString('base64'),
    },
  }));

  const prompt = `
あなたは猫の写真ギャラリー「にゃんずギャラリー」の作品整理担当です。

添付されている複数画像は、すべて同じ1作品（同じ猫・同じシチュエーション）に含まれる画像です。
個々の画像ではなく、作品全体を横断して確認し、検索・絞り込み用タグを生成してください。

【最重要ルール】
タグは「作品全体」を表します。
1枚だけに存在する特徴より、複数画像に共通する特徴や作品全体を代表する特徴を優先してください。

【カテゴリ】
scene_tags
- 季節
- 時間帯
- 場所（室内 / リビング / 窓辺 / キャットタワー / 日向 / 庭など）
- 背景・シーン

behavior_tags
- 作品内で中心となる猫の仕草や行動（寝ている / 香箱座り / 毛づくろい / 遊んでいる / 歩く / 見上げる / 伸び / あくびなど）

appearance_tags
- 毛色・柄（黒猫 / 白猫 / キジトラ / 三毛 / ハチワレ / 茶トラ / サバトラなど）
- 毛の長さ（短毛 / 長毛）
- 瞳の色や作品内で共通する猫の外見特徴

expression_tags
- 表情（まったり / 眠そう / 好奇心旺盛 / 穏やか / 真剣 / リラックス / 警戒など）

composition_tags
- 全身 / バストアップ / 顔アップ / 正面 / 横顔 / 見下ろし / ローアングルなど代表的な構図

mood_tags
- ほのぼの / 癒やし / かわいい / クール / 温かい / 静かなど作品全体の雰囲気

【ルール】
- すべて日本語
- 各カテゴリ0〜4個程度
- 全体で8〜14個程度
- 画像から客観的に確認できる特徴だけ
- 猫の名前や固有名詞は含めない
- 同義語を重複させない（例:「室内」と「部屋の中」）
- 主観的・過剰な褒め言葉（「可愛いすぎる」「神」「最高」等）は避ける

summaryには、作品全体がどのような作品（シチュエーション・猫の様子）なのかを客観的に1文で説明してください。
`.trim();

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    GEMINI_TAG_MODEL
  )}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          parts: [...imageParts, { text: prompt }],
        },
      ],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 1800,
        responseMimeType: 'application/json',
        responseJsonSchema: {
          type: 'object',
          properties: {
            summary: { type: 'string' },
            scene_tags: { type: 'array', items: { type: 'string' }, maxItems: 4 },
            behavior_tags: { type: 'array', items: { type: 'string' }, maxItems: 4 },
            appearance_tags: { type: 'array', items: { type: 'string' }, maxItems: 4 },
            expression_tags: { type: 'array', items: { type: 'string' }, maxItems: 4 },
            composition_tags: { type: 'array', items: { type: 'string' }, maxItems: 4 },
            mood_tags: { type: 'array', items: { type: 'string' }, maxItems: 4 },
          },
          required: [
            'summary',
            'scene_tags',
            'behavior_tags',
            'appearance_tags',
            'expression_tags',
            'composition_tags',
            'mood_tags',
          ],
        },
      },
    }),
    signal: AbortSignal.timeout(180000),
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Gemini API エラー (${response.status}): ${responseText.slice(0, 1500)}`);
  }

  const data = JSON.parse(responseText);
  const generatedText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!generatedText) {
    throw new Error('Geminiから有効な応答テキストが得られませんでした。');
  }

  const parsed = JSON.parse(generatedText);

  return {
    summary: String(parsed.summary || '').trim(),
    categories: {
      scene: Array.isArray(parsed.scene_tags) ? parsed.scene_tags.map(t => String(t).trim()).filter(Boolean) : [],
      behavior: Array.isArray(parsed.behavior_tags) ? parsed.behavior_tags.map(t => String(t).trim()).filter(Boolean) : [],
      appearance: Array.isArray(parsed.appearance_tags) ? parsed.appearance_tags.map(t => String(t).trim()).filter(Boolean) : [],
      expression: Array.isArray(parsed.expression_tags) ? parsed.expression_tags.map(t => String(t).trim()).filter(Boolean) : [],
      composition: Array.isArray(parsed.composition_tags) ? parsed.composition_tags.map(t => String(t).trim()).filter(Boolean) : [],
      mood: Array.isArray(parsed.mood_tags) ? parsed.mood_tags.map(t => String(t).trim()).filter(Boolean) : [],
    },
    analyzedImageCount: selectedImages.length,
  };
}

/* ============================================================
 * Jev 判定 (Cat版 AI Tags 品質評価)
 * ============================================================ */

async function judgeTagsWithJev(geminiResult, mockMode = '') {
  if (mockMode === 'accept') {
    return {
      decision: 'accept',
      overall_quality: 90,
      category_separation: 90,
      too_detailed: false,
      human_review: false,
      notes: 'テスト用モック: accept',
    };
  }

  if (mockMode === 'review') {
    return {
      decision: 'review',
      overall_quality: 59,
      category_separation: 67,
      too_detailed: false,
      human_review: true,
      notes: 'テスト用モック: review',
    };
  }

  if (mockMode === 'reject') {
    return {
      decision: 'reject',
      overall_quality: 20,
      category_separation: 30,
      too_detailed: true,
      human_review: true,
      notes: 'テスト用モック: reject',
    };
  }

  if (!JEV_API_KEY) {
    throw new Error('JEV_API_KEY が設定されていません。');
  }

  const allTags = [
    ...geminiResult.categories.scene,
    ...geminiResult.categories.behavior,
    ...geminiResult.categories.appearance,
    ...geminiResult.categories.expression,
    ...geminiResult.categories.composition,
    ...geminiResult.categories.mood,
  ];

  const response = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${JEV_API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      model: JEV_MODEL,
      state: {
        purpose: '猫写真ギャラリー「にゃんずギャラリー」の作品に付与する検索・絞り込み用タグの選定',
        summary: geminiResult.summary,
        categories: geminiResult.categories,
        all_tags: allTags,
        tag_policy: [
          '1枚単位ではなく作品全体を代表するタグであること',
          '複数画像に共通する特徴を優先する',
          '猫の仕草(Behavior)と外見(Appearance)が適切に分離されていること',
          '主観的・過剰な表現がないこと',
          '作品横断検索に使いやすい粒度であること',
        ],
      },
      questions: {
        decision: {
          type: 'choice',
          instructions: 'このタグ群を親作品の検索・分類タグとして採用してよいか判断してください。',
          criteria: {
            accept: '作品全体を適切に表しており、そのまま自動採用してよい。',
            review: '利用可能だが、一部に改善余地がある。',
            reject: '作品全体を表すタグとして問題があり、再生成すべき。',
          },
        },
        overall_quality: {
          type: 'score',
          instructions: '作品全体の検索・分類タグとしての品質を評価してください。',
          criteria: [
            '低品質。作品タグとして不適切。',
            '改善が必要。',
            '十分実用的。',
            '非常に具体的で実用的。',
          ],
        },
        category_separation: {
          type: 'score',
          instructions: 'Scene / Behavior / Appearance / Expression / Composition / Mood が適切に分類されているか評価してください。',
          criteria: [
            '分類が混在している。',
            '一部混在している。',
            'ほぼ適切に分離されている。',
            '非常に明確に分離されている。',
          ],
        },
        too_detailed: {
          type: 'noul',
          instructions: '候補タグは細かすぎて、作品横断検索に使いにくくなっていますか？',
          criteria: {
            true: '細かすぎて他作品と共有しにくい。',
            false: '検索・分類に適した粒度になっている。',
          },
        },
        needs_human_review: {
          type: 'noul',
          instructions: '明確な分類ミスや不自然なタグがあり、人間が確認すべきですか？',
          criteria: {
            true: '明確な問題があり、人間確認が必要。',
            false: '自動利用して問題ない。',
          },
        },
      },
    }),
    signal: AbortSignal.timeout(60000),
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Jev API エラー (${response.status}): ${responseText.slice(0, 1500)}`);
  }

  const json = JSON.parse(responseText);
  const answers = json?.answers || {};

  const decision = answers?.decision?.choice || 'review';
  const overallQualityRaw = Number(answers?.overall_quality?.score ?? 3);
  const categorySeparationRaw = Number(answers?.category_separation?.score ?? 3);
  const tooDetailedNoul = Number(answers?.too_detailed?.noul ?? 0);
  const humanReviewNoul = Number(answers?.needs_human_review?.noul ?? 0);

  // 0-100 スケールへ正規化
  const overallQuality = Math.min(100, Math.max(0, Math.round(overallQualityRaw * 25)));
  const categorySeparation = Math.min(100, Math.max(0, Math.round(categorySeparationRaw * 25)));
  const tooDetailed = tooDetailedNoul >= 0.5;
  const humanReview = humanReviewNoul >= 0.5;

  return {
    decision,
    overall_quality: overallQuality,
    category_separation: categorySeparation,
    too_detailed: tooDetailed,
    human_review: humanReview,
    notes: '',
  };
}

/* ============================================================
 * EmDash Import API クライアント
 * ============================================================ */

async function sendImportRequest(metadata, fileMap, isDryRun) {
  if (!API_TOKEN) {
    throw new Error('NYANS_IMPORT_TOKEN が設定されていません。.env を確認してください。');
  }

  const headers = {
    Authorization: `Bearer ${API_TOKEN}`,
  };

  if (isDryRun) {
    headers['Content-Type'] = 'application/json';
    const response = await fetch(API_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(metadata),
      signal: AbortSignal.timeout(60000),
    });

    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { ok: false, error: 'PARSE_ERROR', raw: text.slice(0, 500) };
    }

    return { status: response.status, data: json };
  }

  const form = new FormData();
  form.append('metadata', JSON.stringify(metadata));

  for (const img of metadata.images) {
    const filePath = fileMap[img.filename];
    if (!filePath || !existsSync(filePath)) {
      throw new Error(`画像ファイルが見つかりません: ${img.filename}`);
    }

    const buffer = await fs.readFile(filePath);
    const mime = getMimeType(filePath);
    const blob = new Blob([buffer], { type: mime });

    form.append('files', blob, img.filename);
    form.append(img.filename, blob, img.filename);
  }

  const response = await fetch(API_URL, {
    method: 'POST',
    headers,
    body: form,
    signal: AbortSignal.timeout(600000),
  });

  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { ok: false, error: 'PARSE_ERROR', raw: text.slice(0, 500) };
  }

  return { status: response.status, data: json };
}

/* ============================================================
 * メイン実行フロー
 * ============================================================ */

async function run(options) {
  const {
    folderPath,
    customTitle,
    customCat,
    customComment,
    customPublishAt,
    isCliDryRun,
    autoConfirm,
    aiTagsEnabled,
    approveReview,
    mockJev,
    resetIds,
  } = options;

  const absoluteFolder = path.resolve(folderPath);
  if (!existsSync(absoluteFolder)) {
    throw new Error(`フォルダが存在しません: ${absoluteFolder}`);
  }

  console.log('');
  console.log('========================================');
  console.log(' にゃんずギャラリー Artwork Importer');
  console.log('========================================');

  // 1. 既存 manifest.json の読み込み
  let manifestJson = null;
  const manifestPath = path.join(absoluteFolder, 'manifest.json');
  if (existsSync(manifestPath)) {
    try {
      manifestJson = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      console.log(`[情報] 既存の manifest.json を読み込みました。`);
    } catch (e) {
      console.warn(`[警告] manifest.json の読み込みに失敗しました: ${e.message}`);
    }
  }

  // 2. 猫スラッグの決定 (優先度: manifest.cat_slug -> --cat -> manifest.model -> CLI引数 -> NYANS_CAT_SLUG)
  const catSlug =
    manifestJson?.cat_slug ||
    customCat ||
    manifestJson?.model ||
    DEFAULT_CAT_SLUG;

  // 3. タイトル・コメント・日時の決定 (優先度: manifest.title -> manifest.theme -> CLI引数 -> フォルダ名)
  const title =
    manifestJson?.title ||
    manifestJson?.theme ||
    customTitle ||
    path.basename(absoluteFolder);

  const comment = (customComment !== undefined && customComment !== null && customComment !== '')
    ? customComment
    : (manifestJson?.comment || '');
  const publishAtRaw = customPublishAt || manifestJson?.publish_at || null;
  const publishAtIso = normalizeJstPublishAt(publishAtRaw);

  // 4. 画像ファイルの一覧取得
  const entries = await fs.readdir(absoluteFolder);
  const imageFiles = entries
    .filter(file => ALLOWED_EXTS.has(path.extname(file).toLowerCase()))
    .sort(naturalSort);

  if (imageFiles.length === 0) {
    throw new Error(`画像ファイルが見つかりません: ${absoluteFolder}`);
  }

  // manifest内の画像メタデータマップ (filename -> imageMeta)
  const manifestImgMap = new Map();
  if (Array.isArray(manifestJson?.images)) {
    for (const mImg of manifestJson.images) {
      const key = mImg.filename || mImg.new_file;
      if (key) {
        manifestImgMap.set(key, mImg);
      }
    }
  }

  const fileMap = {};
  const imagesMeta = [];
  for (let i = 0; i < imageFiles.length; i++) {
    const filename = imageFiles[i];
    fileMap[filename] = path.join(absoluteFolder, filename);

    const mImg = manifestImgMap.get(filename);
    const galleryVisible = mImg && mImg.gallery_visible !== undefined
      ? Boolean(mImg.gallery_visible)
      : true;

    imagesMeta.push({
      filename,
      sort_order: (mImg && mImg.sort_order) || i + 1,
      gallery_visible: galleryVisible,
    });
  }

  // sort_order 順にソート
  imagesMeta.sort((a, b) => a.sort_order - b.sort_order);

  // 5. 冪等性キー (request_id, artwork_slug) の決定・保持
  const idRecordPath = path.join(absoluteFolder, '.nyans-import.json');
  let requestId = '';
  let artworkSlug = '';

  if (!resetIds && existsSync(idRecordPath)) {
    try {
      const savedIds = JSON.parse(readFileSync(idRecordPath, 'utf-8'));
      if (savedIds.request_id && savedIds.artwork_slug) {
        requestId = savedIds.request_id;
        artworkSlug = savedIds.artwork_slug;
        console.log(`[冪等性] 既存の登録IDを再利用します: ${requestId}`);
      }
    } catch {}
  }

  if (!requestId || !artworkSlug) {
    const now = new Date();
    const dateStr = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const rand = crypto.randomBytes(3).toString('hex');
    requestId = `nyans_${dateStr}_${rand}`;
    artworkSlug = `${catSlug}-${dateStr.slice(0, 8)}-${rand}`;

    try {
      await fs.writeFile(
        idRecordPath,
        JSON.stringify({ request_id: requestId, artwork_slug: artworkSlug, created_at: now.toISOString() }, null, 2),
        'utf-8'
      );
    } catch {}
  }

  // 6. 実行モード (dry-run か実登録か)
  const isDryRun = isCliDryRun || IS_ENV_DRY_RUN;

  console.log(`[モード] ${isDryRun ? 'DRY RUN (テスト検証モード - DB変更なし)' : 'REAL IMPORT (実登録モード)'}`);
  console.log(`[Cat] ${catSlug}`);
  console.log(`[Artwork Slug] ${artworkSlug}`);
  console.log(`[Request ID] ${requestId}`);
  console.log(`[タイトル] ${title}`);
  console.log(`[画像枚数] ${imagesMeta.length}枚`);
  if (comment) console.log(`[コメント] ${comment}`);
  if (publishAtIso) console.log(`[公開日時] ${publishAtIso}`);

  // 7. AI 解析 (Gemini + Jev)
  let aiSummary = '';
  let aiTags = {
    scene: [],
    behavior: [],
    appearance: [],
    expression: [],
    composition: [],
    mood: [],
  };
  let jevResult = {
    decision: 'accept',
    overall_quality: 90,
    category_separation: 90,
    too_detailed: false,
    human_review: false,
    notes: 'デフォルト値',
  };

  if (aiTagsEnabled) {
    console.log('');
    console.log('--- 1. Gemini AI タグ・サマリー解析 ---');
    const gemini = await generateArtworkTagsWithGemini(fileMap);
    aiSummary = gemini.summary;
    aiTags = gemini.categories;

    console.log(`[Summary] ${aiSummary}`);
    console.log(`[Scene] ${aiTags.scene.join(' / ') || 'なし'}`);
    console.log(`[Behavior] ${aiTags.behavior.join(' / ') || 'なし'}`);
    console.log(`[Appearance] ${aiTags.appearance.join(' / ') || 'なし'}`);
    console.log(`[Expression] ${aiTags.expression.join(' / ') || 'なし'}`);
    console.log(`[Composition] ${aiTags.composition.join(' / ') || 'なし'}`);
    console.log(`[Mood] ${aiTags.mood.join(' / ') || 'なし'}`);

    console.log('');
    console.log('--- 2. Jev 品質評価 ---');
    jevResult = await judgeTagsWithJev(gemini, mockJev);
    console.log(`[Jev 判定] decision: ${jevResult.decision}`);
    console.log(`[Jev 品質] overall: ${jevResult.overall_quality}/100, separation: ${jevResult.category_separation}/100`);
    console.log(`[Jev 詳細度] too_detailed: ${jevResult.too_detailed}, human_review: ${jevResult.human_review}`);
  } else {
    console.log('[AI] --no-ai-tags 指定のためAIタグ解析をスキップします。');
    aiSummary = `${title}のギャラリー作品`;
  }

  // ============================================================
  // Jev 品質ゲート判定
  // ============================================================
  const isReject = jevResult.decision === 'reject';
  const isReview = (jevResult.decision === 'review' || jevResult.human_review === true) && !isReject;
  const isAccept = jevResult.decision === 'accept' && jevResult.human_review === false;

  // 1. reject の場合: 必ず停止（--approve-review でも登録不可）
  if (isReject) {
    console.error('');
    console.error('========================================');
    console.error('[NYANS] Jev判定：不合格');
    console.error('この作品は自動登録できません。');
    console.error(`品質スコア: ${jevResult.overall_quality}`);
    console.error(`カテゴリ分離: ${jevResult.category_separation}`);
    console.error('========================================');
    throw new Error('JEV_REJECTED: Jev判定が不合格のためインポートを停止しました。');
  }

  // 2. review の場合
  if (isReview) {
    if (isDryRun) {
      console.log('');
      console.log('========================================');
      console.log('[NYANS] Jev判定は REVIEW です。');
      console.log('DRY RUNのためAPI検証のみ実施します。');
      console.log('実登録は許可されません。');
      console.log('========================================');
    } else if (approveReview) {
      console.log('');
      console.log('========================================');
      console.log('[NYANS] Jev判定は REVIEW ですが、--approve-review が指定されたため明示的な人間承認として実登録を続行します。');
      console.log(`品質スコア: ${jevResult.overall_quality}`);
      console.log(`カテゴリ分離: ${jevResult.category_separation}`);
      console.log('========================================');
    } else {
      console.log('');
      console.log('========================================');
      console.log('[NYANS] Jev判定：要確認');
      console.log(`品質スコア: ${jevResult.overall_quality}`);
      console.log(`カテゴリ分離: ${jevResult.category_separation}`);
      console.log('');
      console.log('人間による確認が必要なため、');
      console.log('EmDashへの実登録を停止しました。');
      console.log('========================================');
      return { stopped: true, reason: 'REVIEW_REQUIRES_HUMAN_APPROVAL' };
    }
  }

  // 3. accept の場合
  if (isAccept) {
    console.log('');
    console.log('========================================');
    console.log('[NYANS] Jev判定：合格 (ACCEPT)');
    console.log(`品質スコア: ${jevResult.overall_quality}`);
    console.log(`カテゴリ分離: ${jevResult.category_separation}`);
    console.log('通常通り処理を続行します。');
    console.log('========================================');
  }

  // 8. Payload 構築
  const metadata = {
    dry_run: isDryRun,
    request_id: requestId,
    cat_slug: catSlug,
    artwork: {
      slug: artworkSlug,
      title: title,
      comment: comment,
      publish_at: publishAtIso,
      ai_summary: aiSummary,
      ai_tags: aiTags,
      jev_result: {
        decision: jevResult.decision,
        overall_quality: jevResult.overall_quality,
        category_separation: jevResult.category_separation,
        too_detailed: jevResult.too_detailed,
        human_review: jevResult.human_review,
        notes: jevResult.notes || '',
      },
      instagram_caption: comment,
      instagram_publish_at: publishAtIso,
    },
    images: imagesMeta,
  };

  // 9. API 送信確認
  if (!isDryRun && !autoConfirm) {
    const answer = await promptConfirm('\nこの内容で EmDash へ本登録しますか？ (y/N): ');
    if (answer !== 'y') {
      console.log('[中止] 実登録をキャンセルしました。');
      return { stopped: true, reason: 'USER_CANCELLED' };
    }
  }

  // 10. API 送信
  console.log('');
  console.log(`--- 3. EmDash Import API 送信 (${isDryRun ? 'dry-run' : '実登録'}) ---`);
  console.log(`エンドポイント: ${API_URL}`);

  const res = await sendImportRequest(metadata, fileMap, isDryRun);

  // 11. エラーハンドリング
  if (res.status === 401) {
    console.error('🚨 [エラー 401] Nyans Import Token を確認してください。認証に失敗しました。');
    throw new Error('UNAUTHORIZED');
  } else if (res.status === 409) {
    if (res.data?.error === 'DUPLICATE_REQUEST') {
      console.error('🚨 [重複エラー 409] このバッチはすでに登録済みです (DUPLICATE_REQUEST)。');
      console.error(`  request_id: ${requestId}`);
    } else if (res.data?.error === 'DUPLICATE_SLUG') {
      console.error('🚨 [重複エラー 409] 同じArtwork slugがすでに存在します (DUPLICATE_SLUG)。');
      console.error(`  artwork_slug: ${artworkSlug}`);
    } else {
      console.error(`🚨 [競合エラー 409] ${res.data?.message || 'リソースが重複しています。'}`);
    }
    throw new Error(`CONFLICT: ${res.data?.error || 'DUPLICATE'}`);
  } else if (res.status === 422) {
    console.error(`🚨 [エラー 422] Cat slug「${catSlug}」がEmDashに存在しません。`);
    throw new Error('CAT_NOT_FOUND');
  } else if (res.status === 400) {
    console.error(`🚨 [バリデーションエラー 400] 送信データを確認してください。`);
    console.error(JSON.stringify(res.data, null, 2));
    throw new Error('VALIDATION_ERROR');
  } else if (res.status >= 500) {
    console.error(`🚨 [サーバーエラー ${res.status}] EmDash登録中にエラーが発生しました。`);
    console.error(JSON.stringify(res.data, null, 2));
    throw new Error('IMPORT_FAILED');
  } else if (!res.data?.ok) {
    console.error(`🚨 [予期せぬエラー ${res.status}]`, res.data);
    throw new Error('IMPORT_ERROR');
  }

  // 12. 成功結果表示
  if (isDryRun) {
    console.log('');
    console.log('✅ [NYANS] DRY RUN 成功！');
    console.log(`  request_id: ${res.data.request_id}`);
    console.log(`  validated: Cat=${res.data.validated?.cat_slug}, Slug=${res.data.validated?.artwork_slug}, Images=${res.data.validated?.images}`);
    console.log(`  would_create: Artwork=${res.data.would_create?.artwork}, ArtworkImages=${res.data.would_create?.artwork_images}`);
    console.log('  ※ DB・ファイルへの変更は一切行われていません。');
  } else {
    console.log('');
    console.log('🎉 [NYANS] 実登録 完了！');
    console.log(`  Status: 201 Created`);
    console.log(`  Artwork ID: ${res.data.created?.artwork?.id}`);
    console.log(`  Artwork Slug: ${res.data.created?.artwork?.slug}`);
    console.log(`  登録画像数: ${res.data.created?.images?.length}枚`);
  }

  return { success: true, dry_run: isDryRun, request_id: requestId, artwork_slug: artworkSlug };
}

/* ============================================================
 * コマンドライン引数パース & 起動
 * ============================================================ */

const rawArgs = process.argv.slice(2);

const isCliDryRun = rawArgs.includes('--dry-run') || rawArgs.includes('--validate-only');
const autoConfirm = rawArgs.includes('--yes');
const aiTagsEnabled = !rawArgs.includes('--no-ai-tags');
const approveReview = rawArgs.includes('--approve-review');
const resetIds = rawArgs.includes('--new-id');

let customComment = '';
const commentArg = rawArgs.find(arg => arg.startsWith('--comment='));
if (commentArg) {
  customComment = commentArg.replace(/^--comment=/, '').replace(/^['"](.*)['"]$/, '$1');
}

let customCat = '';
const catArg = rawArgs.find(arg => arg.startsWith('--cat='));
if (catArg) {
  customCat = catArg.replace(/^--cat=/, '').replace(/^['"](.*)['"]$/, '$1');
}

const mockJevArg = rawArgs.find(arg => arg.startsWith('--mock-jev='));
const mockJev = mockJevArg
  ? mockJevArg.replace(/^--mock-jev=/, '').trim().toLowerCase()
  : (process.env.NYANS_TEST_MOCK_JEV || '');

const positionalArgs = rawArgs.filter(arg => !arg.startsWith('--'));

if (positionalArgs.length < 1) {
  console.log('');
  console.log('【使用方法】');
  console.log('node import_artwork.mjs <フォルダ> [タイトル] [猫スラッグ] [レーティング(互換用)] [公開日時] [--comment="コメント"] [--cat=rin] [--approve-review] [--dry-run] [--yes]');
  console.log('');
  console.log('例:');
  console.log('node import_artwork.mjs "imports/凛テスト" "日向ぼっこの凛" "rin" --comment="日向ぼっこ中" --dry-run');
  process.exit(1);
}

const [folder, title, model, spec, publishAt] = positionalArgs;

run({
  folderPath: folder,
  customTitle: title,
  customCat: customCat || (model && !model.includes(' ') ? model : ''),
  customComment: customComment,
  customPublishAt: publishAt,
  isCliDryRun,
  autoConfirm,
  aiTagsEnabled,
  approveReview,
  mockJev,
  resetIds,
})
  .then((result) => {
    console.log('');
    if (result?.stopped) {
      console.log(`[停止] 処理が安全に停止しました (${result.reason})。`);
    } else {
      console.log('[完了] にゃんずギャラリー インポート処理が完了しました。');
    }
    process.exit(0);
  })
  .catch(error => {
    console.error('');
    console.error('[処理失敗]');
    console.error(error?.message || error);
    process.exit(1);
  });
