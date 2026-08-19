package services

import "net/http"

// Error は HTTP ステータスとエラーコードを伴うアプリケーションエラー。
type Error struct {
	HTTPStatus int
	Code       string
	Message    string
}

func (e *Error) Error() string { return e.Message }

func newError(status int, code, message string) *Error {
	return &Error{HTTPStatus: status, Code: code, Message: message}
}

// 各種エラーの生成ヘルパー。
var (
	errNotFound = func() *Error {
		return newError(http.StatusNotFound, "not_found", "指定された稟議が見つかりません。")
	}
	errForbidden = func() *Error {
		return newError(http.StatusForbidden, "permission_denied", "この稟議を閲覧する権限がありません。")
	}
	errInternal = func() *Error {
		return newError(http.StatusInternalServerError, "internal_error", "サーバー内部エラーが発生しました。")
	}
)
