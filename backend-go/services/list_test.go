package services

import (
	"testing"
	"time"

	"github.com/INOUE-ajiado/RingiFlow/backend-go/models"
)

// --- カーソル ---------------------------------------------------------------

func TestCursor_往復して同じ値になる(t *testing.T) {
	created := time.Date(2026, 8, 21, 12, 34, 56, 789012345, time.UTC)
	req := models.RingiRequest{ID: "abc123", CreatedAt: created}

	gotTime, gotID, err := decodeCursor(encodeCursor(req))
	if err != nil {
		t.Fatalf("復号に失敗: %v", err)
	}
	if !gotTime.Equal(created) {
		t.Errorf("時刻: got %v, want %v", gotTime, created)
	}
	if gotID != "abc123" {
		t.Errorf("ID: got %q, want %q", gotID, "abc123")
	}
}

func TestCursor_ナノ秒まで保持する(t *testing.T) {
	// 同時刻の稟議が複数あってもページ境界がずれないよう、
	// カーソルはナノ秒の精度を落としてはならない。
	created := time.Date(2026, 1, 1, 0, 0, 0, 1, time.UTC)
	gotTime, _, err := decodeCursor(encodeCursor(models.RingiRequest{ID: "x", CreatedAt: created}))
	if err != nil {
		t.Fatalf("復号に失敗: %v", err)
	}
	if gotTime.Nanosecond() != 1 {
		t.Errorf("ナノ秒が失われている: got %d, want 1", gotTime.Nanosecond())
	}
}

func TestCursor_タイムゾーンによらず同じ値になる(t *testing.T) {
	utc := time.Date(2026, 8, 21, 3, 0, 0, 0, time.UTC)
	jstZone := time.FixedZone("JST", 9*60*60)
	same := utc.In(jstZone) // 同じ瞬間を別のタイムゾーンで表現

	a := encodeCursor(models.RingiRequest{ID: "x", CreatedAt: utc})
	b := encodeCursor(models.RingiRequest{ID: "x", CreatedAt: same})
	if a != b {
		t.Errorf("同じ時刻から異なるカーソルが生成された: %q vs %q", a, b)
	}
}

func TestCursor_不正な値を拒否する(t *testing.T) {
	cases := []struct {
		name   string
		cursor string
	}{
		{"base64ではない", "!!!not-base64!!!"},
		{"区切り文字がない", "MjAyNi0wOC0yMQ"},           // "2026-08-21"
		{"IDが空", "MjAyNi0wOC0yMVQwMDowMDowMFp8"}, // "2026-08-21T00:00:00Z|"
		{"時刻が不正", "bm90LWEtdGltZXxhYmM"},         // "not-a-time|abc"
		{"空文字", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, _, err := decodeCursor(c.cursor); err == nil {
				t.Errorf("不正なカーソル %q が受理された", c.cursor)
			}
		})
	}
}

// --- キーワード一致 ---------------------------------------------------------

func TestMatchesKeyword(t *testing.T) {
	req := &models.RingiRequest{
		RequestNo:           "R-2026-0042",
		Title:               "開発用ノートPCの購入",
		Content:             "開発環境の刷新のため",
		ApplicantName:       "申請 太郎",
		ApplicantEmployeeID: "E0001",
	}

	hits := []struct {
		name    string
		keyword string
	}{
		{"稟議番号", "r-2026-0042"},
		{"稟議番号の一部", "0042"},
		{"タイトル", "ノートpc"},
		{"タイトルの一部", "購入"},
		{"内容", "刷新"},
		{"申請者名", "太郎"},
		{"社員ID", "e0001"},
	}
	for _, c := range hits {
		t.Run("一致:"+c.name, func(t *testing.T) {
			if !matchesKeyword(req, c.keyword) {
				t.Errorf("キーワード %q が一致しなかった", c.keyword)
			}
		})
	}

	misses := []string{"存在しない語", "R-2025", "E0002"}
	for _, k := range misses {
		t.Run("不一致:"+k, func(t *testing.T) {
			if matchesKeyword(req, k) {
				t.Errorf("キーワード %q が誤って一致した", k)
			}
		})
	}
}

// 大文字小文字を区別せずに検索できることを確認する。
// 呼び出し側は小文字化した検索語を渡す約束になっている。
func TestMatchesKeyword_大文字小文字を区別しない(t *testing.T) {
	req := &models.RingiRequest{Title: "Cloud Run の利用申請"}
	for _, k := range []string{"cloud", "cloud run"} {
		if !matchesKeyword(req, k) {
			t.Errorf("キーワード %q が一致しなかった", k)
		}
	}
}
