// Package middleware は HTTP ミドルウェア（認証・CORS）を提供する。
package middleware

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"cloud.google.com/go/firestore"
	firebaseauth "firebase.google.com/go/v4/auth"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/INOUE-ajiado/RingiFlow/backend-go/models"
)

type ctxKey struct{}

var userCtxKey ctxKey

// Auth は Authorization ヘッダーの Bearer トークン（Firebase ID トークン）を検証し、
// users コレクションから権限ロールを取得してリクエストコンテキストへ格納する。
//
// 基本設計書 5.2節 Step1 に相当する。ロールはクライアントの申告ではなく
// 必ずサーバー側で Firestore から取得することで、権限の詐称を防ぐ。
type Auth struct {
	AuthClient *firebaseauth.Client
	Firestore  *firestore.Client
}

// Wrap は認証を必須とするハンドラをラップする。
func (a *Auth) Wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		header := r.Header.Get("Authorization")
		if !strings.HasPrefix(header, "Bearer ") {
			writeError(w, http.StatusUnauthorized, "unauthenticated", "認証トークンが指定されていません。")
			return
		}
		idToken := strings.TrimSpace(strings.TrimPrefix(header, "Bearer "))
		if idToken == "" {
			writeError(w, http.StatusUnauthorized, "unauthenticated", "認証トークンが指定されていません。")
			return
		}

		token, err := a.AuthClient.VerifyIDToken(r.Context(), idToken)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "invalid_token", "認証トークンが無効または期限切れです。")
			return
		}

		snap, err := a.Firestore.Collection("users").Doc(token.UID).Get(r.Context())
		if err != nil {
			if status.Code(err) == codes.NotFound {
				// Firebase Auth 上には存在するが users ドキュメントが未整備の状態。
				// 基本設計書 3.4節のとおりアカウント発行は管理者が両方を作成する運用のため、
				// ここに到達する場合は運用上の不整合を示す。
				writeError(w, http.StatusForbidden, "user_not_provisioned",
					"ユーザー情報が登録されていません。管理者にお問い合わせください。")
				return
			}
			log.Printf("failed to load user %s: %v", token.UID, err)
			writeError(w, http.StatusInternalServerError, "internal_error", "ユーザー情報の取得に失敗しました。")
			return
		}

		var user models.User
		if err := snap.DataTo(&user); err != nil {
			log.Printf("failed to decode user %s: %v", token.UID, err)
			writeError(w, http.StatusInternalServerError, "internal_error", "ユーザー情報の読み取りに失敗しました。")
			return
		}
		user.UID = token.UID

		if !models.IsValidRole(user.Role) {
			writeError(w, http.StatusForbidden, "invalid_role", "権限ロールが正しく設定されていません。")
			return
		}

		ctx := context.WithValue(r.Context(), userCtxKey, &user)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// UserFrom はコンテキストから認証済みユーザーを取り出す。
func UserFrom(ctx context.Context) (*models.User, bool) {
	u, ok := ctx.Value(userCtxKey).(*models.User)
	return u, ok
}

func writeError(w http.ResponseWriter, code int, errCode, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"success": false,
		"error":   errCode,
		"message": message,
	})
}
