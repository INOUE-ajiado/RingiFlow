# RingiFlow

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
- 状態遷移表に定義のない遷移は Go API がすべて HTTP 409 で拒否する

| ロール | 説明 |
| --- | --- |
| `applicant` | 申請者 |
| `system_admin` | システム担当 |
| `producer` | プロデューサー |
| `ceo` | 代表 |

## Firebase プロジェクト

| 項目 | 値 |
| --- | --- |
| プロジェクトID | `ringiflow-81f8d` |
| ウェブアプリ | `RingiFlow Web` |
| Firestore | `(default)` / Native / **asia-northeast1** |
| Authentication | メール/パスワード |
| Hosting サイト | `ringiflow-81f8d` |

### ログイン方式

ユーザーが入力するのは**社員IDとパスワードのみ**。Angular側で社員IDを認証用メールアドレスへ変換して Firebase Auth に渡す。

```
{社員ID}@ringiflow.ajiado.co.jp     例: E1234 -> E1234@ringiflow.ajiado.co.jp
```

アカウント発行とロール割り当ては**管理者のみ**が行う（セルフ登録画面は設けない）。

### データアクセス方針

Firestore セキュリティルールは読み書きともに全面禁止（`allow read, write: if false`）。閲覧範囲の絞り込みを含め、すべてのデータアクセスは Go バックエンドAPI（Admin SDK）を経由する。クライアントSDKによるリアルタイム購読（`onSnapshot`）は利用しない。

## API エンドポイント

```
POST /api/v1/ringi                # 新規稟議の作成（申請）
GET  /api/v1/ringi                # 稟議一覧の取得
GET  /api/v1/ringi/{id}           # 詳細と履歴（audit_logs）の取得
POST /api/v1/ringi/{id}/approve   # 承認
POST /api/v1/ringi/{id}/return    # 差し戻し（再申請可能）
POST /api/v1/ringi/{id}/reject    # 却下（終端）
POST /api/v1/ringi/{id}/resubmit  # 再申請（申請者本人のみ）
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
go run ./cmd/useradmin create -employee E0001 -name "申請 太郎"   -role applicant
go run ./cmd/useradmin create -employee E0002 -name "システム 花子" -role system_admin
go run ./cmd/useradmin create -employee E0003 -name "制作 次郎"   -role producer
go run ./cmd/useradmin create -employee E0004 -name "代表 三郎"   -role ceo
```

`-password` を省略すると初期パスワードが自動生成されて表示される。

```bash
go run ./cmd/useradmin list                                  # 一覧
go run ./cmd/useradmin setrole -employee E0001 -role producer # ロール変更
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

`http://localhost:4200` を開き、発行した社員IDとパスワードでログインする。

### 環境変数（バックエンド）

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `PORT` | `8080` | 待ち受けポート |
| `FIREBASE_PROJECT_ID` | `ringiflow-81f8d` | Firebase プロジェクトID |
| `ALLOWED_ORIGINS` | `http://localhost:4200` | CORS 許可オリジン（カンマ区切り） |

## テスト

```bash
cd backend-go       && go test ./...          # 状態遷移表の検証
cd frontend-angular && npm test -- --watch=false
```

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
