package services

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/INOUE-ajiado/RingiFlow/backend-go/models"
)

func items(pairs ...string) []models.SummaryItem {
	out := make([]models.SummaryItem, 0, len(pairs)/2)
	for i := 0; i+1 < len(pairs); i += 2 {
		out = append(out, models.SummaryItem{Label: pairs[i], Value: pairs[i+1]})
	}
	return out
}

// --- normalizeSummary -------------------------------------------------------

func TestNormalizeSummary_正常な項目はそのまま通す(t *testing.T) {
	got, err := normalizeSummary(items("品名", "iPad 13インチ", "予算", "5万円以内", "購入先", "(株)ソフマップ"))
	if err != nil {
		t.Fatalf("予期しないエラー: %v", err.Message)
	}
	if len(got) != 3 {
		t.Fatalf("項目数: got %d, want 3", len(got))
	}
	if got[0].Label != "品名" || got[0].Value != "iPad 13インチ" {
		t.Errorf("先頭の項目が不正: %+v", got[0])
	}
}

func TestNormalizeSummary_前後の空白を除去する(t *testing.T) {
	got, err := normalizeSummary(items("  品名  ", "  iPad  "))
	if err != nil {
		t.Fatalf("予期しないエラー: %v", err.Message)
	}
	if got[0].Label != "品名" || got[0].Value != "iPad" {
		t.Errorf("空白が残っている: %+v", got[0])
	}
}

// フォーム上の未入力行が混ざるため、両方空の項目は取り除く。
func TestNormalizeSummary_両方空の項目は取り除く(t *testing.T) {
	got, err := normalizeSummary(items("品名", "iPad", "", "", "  ", "   "))
	if err != nil {
		t.Fatalf("予期しないエラー: %v", err.Message)
	}
	if len(got) != 1 {
		t.Errorf("項目数: got %d, want 1 (%+v)", len(got), got)
	}
}

func TestNormalizeSummary_すべて空なら空を返す(t *testing.T) {
	got, err := normalizeSummary(items("", "", "  ", ""))
	if err != nil {
		t.Fatalf("予期しないエラー: %v", err.Message)
	}
	if got != nil {
		t.Errorf("got %+v, want nil", got)
	}
	if got, err := normalizeSummary(nil); err != nil || got != nil {
		t.Errorf("nil入力: got %+v, err %v", got, err)
	}
}

// 片方だけ空は入力漏れの可能性が高いため、黙って捨てずにエラーにする。
func TestNormalizeSummary_片方だけ空はエラーにする(t *testing.T) {
	cases := []struct {
		name string
		in   []models.SummaryItem
	}{
		{"項目名が空", items("", "iPad 13インチ")},
		{"値が空", items("品名", "")},
		{"項目名が空白のみ", items("   ", "iPad")},
		{"値が空白のみ", items("品名", "   ")},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, err := normalizeSummary(c.in); err == nil {
				t.Error("エラーにならなかった")
			} else if err.HTTPStatus != http.StatusBadRequest {
				t.Errorf("got %d, want 400", err.HTTPStatus)
			}
		})
	}
}

func TestNormalizeSummary_長さと件数の上限(t *testing.T) {
	long := strings.Repeat("あ", models.MaxSummaryLabelRunes+1)
	if _, err := normalizeSummary(items(long, "値")); err == nil {
		t.Error("長すぎる項目名が受理された")
	}

	longValue := strings.Repeat("あ", models.MaxSummaryValueRunes+1)
	if _, err := normalizeSummary(items("品名", longValue)); err == nil {
		t.Error("長すぎる値が受理された")
	}

	// 上限ちょうどは通る
	ok := strings.Repeat("あ", models.MaxSummaryLabelRunes)
	if _, err := normalizeSummary(items(ok, "値")); err != nil {
		t.Errorf("上限ちょうどが拒否された: %v", err.Message)
	}

	many := make([]models.SummaryItem, 0, models.MaxSummaryItems+1)
	for i := 0; i <= models.MaxSummaryItems; i++ {
		many = append(many, models.SummaryItem{Label: "項目", Value: "値"})
	}
	if _, err := normalizeSummary(many); err == nil {
		t.Errorf("上限を超える件数が受理された（%d件）", len(many))
	}
}

// --- parseDueDate -----------------------------------------------------------

func TestParseDueDate(t *testing.T) {
	got, err := parseDueDate("2026-03-19")
	if err != nil {
		t.Fatalf("予期しないエラー: %v", err.Message)
	}
	// 日本時間の 2026-03-19 00:00 = UTC 2026-03-18 15:00
	want := time.Date(2026, 3, 18, 15, 0, 0, 0, time.UTC)
	if !got.Equal(want) {
		t.Errorf("got %v, want %v", got.UTC(), want)
	}
}

func TestParseDueDate_空は未指定として扱う(t *testing.T) {
	for _, raw := range []string{"", "   "} {
		got, err := parseDueDate(raw)
		if err != nil {
			t.Errorf("%q でエラー: %v", raw, err.Message)
		}
		if got != nil {
			t.Errorf("%q: got %v, want nil", raw, got)
		}
	}
}

func TestParseDueDate_不正な形式を拒否する(t *testing.T) {
	for _, raw := range []string{"2026/03/19", "03-19-2026", "notadate", "2026-13-01"} {
		if _, err := parseDueDate(raw); err == nil {
			t.Errorf("%q が受理された", raw)
		}
	}
}

// --- 差分表示用の整形 --------------------------------------------------------

func TestFormatSummary(t *testing.T) {
	if got := formatSummary(nil); got != "（なし）" {
		t.Errorf("空: got %q", got)
	}
	got := formatSummary(items("品名", "iPad", "予算", "5万円"))
	if got != "品名: iPad / 予算: 5万円" {
		t.Errorf("got %q", got)
	}
}

func TestFormatDueDate(t *testing.T) {
	if got := formatDueDate(nil); got != "（未指定）" {
		t.Errorf("nil: got %q", got)
	}
	// UTC で持っていても日本時間の日付として表示する
	utc := time.Date(2026, 3, 18, 15, 0, 0, 0, time.UTC)
	if got := formatDueDate(&utc); got != "2026-03-19" {
		t.Errorf("got %q, want 2026-03-19", got)
	}
}

func TestSummaryEqual(t *testing.T) {
	a := items("品名", "iPad", "予算", "5万円")
	if !summaryEqual(a, items("品名", "iPad", "予算", "5万円")) {
		t.Error("同一の内容が異なると判定された")
	}
	if summaryEqual(a, items("品名", "iPad")) {
		t.Error("件数が違うのに同一と判定された")
	}
	if summaryEqual(a, items("品名", "iPad", "予算", "10万円")) {
		t.Error("値が違うのに同一と判定された")
	}
	if !summaryEqual(nil, nil) {
		t.Error("nil同士が異なると判定された")
	}
}
