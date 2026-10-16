# Antigravity 開始プロンプト

以下のファイルを先に確認してください。

- `.ai-work/MIU_BULK_IMPORT_API_SPEC.md`
- `.ai-work/MIU_BULK_IMPORT_FOLDER_RULES.md`
- `.ai-work/README.md`

上記「Miu's Gallery 一括登録API実装指示書」と画像フォルダ運用ルールに従って実装してください。

既存のWordPress / Pods構成は変更せず、追加実装のみで対応してください。

今回の目的は、Antigravityから複数画像をまとめて `artwork + artwork_image` として登録できるREST APIを追加することです。

## 作業開始前の確認事項

最初に必ず既存のCPT・Podsフィールド・taxonomy構成を確認してください。

確認対象:

```text
artwork
artwork_image
旧 art_image の残存有無
artwork側 Relationship: art_image
artwork_image側:
  image
  content_rating
  parent_artwork
  gallery_visible
  sort_order
taxonomy: model
```

現在の実装と指示書に差異がある場合、勝手に変更せず先に報告してください。

## 重要ルール

- Git関連操作は行わない
- 既存CPT / Pods構成を変更しない
- 既存ギャラリー表示を壊さない
- 既存Postiz処理を大幅改修しない
- 既存Patreon Queueを大幅改修しない
- APIキーやTokenをコードへ直書きしない
- SAFE / MILD / SENSITIVE / EXPLICIT / REVIEWを厳格に扱う
- 不明ratingをSAFEへフォールバックしない
- `validate → 人間確認 → commit` の順を崩さない
- commit中にPostiz / Patreon投稿を発火させない
- `client_request_id` で二重登録を防止する
- 途中エラー時に可能な限り完全ロールバックする

## 実装形式

初期実装はWordPressのCode Snippetsへ貼り付け可能な単独PHPコードとして作成してください。

スニペット名:

```text
Miu Artwork Bulk Import API
```

PHP開始タグ `<?php` は不要です。

全関数名は `miu_import_` prefixを付け、既存関数との衝突を防いでください。

## 作業の進め方

1. 現在のCPT / Pods構成を確認
2. 指示書との差分を報告
3. 実装方針を短く提示
4. API実装
5. validateテスト
6. commitテスト
7. relationship確認
8. ロールバック確認
9. 二重登録防止確認
10. 既存ギャラリー / Postiz / Patreon Queueへの影響確認

## 実装後に提示するもの

- Code Snippetsへ貼れるPHPコード全文
- `wp-config.php` に追加する設定例
- validate用テストコマンド
- commit用テストコマンド
- 成功レスポンス例
- エラー時レスポンス例
- テスト結果
- 変更した箇所
- 既存機能への影響有無

PowerShell環境で試せる例も提示してください。

## 注意

content_ratingのAI自動判定は今回の実装範囲外です。

今回はあくまで、確定または確認済みの

```text
SAFE
MILD
SENSITIVE
EXPLICIT
REVIEW
```

を受け取り、安全に一括登録できるAPIを作るところまでとしてください。
