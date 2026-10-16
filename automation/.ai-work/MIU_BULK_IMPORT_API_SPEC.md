# Miu's Gallery 一括登録API 実装指示書

## 目的

現在のWordPressギャラリーでは、親作品 `artwork` に対して子画像 `artwork_image` を複数登録しており、画像ごとに以下の情報入力が必要になっている。

```text
image
content_rating
parent_artwork
gallery_visible
sort_order
```

Patreon向け作品では登録枚数が多く、手作業の負担が大きいため、Antigravityから複数画像をまとめてWordPressへ登録できるREST APIを追加する。

既存のPods構成・既存のギャラリー表示・Postiz・Patreon Queueは変更せず、追加実装で対応すること。

---

## 1. 既存データ構成

### 親CPT

```text
post_type: artwork
```

主な要素:

```text
post_title
post_name
post_status
taxonomy: model
```

親 `artwork` には、子画像とのRelationshipフィールドが存在する。

```text
art_image
```

### 子CPT

現在の正式名称:

```text
post_type: artwork_image
```

ただし既存コードでは旧名称 `art_image` も存在する可能性があるため、参照処理では両方を許容すること。

子画像フィールド:

```text
image
content_rating
parent_artwork
gallery_visible
sort_order
```

---

## 2. 追加するREST API

```http
POST /wp-json/miu/v1/import-artwork
```

namespace:

```text
miu/v1
```

route:

```text
/import-artwork
```

---

## 3. 認証

専用Bearer Token方式とする。

`wp-config.php`:

```php
define('MIU_IMPORT_API_TOKEN', 'ランダムな十分長いトークン');
```

API呼び出し側:

```http
Authorization: Bearer TOKEN
```

Postiz APIキー、Gemini APIキー、Patreon Worker Tokenとは共用しない。

---

## 4. APIモード

```text
validate
commit
```

### validate

WordPressへの登録は一切行わない。manifestと画像を検証し、作品タイトル、model、画像枚数、rating内訳、gallery_visible枚数、SNS配信対象枚数、Patreon対象枚数を返す。

### commit

validateと同じ検証を行い、問題がなければ実際に登録する。

---

## 5. リクエスト形式

`multipart/form-data` とする。

```text
manifest
files
```

### manifest例

```json
{
  "mode": "validate",
  "client_request_id": "miu-20260925-001",
  "artwork": {
    "title": "放課後の美羽",
    "slug": "miu-after-school",
    "model": "美羽",
    "status": "draft"
  },
  "images": [
    {
      "client_id": "img-001",
      "file_name": "01.png",
      "content_rating": "SAFE",
      "sort_order": 1,
      "gallery_visible": true
    },
    {
      "client_id": "img-002",
      "file_name": "02.png",
      "content_rating": "MILD",
      "sort_order": 2,
      "gallery_visible": true
    },
    {
      "client_id": "img-003",
      "file_name": "03.png",
      "content_rating": "SENSITIVE",
      "sort_order": 3,
      "gallery_visible": false
    }
  ]
}
```

---

## 6. ファイル送信

manifest内の `client_id` とアップロードファイルを紐付ける。

```text
files[img-001]
files[img-002]
files[img-003]
```

必ず `client_id` ベースで対応付けること。ファイル名だけで紐付けない。

---

## 7. artwork登録仕様

commit時に `wp_insert_post()` で作成する。

```php
wp_insert_post([
    'post_type'   => 'artwork',
    'post_title'  => ...,
    'post_name'   => ...,
    'post_status' => ...,
]);
```

### title
必須。空ならvalidateエラー。

### slug
任意。未指定ならWordPressに生成させる。指定時は `sanitize_title()` を通す。

### status
許可値:

```text
draft
private
publish
```

未指定時は `draft`。初期運用でも `draft` 推奨。

---

## 8. model taxonomy

```text
model
```

manifest:

```json
"model": "美羽"
```

既存termのみ使用する。存在しない場合は `model_not_found`。自動term作成は行わない。

---

## 9. artwork_image登録仕様

各画像について以下を作成する。

```php
wp_insert_post([
    'post_type'   => 'artwork_image',
    'post_status' => 'publish',
    'post_title'  => ...,
]);
```

タイトルは `親タイトル + 連番` で自動生成可。

```text
放課後の美羽 01
放課後の美羽 02
```

---

## 10. 画像アップロード

WordPress Media Libraryへ登録する。WordPress標準処理を優先する。

```php
media_handle_sideload()
```

または

```php
wp_handle_sideload()
wp_insert_attachment()
wp_generate_attachment_metadata()
```

許可形式:

```text
jpg
jpeg
png
webp
```

必要であればgifも許容可。

---

## 11. imageフィールド

画像アップロード後のattachment IDを `image` フィールドへ保存する。

Pods APIが使える場合はPods経由を優先。

```php
$pod = pods('artwork_image', $child_id);
$pod->save('image', $attachment_id);
```

Pods APIで安定しない場合のみ `update_post_meta()` を使用する。

---

## 12. content_rating

許可値:

```text
SAFE
MILD
SENSITIVE
EXPLICIT
REVIEW
```

不正値は自動補正しない。入力受付前に `strtoupper(trim(...))` は可。最終保存値は上記5種類のみ。

---

## 13. gallery_visible

指定があればboolean値を保存。未指定の場合は以下を自動適用。

```text
SAFE      → true
MILD      → true
SENSITIVE → false
EXPLICIT  → false
REVIEW    → false
```

---

## 14. sort_order

manifestに指定されていればその整数値。未指定ならmanifest内の並び順で1から自動採番。

0以下は不可。重複がある場合はvalidateエラー。

---

## 15. parent_artwork

作成した親 `artwork` IDを全子画像へ保存する。

```text
parent_artwork
```

Pods Relationshipとして保存できる場合はPods経由を優先する。

---

## 16. 親側Relationship

全子画像作成完了後、親 `artwork` のRelationshipフィールド `art_image` へ子ID一覧を保存する。

順番は `sort_order` 順。

親→子、子→親の両方向を必ず設定する。

---

## 17. idempotency / 二重登録防止

manifest必須項目:

```text
client_request_id
```

例:

```text
miu-20260925-001
```

commit成功時、親 `artwork` に以下を保存。

```text
_miu_import_request_id
```

同一 `client_request_id` で再度commitされた場合、新規作成しない。

```json
{
  "ok": true,
  "duplicate": true,
  "artwork_id": 1301
}
```

---

## 18. validateレスポンス

```json
{
  "ok": true,
  "preview": {
    "title": "放課後の美羽",
    "model": "美羽",
    "status": "draft",
    "image_count": 5,
    "ratings": {
      "SAFE": 2,
      "MILD": 1,
      "SENSITIVE": 1,
      "EXPLICIT": 1,
      "REVIEW": 0
    },
    "gallery_visible": 3,
    "sns": {
      "instagram": 3,
      "x": 3,
      "bluesky": 3,
      "threads": 2
    },
    "patreon": {
      "public": 3,
      "free_members": 1,
      "paid_members": 1
    }
  }
}
```

SNSルール:

```text
SAFE      → Instagram / Threads / X / Bluesky
MILD      → Instagram / X / Bluesky
SENSITIVE → 通常SNSなし
EXPLICIT  → 通常SNSなし
REVIEW    → 通常SNSなし
```

Patreon参考集計:

```text
SAFE / MILD → public
SENSITIVE   → free_members
EXPLICIT    → paid_members
REVIEW      → なし
```

このAPIではPatreon投稿自体は実行しない。

---

## 19. commitレスポンス

```json
{
  "ok": true,
  "artwork": {
    "id": 1301,
    "title": "放課後の美羽",
    "status": "draft",
    "edit_url": "..."
  },
  "images": [
    {
      "client_id": "img-001",
      "id": 1302,
      "attachment_id": 1401,
      "rating": "SAFE",
      "gallery_visible": true,
      "sort_order": 1
    }
  ],
  "created": {
    "artwork": 1,
    "artwork_images": 5,
    "attachments": 5
  }
}
```

---

## 20. エラーレスポンス

```json
{
  "ok": false,
  "code": "invalid_content_rating",
  "message": "content_rating must be SAFE, MILD, SENSITIVE, EXPLICIT or REVIEW",
  "client_id": "img-003"
}
```

主なerror code:

```text
unauthorized
invalid_manifest
missing_title
model_not_found
missing_file
invalid_file_type
invalid_content_rating
duplicate_sort_order
upload_failed
artwork_create_failed
artwork_image_create_failed
relationship_save_failed
rollback_failed
```

---

## 21. ロールバック

commit途中で失敗した場合、途中まで登録したデータを残さない。

作成したIDを保持:

```text
artwork ID
artwork_image IDs
attachment IDs
```

失敗時の削除順:

```text
artwork_image削除
attachment削除
artwork削除
```

```php
wp_delete_post($id, true);
wp_delete_attachment($id, true);
```

ロールバック自体に失敗した場合は `rollback_failed` とし、残ったID一覧も返す。

---

## 22. Import中のSNS投稿禁止

一括登録APIのcommit中は、既存PostizやPatreon Queueを発火させない。

```php
if (!defined('MIU_IMPORT_RUNNING')) {
    define('MIU_IMPORT_RUNNING', true);
}
```

既存SNS処理側にも可能なら以下を追加。

```php
if (
    defined('MIU_IMPORT_RUNNING')
    && MIU_IMPORT_RUNNING
) {
    return;
}
```

一括登録APIは「登録だけ」を行い、SNS / Patreonへの実送信は別操作とする。

---

## 23. セキュリティ

必須:

```text
Bearer Token認証
HTTPS前提
wp-config.phpにToken保存
APIキーをPHPソースへ直書きしない
MIME検証
拡張子検証
最大枚数制限
最大ファイルサイズ制限
```

初期値案:

```text
最大画像数 30枚
1枚最大 20MB
```

---

## 24. ログ

親 `artwork` に以下を保存。

```text
_miu_import_request_id
_miu_import_created_at
_miu_import_source
```

```text
_miu_import_source = antigravity
```

必要なら `_miu_import_manifest` も保存可。ただし画像バイナリやBearer Tokenは保存しない。

---

## 25. Antigravity側の想定フロー

```text
1. ローカルフォルダ内の画像を取得
2. ファイル名順に並べる
3. ユーザー指定またはAG補助でcontent_rating候補を設定
4. manifest生成
5. mode=validateでAPI送信
6. previewをユーザーへ表示
7. ユーザー承認
8. mode=commitで同じmanifestを送信
9. WordPress登録結果を表示
```

---

## 26. AG側で勝手に実行しないこと

```text
content_ratingを推測して即commit
modelを勝手に新規作成
validateを飛ばしてcommit
SNS投稿チェックを勝手に入れる
既存artworkを勝手に上書き
WordPress既存CPT / Pods構成変更
既存Postizコードの大幅改修
既存Patreon Queueの大幅改修
```

必ず

```text
validate
↓
人が確認
↓
commit
```

とする。

---

## 27. content_rating自動判定

AGが画像を見てrating候補を提案する機能は将来的に追加可能。

ただし今回のAPI実装では、確定または確認済みの

```text
SAFE
MILD
SENSITIVE
EXPLICIT
REVIEW
```

を受け取って保存するところまで。

rating自動判定AIはAPI本体から分離する。

---

## 28. 実装場所

既存WordPressではCode Snippetsを使用しているため、初期実装はCode Snippetsで動かせる単独PHPとして作成する。

スニペット名案:

```text
Miu Artwork Bulk Import API
```

PHP開始タグ `<?php` は付けない。

---

## 29. 名前衝突防止

全関数名に `miu_import_` prefixを付ける。

```php
miu_import_auth()
miu_import_validate_manifest()
miu_import_upload_image()
miu_import_create_artwork()
miu_import_create_child()
miu_import_rollback()
miu_import_rest_handler()
```

既存の `miu_main_` / `miu_patreon_` 系関数と衝突させない。

---

## 30. 実装後のテスト

### TEST 1

```text
SAFE 2枚
```

期待:

```text
artwork 1
artwork_image 2
gallery_visible true ×2
```

### TEST 2

```text
SAFE 1
MILD 1
SENSITIVE 1
EXPLICIT 1
```

期待preview:

```text
Instagram 2
X 2
Bluesky 2
Threads 1

Patreon public 2
free_members 1
paid_members 1
```

### TEST 3

不正rating `NSFW`

期待:

```text
validate error
登録なし
```

### TEST 4

存在しないmodel。

期待:

```text
model_not_found
登録なし
```

### TEST 5

10枚中途中でアップロード失敗を発生させる。

期待:

```text
親
子
attachment
すべてロールバック
```

### TEST 6

同一 `client_request_id` で2回commit。

期待:

```text
2回目はduplicate
新規登録されない
```

---

## 完了条件

以下すべてを満たしたら実装完了。

```text
validate APIが動作
commit APIが動作
画像一括アップロード可能
artwork作成
artwork_image複数作成
parent_artwork設定
art_image Relationship設定
content_rating保存
gallery_visible保存
sort_order保存
model設定
二重登録防止
途中失敗時ロールバック
登録時SNS自動投稿なし
既存ギャラリーに影響なし
既存Postizに影響なし
既存Patreon Queueに影響なし
```
