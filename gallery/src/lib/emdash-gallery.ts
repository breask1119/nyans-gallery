// gallery/src/lib/emdash-gallery.ts
import { getEmDashCollection } from "emdash";

/**
 * EmDashのメディアオブジェクト型
 */
export interface EmDashMediaValue {
  id?: string;
  provider?: string;
  filename?: string;
  src?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  alt?: string;
  previewUrl?: string;
  meta?: {
    storageKey?: string;
    caption?: string | null;
    blurhash?: string | null;
    dominantColor?: string | null;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * ギャラリー用画像アイテム型
 */
export interface GalleryImageItem {
  id: string;
  slug: string;
  title: string;
  image: string; // ブラウザ表示用URL
  sourceUrl: string; // 既存wp.ts互換用エイリアス
  sortOrder: number;
  galleryVisible: boolean;
  rawImage?: EmDashMediaValue | unknown;
}

/**
 * AIタグの6カテゴリ構造型
 */
export interface AiTagsCategories {
  scene: string[];
  behavior: string[];
  appearance: string[];
  expression: string[];
  composition: string[];
  mood: string[];
}

/**
 * ギャラリー用作品（Artwork）型
 */
export interface GalleryArtwork {
  id: string;
  databaseId: number;
  title: string;
  slug: string;
  catSlug: string;
  comment: string;
  promptData: string; // 既存wp.ts互換用エイリアス
  publishAt: string;
  date: string; // 既存wp.ts互換用エイリアス
  aiSummary: string;
  // 6カテゴリ構造（scene, behavior, appearance, expression, composition, mood）
  aiCategories: AiTagsCategories;
  // 全カテゴリ結合フラットタグ配列
  allTags: string[];
  // 既存UI互換用フラットタグ配列（allTagsと同じ内容）
  aiTags: string[];
  aiAnalysis: {
    summary: string;
    categories: AiTagsCategories;
    allTags: string[];
    sceneTags: string[];
    behaviorTags: string[];
    appearanceTags: string[];
    expressionTags: string[];
    compositionTags: string[];
    moodTags: string[];
    [key: string]: unknown;
  } | null;
  hasAiTags: boolean;
  hasArtworkImages: boolean;
  likeCount: number;
  guestComments: unknown[];
  coverImage: string;
  featuredImage: {
    node: {
      sourceUrl: string;
    };
  };
  // Gallery表示用画像（gallery_visible === true のみ、sort_order昇順）
  normalizedImages: GalleryImageItem[];
  photos: GalleryImageItem[]; // 既存index.astro互換用エイリアス
  // 全画像（非公開画像含む、sort_order昇順）
  allImages: GalleryImageItem[];
}

/**
 * ギャラリー用猫（Cat / Model）型
 */
export interface GalleryCatModel {
  id: string;
  slug: string;
  name: string;
  themeColor: string;
  memberColor: string; // 既存wp.ts互換用エイリアス
  profile: string;
  modelBio: string; // 既存wp.ts互換用エイリアス
  profileImage: string;
  avatar: string; // 既存index.astro互換用エイリアス
  modelAvatar: {
    node: {
      sourceUrl: string;
    };
  };
  sortOrder: number;
  artworks: {
    nodes: GalleryArtwork[];
  };
  works: GalleryArtwork[]; // 直接アクセス用エイリアス
}

/**
 * ギャラリー全体データ型
 */
export interface EmDashGalleryData {
  siteInfo: {
    title: string;
    description: string;
  };
  sliders: Array<{
    title: string;
    featuredImage: { node: { sourceUrl: string } };
    memberColor: string;
  }>;
  models: GalleryCatModel[];
  cats: GalleryCatModel[]; // modelsのエイリアス
  latestArtwork: GalleryArtwork | null;
  debugLog: {
    totalCats: number;
    totalArtworks: number;
    totalImages: number;
    fetchedAt: string;
    source: "emdash";
    error?: string;
  };
}

/**
 * EmDashのメディア値（オブジェクトまたは文字列）から、ブラウザで表示可能な画像URLを生成するヘルパー
 *
 * EmDash v1.3.1 の local storage 設定（baseUrl: "/_emdash/api/media/file"）および
 * meta.storageKey 形式に準拠しています。
 */
export function resolveEmDashMediaUrl(image: unknown): string {
  if (!image) return "";

  // 文字列の場合
  if (typeof image === "string") {
    const trimmed = image.trim();
    if (!trimmed) return "";

    // JSON文字列としてシリアライズされているケースのフォールバック
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmed);
        return resolveEmDashMediaUrl(parsed);
      } catch {
        // パース失敗時はそのまま処理継続
      }
    }

    // すでにURLまたは絶対パス
    if (/^(https?:|\/\/|\/)/i.test(trimmed)) {
      return trimmed;
    }

    return `/_emdash/api/media/file/${trimmed}`;
  }

  // オブジェクトの場合
  if (typeof image === "object" && image !== null) {
    const media = image as EmDashMediaValue;

    // 1. previewUrl が直接指定されている場合
    if (typeof media.previewUrl === "string" && media.previewUrl.trim() !== "") {
      return media.previewUrl.trim();
    }

    // 2. src プロパティがある場合
    if (typeof media.src === "string" && media.src.trim() !== "") {
      const src = media.src.trim();
      if (/^(https?:|\/\/|\/)/i.test(src)) {
        return src;
      }
      return `/_emdash/api/media/file/${src}`;
    }

    // 3. meta.storageKey がある場合（EmDash local storage の標準形式）
    if (typeof media.meta?.storageKey === "string" && media.meta.storageKey.trim() !== "") {
      return `/_emdash/api/media/file/${media.meta.storageKey.trim()}`;
    }

    // 4. filename または id をフォールバックとして使用
    if (typeof media.filename === "string" && media.filename.trim() !== "") {
      return `/_emdash/api/media/file/${media.filename.trim()}`;
    }
    if (typeof media.id === "string" && media.id.trim() !== "") {
      return `/_emdash/api/media/file/${media.id.trim()}`;
    }
  }

  return "";
}

/**
 * AIタグデータを6カテゴリ構造および全タグフラット配列へ正規化するヘルパー
 *
 * EmDashの ai_tags 設計：
 * {
 *   "scene": string[],
 *   "behavior": string[],
 *   "appearance": string[],
 *   "expression": string[],
 *   "composition": string[],
 *   "mood": string[]
 * }
 */
export function normalizeAiTagsData(rawTags: unknown): {
  categories: AiTagsCategories;
  allTags: string[];
} {
  const categories: AiTagsCategories = {
    scene: [],
    behavior: [],
    appearance: [],
    expression: [],
    composition: [],
    mood: [],
  };

  if (!rawTags) {
    return { categories, allTags: [] };
  }

  let data = rawTags;
  if (typeof data === "string") {
    const trimmed = data.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        data = JSON.parse(trimmed);
      } catch {
        // JSONパース失敗時はフォールバックへ
      }
    } else if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        data = JSON.parse(trimmed);
      } catch {
        // パース失敗時はフォールバックへ
      }
    } else {
      // 単純なカンマ区切り文字列の場合
      const tags = trimmed
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      categories.scene = tags;
      return { categories, allTags: tags };
    }
  }

  // 1. 6カテゴリを含むオブジェクト形式の場合
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    const toStrArr = (val: unknown): string[] => {
      if (Array.isArray(val)) return val.map((t) => String(t).trim()).filter(Boolean);
      if (typeof val === "string" && val.trim()) return [val.trim()];
      return [];
    };

    categories.scene = toStrArr(obj.scene);
    categories.behavior = toStrArr(obj.behavior);
    categories.appearance = toStrArr(obj.appearance);
    categories.expression = toStrArr(obj.expression);
    categories.composition = toStrArr(obj.composition);
    categories.mood = toStrArr(obj.mood);

    // tags プロパティもある場合のフォールバック
    if (Array.isArray(obj.tags) && categories.scene.length === 0) {
      categories.scene = toStrArr(obj.tags);
    }

    const allTags = [
      ...categories.scene,
      ...categories.behavior,
      ...categories.appearance,
      ...categories.expression,
      ...categories.composition,
      ...categories.mood,
    ];

    return { categories, allTags };
  }

  // 2. 単純な配列の場合
  if (Array.isArray(data)) {
    const tags = data.map((t) => String(t).trim()).filter(Boolean);
    categories.scene = tags;
    return { categories, allTags: tags };
  }

  return { categories, allTags: [] };
}

/**
 * 空のフォールバックギャラリーデータを生成する
 */
function createFallbackGalleryData(errorMessage?: string): EmDashGalleryData {
  return {
    siteInfo: {
      title: "にゃんずギャラリー",
      description: "我が家のにゃんずのギャラリーサイト",
    },
    sliders: [],
    models: [],
    cats: [],
    latestArtwork: null,
    debugLog: {
      totalCats: 0,
      totalArtworks: 0,
      totalImages: 0,
      fetchedAt: new Date().toISOString(),
      source: "emdash",
      error: errorMessage,
    },
  };
}

/**
 * EmDashからCats、Artworks、Artwork Imagesを取得し、
 * 既存Gallery UIへ渡せる正規化済みデータ構造を生成して返す
 */
export async function getEmDashGalleryData(): Promise<EmDashGalleryData> {
  try {
    const [
      { entries: rawCats = [] },
      { entries: rawArtworks = [] },
      { entries: rawArtworkImages = [] },
    ] = await Promise.all([
      getEmDashCollection("cats", { status: "published" }),
      getEmDashCollection("artworks", { status: "published" }),
      getEmDashCollection("artwork_images", { status: "published" }),
    ]);

    // -------------------------------------------------------------
    // 1. Artwork Images の整理・ソート・索引化
    // -------------------------------------------------------------
    const imagesByArtworkSlug = new Map<string, GalleryImageItem[]>();
    const visibleImagesByArtworkSlug = new Map<string, GalleryImageItem[]>();

    for (const rawImage of rawArtworkImages) {
      const data = rawImage.data as Record<string, unknown>;
      const artworkSlug = typeof data.artwork_slug === "string" ? data.artwork_slug.trim() : "";
      if (!artworkSlug) continue;

      const imgSlug = (rawImage.slug as string) || (rawImage.id as string) || "";
      const title = (typeof data.title === "string" && data.title) || (rawImage.title as string) || imgSlug;
      const imageUrl = resolveEmDashMediaUrl(data.image);
      const sortOrder = typeof data.sort_order === "number" ? data.sort_order : 999;
      const isVisible = data.gallery_visible === true || data.gallery_visible === 1;

      const imageItem: GalleryImageItem = {
        id: rawImage.id as string,
        slug: imgSlug,
        title,
        image: imageUrl,
        sourceUrl: imageUrl,
        sortOrder,
        galleryVisible: isVisible,
        rawImage: data.image,
      };

      // 全画像リストへ追加
      if (!imagesByArtworkSlug.has(artworkSlug)) {
        imagesByArtworkSlug.set(artworkSlug, []);
      }
      imagesByArtworkSlug.get(artworkSlug)!.push(imageItem);

      // Gallery表示用画像リストへ追加 (gallery_visible === true のみ)
      if (isVisible) {
        if (!visibleImagesByArtworkSlug.has(artworkSlug)) {
          visibleImagesByArtworkSlug.set(artworkSlug, []);
        }
        visibleImagesByArtworkSlug.get(artworkSlug)!.push(imageItem);
      }
    }

    // 各作品の画像を sort_order 昇順で並び替え
    const sortByOrder = (a: GalleryImageItem, b: GalleryImageItem) => a.sortOrder - b.sortOrder;
    for (const list of imagesByArtworkSlug.values()) {
      list.sort(sortByOrder);
    }
    for (const list of visibleImagesByArtworkSlug.values()) {
      list.sort(sortByOrder);
    }

    // -------------------------------------------------------------
    // 2. Artworks の整理・猫スラッグ別索引化
    // -------------------------------------------------------------
    const artworksByCatSlug = new Map<string, GalleryArtwork[]>();
    const allGalleryArtworks: GalleryArtwork[] = [];

    for (const rawArt of rawArtworks) {
      const data = rawArt.data as Record<string, unknown>;
      const catSlug = typeof data.cat_slug === "string" ? data.cat_slug.trim() : "";
      const artSlug = (rawArt.slug as string) || (data.slug as string) || (rawArt.id as string) || "";
      const title = (typeof data.title === "string" && data.title) || (rawArt.title as string) || artSlug;
      const comment = typeof data.comment === "string" ? data.comment : "";
      const publishAt = typeof data.publish_at === "string" ? data.publish_at : (rawArt.publishedAt ? new Date(rawArt.publishedAt).toISOString() : new Date().toISOString());
      const aiSummary = typeof data.ai_summary === "string" ? data.ai_summary : "";
      const { categories: aiCategories, allTags } = normalizeAiTagsData(data.ai_tags);

      // 当該作品の画像一覧を取得
      const allImages = imagesByArtworkSlug.get(artSlug) ?? [];
      const visibleImages = visibleImagesByArtworkSlug.get(artSlug) ?? [];

      // カバー画像決定（表示用画像の1枚目 -> 全画像の1枚目 -> 空文字）
      const coverImage = visibleImages[0]?.image || allImages[0]?.image || "";

      const galleryArt: GalleryArtwork = {
        id: (rawArt.id as string) || artSlug,
        databaseId: 0,
        title,
        slug: artSlug,
        catSlug,
        comment,
        promptData: comment,
        publishAt,
        date: publishAt,
        aiSummary,
        aiCategories,
        allTags,
        aiTags: allTags,
        aiAnalysis: aiSummary || allTags.length > 0 ? {
          summary: aiSummary,
          categories: aiCategories,
          allTags,
          sceneTags: aiCategories.scene,
          behaviorTags: aiCategories.behavior,
          appearanceTags: aiCategories.appearance,
          expressionTags: aiCategories.expression,
          compositionTags: aiCategories.composition,
          moodTags: aiCategories.mood,
        } : null,
        hasAiTags: allTags.length > 0,
        hasArtworkImages: allImages.length > 0,
        likeCount: 0,
        guestComments: [],
        coverImage,
        featuredImage: {
          node: {
            sourceUrl: coverImage,
          },
        },
        normalizedImages: visibleImages,
        photos: visibleImages,
        allImages,
      };

      allGalleryArtworks.push(galleryArt);

      if (catSlug) {
        if (!artworksByCatSlug.has(catSlug)) {
          artworksByCatSlug.set(catSlug, []);
        }
        artworksByCatSlug.get(catSlug)!.push(galleryArt);
      }
    }

    // 全作品・猫別作品を publish_at 降順（新しい順）で並び替え
    const sortByPublishDesc = (a: GalleryArtwork, b: GalleryArtwork) => {
      const timeA = new Date(a.publishAt).getTime() || 0;
      const timeB = new Date(b.publishAt).getTime() || 0;
      return timeB - timeA;
    };
    allGalleryArtworks.sort(sortByPublishDesc);
    for (const list of artworksByCatSlug.values()) {
      list.sort(sortByPublishDesc);
    }

    // -------------------------------------------------------------
    // 3. Cats (Models) の構築
    // -------------------------------------------------------------
    const models: GalleryCatModel[] = rawCats.map((rawCat) => {
      const data = rawCat.data as Record<string, unknown>;
      const catSlug = (rawCat.slug as string) || (data.slug as string) || (rawCat.id as string) || "";
      const name = (typeof data.name === "string" && data.name) || (rawCat.title as string) || catSlug;
      const themeColor = typeof data.theme_color === "string" && data.theme_color.trim() !== "" ? data.theme_color.trim() : "#F43F5E";
      const profile = typeof data.profile === "string" ? data.profile : "";
      const profileImageUrl = resolveEmDashMediaUrl(data.profile_image);
      const sortOrder = typeof data.sort_order === "number" ? data.sort_order : 999;

      const catArtworks = artworksByCatSlug.get(catSlug) ?? [];

      return {
        id: (rawCat.id as string) || catSlug,
        slug: catSlug,
        name,
        themeColor,
        memberColor: themeColor,
        profile,
        modelBio: profile,
        profileImage: profileImageUrl,
        avatar: profileImageUrl,
        modelAvatar: {
          node: {
            sourceUrl: profileImageUrl,
          },
        },
        sortOrder,
        artworks: {
          nodes: catArtworks,
        },
        works: catArtworks,
      };
    });

    // 猫を sort_order 昇順で並び替え
    models.sort((a, b) => a.sortOrder - b.sortOrder);

    // -------------------------------------------------------------
    // 4. 最新作品（latestArtwork）とスライダー（sliders）の生成
    // -------------------------------------------------------------
    const latestArtwork = allGalleryArtworks.length > 0 ? allGalleryArtworks[0] : null;

    // スライダーデータ：各猫の代表作品またはアバターから生成
    const sliders = models
      .map((cat) => {
        const firstWork = cat.works[0];
        const imageUrl = firstWork?.coverImage || cat.profileImage;
        if (!imageUrl) return null;

        return {
          title: firstWork?.title ? `${cat.name} - ${firstWork.title}` : cat.name,
          featuredImage: {
            node: {
              sourceUrl: imageUrl,
            },
          },
          memberColor: cat.themeColor,
        };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);

    return {
      siteInfo: {
        title: "にゃんずギャラリー",
        description: "我が家のにゃんずのギャラリーサイト",
      },
      sliders,
      models,
      cats: models,
      latestArtwork,
      debugLog: {
        totalCats: models.length,
        totalArtworks: allGalleryArtworks.length,
        totalImages: rawArtworkImages.length,
        fetchedAt: new Date().toISOString(),
        source: "emdash",
      },
    };
  } catch (error) {
    console.error("🚨 [emdash-gallery] Error fetching gallery data:", error);
    return createFallbackGalleryData(
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * 相対URLまたは絶対URLを、SITE_URLを前置した絶対URLへ正規化します。
 * OGP、Twitter Card、JSON-LDなどのメタデータで使用されます。
 */
export function toAbsoluteUrl(urlPath?: string | null, customBaseUrl?: string): string {
  if (!urlPath) return "";
  if (urlPath.startsWith("http://") || urlPath.startsWith("https://")) {
    return urlPath;
  }
  const base = (
    customBaseUrl ||
    (typeof process !== "undefined" && (process.env?.PUBLIC_SITE_URL || process.env?.SITE_URL)) ||
    (typeof import.meta !== "undefined" && (import.meta.env?.PUBLIC_SITE_URL || import.meta.env?.SITE_URL)) ||
    "https://nyans-gallery.local"
  ).replace(/\/+$/, "");

  const cleanPath = urlPath.startsWith("/") ? urlPath : `/${urlPath}`;
  return `${base}${cleanPath}`;
}
