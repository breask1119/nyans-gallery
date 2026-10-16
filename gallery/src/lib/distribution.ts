// src/lib/distribution.ts

/**
 * コンテンツレーティングの定義
 */
export type ContentRating =
  | 'safe'
  | 'mild'
  | 'sensitive'
  | 'explicit'
  | 'review'
  | string;

/**
 * Patreonの公開ティア
 */
export type PatreonTier = 'public' | 'free' | 'paid' | 'hold';

/**
 * 配信先判定結果インターフェース
 */
export interface DistributionTarget {
  instagram: boolean;
  threads: boolean;
  x: boolean;
  patreon: PatreonTier;
}

/**
 * 将来の例外オーバーライド用インターフェース
 */
export interface DistributionOverride {
  instagram?: boolean;
  threads?: boolean;
  x?: boolean;
  patreon?: PatreonTier;
}

/**
 * 配信プラットフォームの識別子
 */
export type DistributionPlatform =
  | 'instagram'
  | 'threads'
  | 'x'
  | 'patreon_public'
  | 'patreon_free'
  | 'patreon_paid';

/**
 * 各コンテンツレーティングに応じたベース配信ルール
 */
export const BASE_RULES: Record<string, DistributionTarget> = {
  safe: {
    instagram: true,
    threads: true,
    x: true,
    patreon: 'public',
  },
  mild: {
    instagram: true,
    threads: false,
    x: true,
    patreon: 'public',
  },
  sensitive: {
    instagram: false,
    threads: false,
    x: false,
    patreon: 'free',
  },
  explicit: {
    instagram: false,
    threads: false,
    x: false,
    patreon: 'paid',
  },
  review: {
    instagram: false,
    threads: false,
    x: false,
    patreon: 'hold',
  },
};

/**
 * 不明・未設定・安全側に倒すべきデフォルトルール (hold)
 */
export const DEFAULT_HOLD_RULE: DistributionTarget = {
  instagram: false,
  threads: false,
  x: false,
  patreon: 'hold',
};

/**
 * rating文字列を正規化（配列や未定義にも対応）
 */
export function normalizeRatingString(rating?: string | string[] | null): string {
  if (!rating) return '';
  if (Array.isArray(rating)) {
    return rating.length > 0 && typeof rating[0] === 'string'
      ? rating[0].trim().toLowerCase()
      : '';
  }
  return typeof rating === 'string' ? rating.trim().toLowerCase() : '';
}

/**
 * content_rating を基準に各SNS / Patreonへの投稿可否を判定します。
 * overrideが指定されている場合は個別ルールで上書きします。
 * 
 * 構造:
 * Base Rule -> Override -> Final Distribution
 * 
 * @param rating コンテンツレーティング (safe, mild, sensitive, explicit, review 等)
 * @param override 将来的な個別指定オーバーライド
 */
export function getDistributionByRating(
  rating?: string | string[] | null,
  override?: DistributionOverride | null
): DistributionTarget {
  const normalized = normalizeRatingString(rating);
  const baseRule = BASE_RULES[normalized] || DEFAULT_HOLD_RULE;

  if (!override) {
    return { ...baseRule };
  }

  return {
    instagram: override.instagram !== undefined ? override.instagram : baseRule.instagram,
    threads: override.threads !== undefined ? override.threads : baseRule.threads,
    x: override.x !== undefined ? override.x : baseRule.x,
    patreon: override.patreon !== undefined ? override.patreon : baseRule.patreon,
  };
}

/**
 * 画像オブジェクトの汎用型
 */
export interface ArtworkImageLike {
  id?: number | string;
  content_rating?: string | string[] | null;
  contentRating?: string | string[] | null;
  distribution_override?: DistributionOverride | null;
  distributionOverride?: DistributionOverride | null;
  [key: string]: any;
}

/**
 * 指定したプラットフォームに投稿可能な画像のみを抽出します。
 * gallery_visible（Webギャラリー表示用）は参照せず、配信ルール（およびoverride）のみで判定します。
 * 
 * @param images 画像オブジェクトの配列
 * @param platform 配信対象プラットフォーム
 */
export function getEligibleImagesForPlatform<T extends ArtworkImageLike>(
  images: T[],
  platform: DistributionPlatform
): T[] {
  if (!Array.isArray(images)) return [];

  return images.filter((img) => {
    const rawRating = img.content_rating ?? img.contentRating;
    const override = img.distribution_override ?? img.distributionOverride;
    const dist = getDistributionByRating(rawRating, override);

    switch (platform) {
      case 'instagram':
        return dist.instagram === true;

      case 'threads':
        return dist.threads === true;

      case 'x':
        return dist.x === true;

      case 'patreon_public':
        return dist.patreon === 'public';

      case 'patreon_free':
        // Patreonは階層型: public も free 会員が閲覧可能
        return dist.patreon === 'public' || dist.patreon === 'free';

      case 'patreon_paid':
        // Patreonは階層型: public, free, paid のすべてが paid 会員閲覧対象
        return (
          dist.patreon === 'public' ||
          dist.patreon === 'free' ||
          dist.patreon === 'paid'
        );

      default:
        return false;
    }
  });
}
