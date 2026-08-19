// Package handlers は HTTP エンドポイントのルーティングとハンドラを提供する。
package handlers

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"

	"github.com/INOUE-ajiado/RingiFlow/backend-go/services"
)

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		log.Printf("failed to write response: %v", err)
	}
}

// writeError はアプリケーションエラーを基本設計書 5.1節のエラーレスポンス形式で返す。
func writeError(w http.ResponseWriter, err error) {
	var appErr *services.Error
	if !errors.As(err, &appErr) {
		log.Printf("unexpected error: %v", err)
		appErr = &services.Error{
			HTTPStatus: http.StatusInternalServerError,
			Code:       "internal_error",
			Message:    "サーバー内部エラーが発生しました。",
		}
	}
	writeJSON(w, appErr.HTTPStatus, map[string]any{
		"success": false,
		"error":   appErr.Code,
		"message": appErr.Message,
	})
}

// decodeJSON はリクエストボディを読み取る。ボディが空の場合はゼロ値のまま成功とする。
func decodeJSON(r *http.Request, dst any) error {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		if errors.Is(err, io.EOF) {
			return nil
		}
		return &services.Error{
			HTTPStatus: http.StatusBadRequest,
			Code:       "invalid_argument",
			Message:    "リクエストの形式が正しくありません。",
		}
	}
	return nil
}
