package services

import (
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/INOUE-ajiado/RingiFlow/backend-go/models"
)

// jstDate は決裁希望日の解釈に用いる日本時間。
var jstDate = time.FixedZone("JST", 9*60*60)

// normalizeSummary は「概要」欄の入力を検証して整える。
//
// ラベルと値がともに空の項目は、フォーム上の未入力行とみなして取り除く。
// 片方だけが空の項目は入力漏れの可能性が高いため、エラーとして返す。
func normalizeSummary(items []models.SummaryItem) ([]models.SummaryItem, *Error) {
	if len(items) == 0 {
		return nil, nil
	}

	result := make([]models.SummaryItem, 0, len(items))
	for _, item := range items {
		label := strings.TrimSpace(item.Label)
		value := strings.TrimSpace(item.Value)

		if label == "" && value == "" {
			continue
		}
		if label == "" {
			return nil, newError(http.StatusBadRequest, "invalid_argument",
				fmt.Sprintf("概要の項目名を入力してください（値: %s）。", truncate(value, 20)))
		}
		if value == "" {
			return nil, newError(http.StatusBadRequest, "invalid_argument",
				fmt.Sprintf("概要「%s」の内容を入力してください。", label))
		}
		if len([]rune(label)) > models.MaxSummaryLabelRunes {
			return nil, newError(http.StatusBadRequest, "invalid_argument",
				fmt.Sprintf("概要の項目名は%d文字以内で入力してください。", models.MaxSummaryLabelRunes))
		}
		if len([]rune(value)) > models.MaxSummaryValueRunes {
			return nil, newError(http.StatusBadRequest, "invalid_argument",
				fmt.Sprintf("概要「%s」の内容は%d文字以内で入力してください。", label, models.MaxSummaryValueRunes))
		}
		result = append(result, models.SummaryItem{Label: label, Value: value})
	}

	if len(result) > models.MaxSummaryItems {
		return nil, newError(http.StatusBadRequest, "invalid_argument",
			fmt.Sprintf("概要の項目は%d件までです。", models.MaxSummaryItems))
	}
	if len(result) == 0 {
		return nil, nil
	}
	return result, nil
}

// parseDueDate は決裁希望日（YYYY-MM-DD）を解釈する。
//
// 日付のみを扱うため、日本時間のその日の 0 時として保持する。
// 空文字の場合は未指定として nil を返す。
func parseDueDate(raw string) (*time.Time, *Error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	t, err := time.ParseInLocation("2006-01-02", raw, jstDate)
	if err != nil {
		return nil, newError(http.StatusBadRequest, "invalid_argument",
			"決裁希望日の形式が正しくありません（YYYY-MM-DD）。")
	}
	utc := t.UTC()
	return &utc, nil
}

// summaryEqual は概要欄の内容が同一かを判定する。再申請の差分検出に用いる。
func summaryEqual(a, b []models.SummaryItem) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// formatSummary は概要欄を差分表示用の1行テキストへ変換する。
func formatSummary(items []models.SummaryItem) string {
	if len(items) == 0 {
		return "（なし）"
	}
	parts := make([]string, 0, len(items))
	for _, item := range items {
		parts = append(parts, item.Label+": "+item.Value)
	}
	return strings.Join(parts, " / ")
}

// formatDueDate は決裁希望日を差分表示用のテキストへ変換する。
func formatDueDate(t *time.Time) string {
	if t == nil {
		return "（未指定）"
	}
	return t.In(jstDate).Format("2006-01-02")
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}
