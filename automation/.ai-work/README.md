# Miu Bulk Import API / `.ai-work`

このフォルダは、Miu's GalleryのWordPressへ複数画像を一括登録する仕組みをAntigravityで実装・保守するための指示書置き場です。

## ファイル

- `MIU_BULK_IMPORT_API_SPEC.md`：一括登録APIの正式仕様。仕様変更時はこのファイルを正とする。
- `MIU_BULK_IMPORT_START_PROMPT.md`：Antigravityへ新しいセッションで最初に渡す開始プロンプト。

Antigravityのチャットには基本的に以下だけ送れば開始できます。

```text
.ai-work/MIU_BULK_IMPORT_API_SPEC.md
と
.ai-work/MIU_BULK_IMPORT_START_PROMPT.md
を確認して、その内容に従って作業を開始してください。
```

## 既存構成

```text
artwork
└─ artwork_image × 複数
```

子画像で主に使用するフィールド:

```text
image
content_rating
parent_artwork
gallery_visible
sort_order
```

親側Relationship:

```text
art_image
```

taxonomy:

```text
model
```

## content_rating

正式値:

```text
SAFE
MILD
SENSITIVE
EXPLICIT
REVIEW
```

通常SNS:

```text
SAFE → Instagram / Threads / X / Bluesky
MILD → Instagram / X / Bluesky
SENSITIVE → 通常SNSへ送らない
EXPLICIT → 通常SNSへ送らない
REVIEW → 自動配信しない
```

Patreon:

```text
SAFE / MILD → public
SENSITIVE → free_members
EXPLICIT → paid_members
REVIEW → 自動配信しない
```

## 今回のAPIの役割

```text
画像フォルダ
↓
Antigravity
↓
validate
↓
人間確認
↓
commit
↓
WordPress登録
```

一括登録時にPostizやPatreon投稿を自動実行しないでください。SNS / Patreon投稿処理は既存の別フローで行います。

## 運用上の注意

- Git操作はユーザーの明示指示なしで行わない
- API Tokenをソースコードへ直接書かない
- `.env` や秘密情報をリポジトリへ保存しない
- 不明ratingをSAFE扱いしない
- modelを勝手に追加しない
- validateを飛ばしてcommitしない
- 既存CPT / Pods構造を勝手に変更しない

## 推奨フォルダ配置

```text
.ai-work/
├─ README.md
├─ MIU_BULK_IMPORT_API_SPEC.md
├─ MIU_BULK_IMPORT_FOLDER_RULES.md
└─ MIU_BULK_IMPORT_START_PROMPT.md
```
