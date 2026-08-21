# RingiFlow

[![CI](https://github.com/INOUE-ajiado/RingiFlow/actions/workflows/ci.yml/badge.svg)](https://github.com/INOUE-ajiado/RingiFlow/actions/workflows/ci.yml)

社員IDを起点に「システム担当 → プロデューサー → 代表」の順で進む、直線ルート型の稟議書承認フローシステム。

## 技術スタック

| レイヤ | 技術 |
| --- | --- |
| フロントエンド | Angular v16+ (Standalone Components) / Firebase Hosting |
| バックエンドAPI | Go / Cloud Run |
| データストア | Cloud Firestore |
| 認証 | Firebase Authentication |

## 設計方針

- **すべてのデータアクセスはGoバックエンド経由**。Firestore セキュリティルールで読み書きともに全面禁止し、承認ステータスの更新は Firestore トランザクションで厳密に行う。
- **通知機能（メール等）は現フェーズ要件外**。コアとなる承認トランザクションと UI 実装を優先し、次以降のイテレーションで検討する。

## 承認フロー

```
(新規作成) --申請--> pending_system --承認--> pending_producer --承認--> pending_ceo --承認--> approved
                     |                      |                     |
                     +----- 差し戻し --------+------ 差し戻し ------+--> returned --再申請--> pending_system
                     |                      |                     |
                     +------- 却下 ----------+-------- 却下 -------+--> rejected (終端)
```

- **差し戻し (`returned`)** … 申請者が修正して**再申請可能**。再申請時は `pending_system` からやり直す
- **却下 (`rejected`)** … 終端ステータス。**再申請不可**
- 各承認者は自身の担当ステータスで「承認 / 差し戻し / 却下」の3アクションを実行できる
- **取り下げ (`withdrawn`)** … 申請者本人が決裁確定前にいつでも撤回できる終端ステータス
- **金額による分岐** … 10万円未満はプロデューサー承認で決裁完了（代表を経由しない）。閾値は `GET /api/v1/config` が配る
- 状態遷移表に定義のない遷移は Go API がすべて HTTP 409 で拒否する

| ロール | 説明 |
| --- | --- |
| `applicant` | 申請者 |
| `system_admin` | システム担当 |
| `producer` | プロデューサー |
| `ceo` | 代表 |
| `master` | **テスト運用専用**。全工程を単独で操作できる（下記参照） |

## Firebase プロジェクト

| 項目 | 値 |
| --- | --- |
| プロジェクトID | `ringiflow-81f8d` |
| ウェブアプリ | `RingiFlow Web` |
| Firestore | `(default)` / Native / **asia-northeast1** |
| 添付ストレージ | `ringiflow-81f8d-attachments` / **asia-northeast1** |
| Authentication | メール/パスワード |
| Hosting サイト | `ringiflow-81f8d` |

### 認証（現状はテスト運用モード）

本システムは当面スタンドアロンで運用し、**認証・権限は最終的に統合先システムから受け取る**方針。それまではシステムの骨格構築を優先し、以下の暫定措置をとっている。

- **ログイン画面は設けていない。** 起動すると `master` ロールのマスターユーザーで自動ログインし、すぐ稟議一覧が表示される
- **マスターロールは全工程を単独で操作できる。** 申請から最終決裁まで一人で通せるため、承認フローの検証が可能
- **状態遷移表そのものは迂回しない。** 終端ステータスへの操作や未定義の遷移は `master` でも409で拒否され、差し戻し・却下のコメント必須も適用される
- **統合時の戻し方**: `master` ロールの付与をやめ、`AuthService` の自動ログインを実際の認証へ差し替えるだけで通常の権限制御に戻る

> ⚠️ マスターユーザーの認証情報は `environment.ts` に記述され、ビルド成果物に含まれるため**秘匿できない**。テスト運用専用の措置であり、統合時には必ず撤去すること。

認証基盤（Firebase Auth / JWT検証 / 社員IDのメールアドレス変換）はそのまま残してある。Angular側で社員IDを認証用メールアドレスへ変換して Firebase Auth に渡す。

```
{社員ID}@ringiflow.ajiado.co.jp     例: E1234 -> E1234@ringiflow.ajiado.co.jp
```

アカウント発行とロール割り当ては**管理者のみ**が行う（セルフ登録画面は設けない）。

### 主な機能

- 稟議番号の自動採番（`R-2026-0001` 形式。同時申請でも重複しない）
- 一覧の絞り込み（ステータス・期間・キーワード）とカーソル方式のページング
- 添付ファイル（PDF・画像・Office文書等、10MBまで・1稟議10件まで）
- 金額による承認ルートの分岐
- 監査ログ（申請・承認・差し戻し・却下・再申請・取り下げ・添付・削除）
- 再申請時の変更差分を履歴に記録（何を直したかを承認者が追える）
- 稟議書としての入力項目（所属部門・決裁希望日・概要の可変項目）
- 決裁書の印刷/PDF出力（A4・押印欄・決裁経過）

### データアクセス方針

Firestore セキュリティルールは読み書きともに全面禁止（`allow read, write: if false`）。閲覧範囲の絞り込みを含め、すべてのデータアクセスは Go バックエンドAPI（Admin SDK）を経由する。クライアントSDKによるリアルタイム購読（`onSnapshot`）は利用しない。

添付ファイルの実体は専用の Cloud Storage バケット（`ringiflow-81f8d-attachments`）に置く。一般公開経路を持たない設定（uniform bucket-level access / public access prevention）とし、アップロード・ダウンロード・削除はすべてAPIを経由する。

## API エンドポイント

```
GET  /api/v1/me                   # ログイン中ユーザーの氏名・社員ID・ロール
GET  /api/v1/config               # 業務ルールの設定値（金額の閾値・添付の上限）
POST /api/v1/ringi                # 新規稟議の作成（申請）
GET  /api/v1/ringi                # 稟議一覧の取得
GET  /api/v1/ringi/{id}           # 詳細と履歴（audit_logs）の取得
POST /api/v1/ringi/{id}/approve   # 承認
POST /api/v1/ringi/{id}/return    # 差し戻し（再申請可能）
POST /api/v1/ringi/{id}/reject    # 却下（終端）
POST /api/v1/ringi/{id}/resubmit  # 再申請（申請者本人のみ）
POST /api/v1/ringi/{id}/withdraw  # 取り下げ（申請者本人のみ・終端）

POST   /api/v1/ringi/{id}/attachments                 # 添付
GET    /api/v1/ringi/{id}/attachments/{attachmentId}  # 取得
DELETE /api/v1/ringi/{id}/attachments/{attachmentId}  # 削除
```

## ディレクトリ構成

```
RingiFlow/
├── .firebaserc              # Firebaseプロジェクトの紐付け
├── firebase.json            # Hosting / Firestore のデプロイ設定
├── firestore.rules          # Firestoreセキュリティルール
├── firestore.indexes.json   # 複合インデックス定義
├── Doc/
│   └── BasicDesign.html     # 統合基本設計書
├── backend-go/              # Go バックエンドAPI
│   ├── main.go              # エントリポイント（ルーティング・起動）
│   ├── models/              # ドメインモデルと状態遷移表
│   ├── middleware/          # JWT検証・CORS
│   ├── services/            # トランザクション処理やビジネスロジック
│   ├── handlers/            # APIエンドポイントのハンドラ
│   ├── cmd/useradmin/       # 管理者向けユーザー発行CLI
│   └── Dockerfile           # Cloud Run 用
└── frontend-angular/        # Angular フロントエンド
    └── src/app/
        ├── core/            # サービス・ガード・インターセプター・モデル
        ├── features/        # 画面コンポーネント
        └── shared/          # 共通コンポーネント
```

## ドキュメント

- [統合基本設計書](Doc/BasicDesign.html) — システム構成、状態遷移、DB設計、API設計、フロントエンド設計

## 必要な環境

| ツール | バージョン |
| --- | --- |
| Node.js | 22.x |
| Go | 1.25 以上 |
| Firebase CLI | 15.x |
| gcloud CLI | Cloud Run へデプロイする場合のみ |

## セットアップ

### 1. 認証情報の準備（初回のみ）

バックエンドと `useradmin` は Application Default Credentials を使う。

```bash
gcloud auth application-default login
gcloud config set project ringiflow-81f8d
```

### 2. Firestore のルールとインデックスを反映

```bash
firebase deploy --only firestore:rules,firestore:indexes
```

### 3. アカウントの発行

セルフ登録画面はないため、最初のアカウントは CLI で発行する。

```bash
cd backend-go
go run ./cmd/useradmin create -employee MASTER -name "マスター運用" -role master -password "RingiFlow-Master-2026"
```

これがフロントエンドの自動ログイン先になる。`environment.ts` の `masterUser` と社員ID・パスワードを一致させること。

ロール別の挙動を個別に確認したい場合は、通常ロールのアカウントも作れる（画面からは切り替えられないため、API直叩き用）。

```bash
go run ./cmd/useradmin create -employee E0001 -name "申請 太郎"   -role applicant
go run ./cmd/useradmin create -employee E0002 -name "システム 花子" -role system_admin
go run ./cmd/useradmin create -employee E0003 -name "制作 次郎"   -role producer
go run ./cmd/useradmin create -employee E0004 -name "代表 三郎"   -role ceo
```

`-password` を省略すると初期パスワードが自動生成されて表示される。

```bash
go run ./cmd/useradmin list                                  # 一覧
go run ./cmd/useradmin setrole -employee E0001 -role producer # ロール変更
go run ./cmd/useradmin setdept -employee E0001 -department 企画事業部 # 所属変更
go run ./cmd/useradmin passwd  -employee E0001                # パスワード再発行
```

## ローカル起動

バックエンドとフロントエンドを別々のターミナルで起動する。

```bash
# ターミナル1: Go API (http://localhost:8080)
cd backend-go
go run .

# ターミナル2: Angular (http://localhost:4200)
cd frontend-angular
npm start
```

`http://localhost:4200` を開くと、マスターユーザーで自動ログインしてそのまま稟議一覧が表示される。

### 環境変数（バックエンド）

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `PORT` | `8080` | 待ち受けポート |
| `FIREBASE_PROJECT_ID` | `ringiflow-81f8d` | Firebase プロジェクトID |
| `ALLOWED_ORIGINS` | `http://localhost:4200` | CORS 許可オリジン（カンマ区切り） |
| `STORAGE_BUCKET` | `ringiflow-81f8d-attachments` | 添付ファイルの保存先バケット |

## テスト

```bash
cd backend-go       && go test ./...          # 状態遷移・権限判定・入力検証
cd frontend-angular && npm test -- --watch=false
```

いずれも外部サービスへの接続を必要としないため、認証情報なしで実行できる。
承認フローの正しさを左右する判定ロジック（`evaluateTransition` / `canView`）は
Firestore に依存しない純粋関数として切り出し、網羅的に検証している。

`main` への push と PR では [GitHub Actions](.github/workflows/ci.yml) が
両スタックのビルド・テストと Firestore ルールの構文確認を実行する。

## デプロイ

### バックエンド（Cloud Run）

```bash
cd backend-go
gcloud run deploy ringiflow-api \
  --source . \
  --region asia-northeast1 \
  --allow-unauthenticated \
  --set-env-vars ALLOWED_ORIGINS=https://ringiflow-81f8d.web.app
```

`--allow-unauthenticated` は Cloud Run 層での認証を無効にする指定であり、API 自体は
すべてのエンドポイントで Firebase ID トークンの検証を必須としている。

デプロイ後に表示されたURLを `frontend-angular/src/environments/environment.ts` の
`apiBaseUrl` に設定する。

### フロントエンド（Firebase Hosting）

```bash
cd frontend-angular && npm run build
cd .. && firebase deploy --only hosting
```

公開URL: `https://ringiflow-81f8d.web.app`
