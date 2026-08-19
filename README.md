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

- **状態変更はすべてGoバックエンド経由**。Firestore セキュリティルールでクライアントからの書き込みを全面禁止し、承認ステータスの更新は Firestore トランザクションで厳密に行う。
- **通知機能（メール等）は現フェーズ要件外**。コアとなる承認トランザクションと UI 実装を優先し、次以降のイテレーションで検討する。

## 承認フロー

```
(新規作成) → pending_system → pending_producer → pending_ceo → approved
                  ↓                  ↓
              returned            rejected
```

| ロール | 説明 |
| --- | --- |
| `applicant` | 申請者 |
| `system_admin` | システム担当 |
| `producer` | プロデューサー |
| `ceo` | 代表 |

## ディレクトリ構成（予定）

```
RingiFlow/
├── Doc/                     # 設計ドキュメント
│   └── BasicDesign.html     # 統合基本設計書
├── backend-go/              # Go バックエンドAPI
│   ├── main.go
│   ├── handlers/            # APIエンドポイントのルーティングとハンドラ
│   ├── services/            # トランザクション処理やビジネスロジック
│   └── go.mod
└── frontend-angular/        # Angular フロントエンド
    ├── src/
    └── angular.json
```

## ドキュメント

- [統合基本設計書](Doc/BasicDesign.html) — システム構成、状態遷移、DB設計、API設計、フロントエンド設計

## セットアップ

実装はこれから。バックエンド・フロントエンドのセットアップ手順は着手時に追記する。
