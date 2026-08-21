package handlers

import (
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/INOUE-ajiado/RingiFlow/backend-go/services"
)

// jst は日付指定（from / to）の解釈に用いる日本時間。
// 画面から渡される YYYY-MM-DD は日本時間の日付として扱う。
var jst = time.FixedZone("JST", 9*60*60)

// parseListQuery は一覧取得のクエリパラメータを解釈する。
//
//	scope   : all（既定） | mine | inbox
//	status  : ステータス（カンマ区切りで複数指定可）
//	from/to : 申請日時の範囲（YYYY-MM-DD、日本時間。to は指定日の終わりまでを含む）
//	q       : 稟議番号・タイトル・内容・申請者に対する部分一致
//	limit   : 1ページの件数
//	cursor  : 前回の応答が返した nextCursor
func parseListQuery(values url.Values) (services.ListQuery, *services.Error) {
	q := services.ListQuery{Scope: services.ScopeAll}

	switch values.Get("scope") {
	case string(services.ScopeMine):
		q.Scope = services.ScopeMine
	case string(services.ScopeInbox):
		q.Scope = services.ScopeInbox
	}

	if raw := strings.TrimSpace(values.Get("status")); raw != "" {
		for _, st := range strings.Split(raw, ",") {
			if st = strings.TrimSpace(st); st != "" {
				q.Statuses = append(q.Statuses, st)
			}
		}
		// Firestore の in 演算子は最大30個までしか受け付けない。
		// ステータスは7種類しかないため、それを超える指定は誤りとみなす。
		if len(q.Statuses) > 30 {
			return q, badRequest("指定できるステータスが多すぎます。")
		}
	}

	if raw := strings.TrimSpace(values.Get("from")); raw != "" {
		t, err := time.ParseInLocation("2006-01-02", raw, jst)
		if err != nil {
			return q, badRequest("開始日の形式が正しくありません（YYYY-MM-DD）。")
		}
		utc := t.UTC()
		q.From = &utc
	}

	if raw := strings.TrimSpace(values.Get("to")); raw != "" {
		t, err := time.ParseInLocation("2006-01-02", raw, jst)
		if err != nil {
			return q, badRequest("終了日の形式が正しくありません（YYYY-MM-DD）。")
		}
		// 指定日の終わりまでを含める
		utc := t.AddDate(0, 0, 1).Add(-time.Nanosecond).UTC()
		q.To = &utc
	}

	if q.From != nil && q.To != nil && q.From.After(*q.To) {
		return q, badRequest("開始日が終了日より後になっています。")
	}

	q.Keyword = strings.TrimSpace(values.Get("q"))

	if raw := strings.TrimSpace(values.Get("limit")); raw != "" {
		limit, err := strconv.Atoi(raw)
		if err != nil || limit <= 0 {
			return q, badRequest("件数の指定が正しくありません。")
		}
		q.Limit = limit
	}

	q.Cursor = strings.TrimSpace(values.Get("cursor"))
	return q, nil
}

func badRequest(message string) *services.Error {
	return &services.Error{
		HTTPStatus: http.StatusBadRequest,
		Code:       "invalid_argument",
		Message:    message,
	}
}
