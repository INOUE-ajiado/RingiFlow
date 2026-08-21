package handlers

import (
	"net/url"
	"testing"
	"time"

	"github.com/INOUE-ajiado/RingiFlow/backend-go/services"
)

func parse(t *testing.T, raw string) services.ListQuery {
	t.Helper()
	values, err := url.ParseQuery(raw)
	if err != nil {
		t.Fatalf("クエリの解析に失敗: %v", err)
	}
	q, appErr := parseListQuery(values)
	if appErr != nil {
		t.Fatalf("予期しないエラー: %v", appErr.Message)
	}
	return q
}

func TestParseListQuery_既定値(t *testing.T) {
	q := parse(t, "")
	if q.Scope != services.ScopeAll {
		t.Errorf("scope: got %q, want all", q.Scope)
	}
	if len(q.Statuses) != 0 || q.From != nil || q.To != nil || q.Keyword != "" || q.Cursor != "" {
		t.Errorf("既定値が空でない: %+v", q)
	}
}

func TestParseListQuery_scope(t *testing.T) {
	for raw, want := range map[string]services.ListScope{
		"scope=mine":    services.ScopeMine,
		"scope=inbox":   services.ScopeInbox,
		"scope=all":     services.ScopeAll,
		"scope=unknown": services.ScopeAll, // 未知の値は既定へフォールバック
	} {
		if got := parse(t, raw).Scope; got != want {
			t.Errorf("%s: got %q, want %q", raw, got, want)
		}
	}
}

func TestParseListQuery_ステータスをカンマ区切りで受け取る(t *testing.T) {
	q := parse(t, "status=pending_system,approved")
	if len(q.Statuses) != 2 || q.Statuses[0] != "pending_system" || q.Statuses[1] != "approved" {
		t.Errorf("got %v", q.Statuses)
	}

	// 空要素と前後の空白は無視する
	q = parse(t, url.Values{"status": {" approved , , rejected "}}.Encode())
	if len(q.Statuses) != 2 || q.Statuses[0] != "approved" || q.Statuses[1] != "rejected" {
		t.Errorf("got %v", q.Statuses)
	}
}

// to は「指定日の終わりまで」を含む必要がある。
// 単純に日付をそのまま使うと、その日に申請された稟議が一件も引っかからない。
func TestParseListQuery_日付範囲は日本時間で解釈し終了日を含む(t *testing.T) {
	q := parse(t, "from=2026-08-01&to=2026-08-31")

	wantFrom := time.Date(2026, 7, 31, 15, 0, 0, 0, time.UTC) // 2026-08-01 00:00 JST
	if !q.From.Equal(wantFrom) {
		t.Errorf("from: got %v, want %v", q.From.UTC(), wantFrom)
	}

	// 2026-09-01 00:00 JST の1ナノ秒前 = 2026-08-31 23:59:59.999999999 JST
	wantTo := time.Date(2026, 8, 31, 15, 0, 0, 0, time.UTC).Add(-time.Nanosecond)
	if !q.To.Equal(wantTo) {
		t.Errorf("to: got %v, want %v", q.To.UTC(), wantTo)
	}
	if !q.To.After(*q.From) {
		t.Error("to が from より後になっていない")
	}
}

func TestParseListQuery_不正な入力を拒否する(t *testing.T) {
	cases := []struct {
		name string
		raw  string
	}{
		{"開始日の形式", "from=2026%2F08%2F01"},
		{"終了日の形式", "to=notadate"},
		{"開始日が終了日より後", "from=2026-08-31&to=2026-08-01"},
		{"件数が数値でない", "limit=abc"},
		{"件数が0", "limit=0"},
		{"件数が負", "limit=-5"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			values, _ := url.ParseQuery(c.raw)
			if _, err := parseListQuery(values); err == nil {
				t.Errorf("不正な入力 %q が受理された", c.raw)
			} else if err.HTTPStatus != 400 {
				t.Errorf("got %d, want 400", err.HTTPStatus)
			}
		})
	}
}

func TestParseListQuery_同一日の指定を許容する(t *testing.T) {
	q := parse(t, "from=2026-08-21&to=2026-08-21")
	if !q.To.After(*q.From) {
		t.Error("同一日を指定したとき to が from より後になっていない")
	}
}

func TestParseListQuery_キーワードと件数とカーソル(t *testing.T) {
	q := parse(t, url.Values{
		"q":      {"  ノートPC  "},
		"limit":  {"25"},
		"cursor": {" abc123 "},
	}.Encode())

	if q.Keyword != "ノートPC" {
		t.Errorf("keyword: got %q", q.Keyword)
	}
	if q.Limit != 25 {
		t.Errorf("limit: got %d, want 25", q.Limit)
	}
	if q.Cursor != "abc123" {
		t.Errorf("cursor: got %q", q.Cursor)
	}
}
