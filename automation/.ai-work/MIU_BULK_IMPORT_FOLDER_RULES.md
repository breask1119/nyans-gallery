# Miu's Gallery 画像フォルダ運用ルール

## 目的

AntigravityからWordPress一括登録APIを安定して使うため、ローカル画像フォルダの置き方・命名・並び順・rating指定方法を統一する。

このルールは、`MIU_BULK_IMPORT_API_SPEC.md` の一括登録APIを前提とする。

---

## 1. 基本単位

**1作品につき1フォルダ** とする。

例:

```text
imports/
├─ miu-after-school/
│  ├─ 001.png
│  ├─ 002.png
│  ├─ 003.png
│  └─ 004.png
└─ miu-night-dress/
   ├─ 001.png
   ├─ 002.png
   └─ 003.png
```

1フォルダ内に複数作品を混在させない。

---

## 2. フォルダ名

フォルダ名は、英数字・ハイフンを使った短い識別名を推奨する。

推奨:

```text
miu-after-school
miu-night-dress
miu-summer-2026
```

非推奨:

```text
放課後の美羽
新しい画像
test
untitled
```

フォルダ名はWordPressの作品タイトルそのものではなく、ローカル管理用の識別子として扱う。

作品タイトル・modelなどの正式情報は、Antigravityへの指示またはmanifestで指定する。

---

## 3. 画像ファイル名

画像ファイル名は **2桁ゼロ埋め連番**（必要に応じて3桁）を基本とする。

```text
01.png
02.png
03.png
...
09.png
10.png
11.png
```

`1.png / 2.png / 10.png` のような名前は使用しない。

理由:

- OSやツールによる並び順の差を避ける
- `sort_order` をファイル名順から安全に生成できる
- Patreon向けに画像枚数が増えても順番が崩れにくい

---

## 4. 並び順

指定がない場合、Antigravityは **ファイル名の昇順** をWordPress上の表示順として扱う。

```text
001.png → sort_order 1
002.png → sort_order 2
003.png → sort_order 3
```

画像の順番を変更したい場合は、WordPressへ登録する前にファイル名を変更する。

例:

```text
変更前
001.png
002.png
003.png

↓ 2枚目と3枚目を入れ替えたい

001.png
002.png ← 元003
003.png ← 元002
```

---

## 5. content_ratingの指定

正式値は以下のみ。

```text
SAFE
MILD
SENSITIVE
EXPLICIT
REVIEW
```

### 推奨運用

画像ファイル名にはratingを含めず、Antigravityへの指示でまとめて指定する。

例:

```text
このフォルダを登録。
タイトル: 放課後の美羽
モデル: 美羽
001〜004 SAFE
005〜007 MILD
008〜012 SENSITIVE
013〜015 EXPLICIT
```

Antigravityはこの指示からmanifestを生成する。

### 理由

`001_SAFE.png` のようにファイル名へratingを埋め込むと、後からratingを変更した際にファイル名変更も必要になるため、基本運用では採用しない。

必要になった場合のみ将来拡張する。

---

## 6. ratingが未確定の画像

判断に迷う画像は必ず `REVIEW` とする。

不明な画像をSAFEとして扱わない。

```text
判断できない
↓
REVIEW
↓
人が確認
↓
SAFE / MILD / SENSITIVE / EXPLICITへ確定
```

Antigravityがrating候補を提案することは可だが、未確認のままcommitしてはならない。

---

## 7. gallery_visible

指定がない場合はAPI側のデフォルトを使用する。

```text
SAFE      → true
MILD      → true
SENSITIVE → false
EXPLICIT  → false
REVIEW    → false
```

通常はAntigravity側で毎回指定する必要はない。

例外的に変更したい画像のみ明示指定する。

---

## 8. manifest.json

ユーザーが手作業で `manifest.json` を作ることは必須ではない。

基本運用:

```text
画像フォルダ
↓
Antigravityへタイトル/model/ratingを指示
↓
Antigravityがmanifest生成
↓
validate
↓
人が確認
↓
commit
```

デバッグや再現性確保のため、Antigravityが生成したmanifestを作品フォルダ内へ保存してもよい。

保存する場合:

```text
miu-after-school/
├─ 001.png
├─ 002.png
├─ 003.png
└─ manifest.json
```

ただし、Bearer TokenやAPIキーなどの秘密情報はmanifestへ絶対に保存しない。

---

## 9. manifestを保存する場合の例

```json
{
  "artwork": {
    "title": "放課後の美羽",
    "model": "美羽",
    "status": "draft"
  },
  "images": [
    {
      "file_name": "001.png",
      "content_rating": "SAFE"
    },
    {
      "file_name": "002.png",
      "content_rating": "MILD"
    },
    {
      "file_name": "003.png",
      "content_rating": "SENSITIVE"
    }
  ]
}
```

実際にAPIへ送る際は、Antigravityが `client_id`、`sort_order`、`gallery_visible`、`client_request_id` など必要項目を補完する。

---

## 10. 推奨フォルダ配置

プロジェクト配下に専用のimportフォルダを作る。

例:

```text
project-root/
├─ .ai-work/
│  ├─ README.md
│  ├─ MIU_BULK_IMPORT_API_SPEC.md
│  ├─ MIU_BULK_IMPORT_FOLDER_RULES.md
│  └─ MIU_BULK_IMPORT_START_PROMPT.md
│
└─ imports/
   ├─ miu-after-school/
   │  ├─ 001.png
   │  ├─ 002.png
   │  └─ 003.png
   │
   └─ miu-night-dress/
      ├─ 001.png
      ├─ 002.png
      └─ 003.png
```

`imports/` はGit管理対象外を推奨する。

必要に応じて `.gitignore` へ以下を追加する。

```gitignore
imports/
```

画像そのものをリポジトリへコミットしない。

---

## 11. 対応画像形式

基本:

```text
.jpg
.jpeg
.png
.webp
```

同一作品内で形式が混在していても構わない。

ただし、ファイル名の連番は重複させない。

```text
001.webp
002.png
003.jpg
```

は可。

---

## 12. 画像枚数

一括登録APIの初期上限は **1作品30枚** とする。

30枚を超える場合は、勝手に分割登録せずユーザーへ確認する。

1枚あたりの最大サイズはAPI仕様に従い20MBを初期値とする。

---

## 13. Antigravityが最初に確認する情報

フォルダを指定されたら、最低限以下を確認する。

```text
対象フォルダ
画像枚数
ファイル名の連番
作品タイトル
model
content_ratingの指定
```

`sort_order` は原則ファイル名順から生成する。

`gallery_visible` はAPIデフォルトを使用するため、通常は確認不要。

---

## 14. ユーザーへのvalidate前プレビュー

AntigravityはAPIへcommitする前に、少なくとも以下を表示する。

例:

```text
登録予定

作品: 放課後の美羽
モデル: 美羽
画像: 15枚

SAFE: 4
MILD: 3
SENSITIVE: 5
EXPLICIT: 3
REVIEW: 0

並び順: 001 → 015

通常ギャラリー表示: 7枚
Threads対象: 4枚
Instagram / X / Bluesky対象: 7枚
Patreon無料会員対象: 5枚
Patreon有料会員対象: 3枚
```

その後、`validate` APIの結果と一致することを確認する。

---

## 15. commit禁止条件

以下の場合はcommitしない。

```text
画像の連番が意図せず重複している
作品タイトルが未指定
modelが未指定または存在しない
ratingが未指定
ratingに不正値がある
REVIEW画像についてユーザー確認が必要
validateでエラー
画像枚数が上限超過
```

ユーザーの確認後に修正して再validateする。

---

## 16. 登録後のローカル画像

WordPressへのcommit成功後も、Antigravityはローカル画像を勝手に削除・移動・リネームしない。

削除やアーカイブはユーザーの明示指示がある場合のみ行う。

将来、登録済みフォルダを `imports-done/` へ移す運用を追加する場合も、別途ユーザー承認を得ること。

---

## 17. 典型的な利用方法

ユーザー:

```text
imports/miu-night-dress を登録したい。
タイトルは「夜を纏う美羽」
モデルは美羽。
001〜004 SAFE、005〜008 MILD、009〜014 SENSITIVE、015〜018 EXPLICIT。
```

Antigravity:

```text
18枚確認しました。
ファイル名は001〜018で連番です。

SAFE 4
MILD 4
SENSITIVE 6
EXPLICIT 4

この内容でvalidateします。
```

validate成功後、結果をユーザーへ提示し、承認後にcommitする。

---

## 18. 最重要ルール

```text
1作品 = 1フォルダ
画像 = 001からの3桁連番
並び順 = ファイル名順
rating = ファイル名ではなくmanifest/指示で管理
不明rating = REVIEW
validate → 人間確認 → commit
commit後も元画像を勝手に変更しない
```
