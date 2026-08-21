package services

import (
	"net/http"
	"strings"
	"testing"

	"github.com/INOUE-ajiado/RingiFlow/backend-go/models"
)

// --- sanitizeFileName -------------------------------------------------------

func TestSanitizeFileName_正常なファイル名はそのまま(t *testing.T) {
	for _, name := range []string{"見積書.pdf", "quote_2026-08.xlsx", "資料 (1).docx"} {
		got, err := sanitizeFileName(name)
		if err != nil {
			t.Errorf("%q が拒否された: %v", name, err.Message)
			continue
		}
		if got != name {
			t.Errorf("%q が変更された: got %q", name, got)
		}
	}
}

// ディレクトリ区切りを含む名前でStorageに意図しない階層が作られないことを確認する。
func TestSanitizeFileName_パス要素を除去する(t *testing.T) {
	cases := map[string]string{
		"../../etc/passwd":           "passwd",
		`C:\Users\eila\見積書.pdf`:      "見積書.pdf",
		"folder/sub/report.pdf":      "report.pdf",
		"/absolute/path/invoice.pdf": "invoice.pdf",
	}
	for input, want := range cases {
		got, err := sanitizeFileName(input)
		if err != nil {
			t.Errorf("%q が拒否された: %v", input, err.Message)
			continue
		}
		if got != want {
			t.Errorf("%q: got %q, want %q", input, got, want)
		}
		if strings.ContainsAny(got, `/\`) {
			t.Errorf("%q: パス区切りが残っている: %q", input, got)
		}
	}
}

func TestSanitizeFileName_危険な文字を置換する(t *testing.T) {
	got, err := sanitizeFileName("re:port*?.pdf")
	if err != nil {
		t.Fatalf("拒否された: %v", err.Message)
	}
	if strings.ContainsAny(got, `:*?"<>|`) {
		t.Errorf("危険な文字が残っている: %q", got)
	}
}

func TestSanitizeFileName_制御文字を除去する(t *testing.T) {
	got, err := sanitizeFileName("report\x00\x1f.pdf")
	if err != nil {
		t.Fatalf("拒否された: %v", err.Message)
	}
	if got != "report.pdf" {
		t.Errorf("got %q, want %q", got, "report.pdf")
	}
}

func TestSanitizeFileName_不正な名前を拒否する(t *testing.T) {
	cases := []struct {
		name  string
		input string
	}{
		{"空文字", ""},
		{"空白のみ", "   "},
		{"ドットのみ", "..."},
		{"パス区切りのみ", "///"},
		{"長すぎる", strings.Repeat("あ", 121) + ".pdf"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, err := sanitizeFileName(c.input); err == nil {
				t.Errorf("%q が受理された", c.input)
			} else if err.HTTPStatus != http.StatusBadRequest {
				t.Errorf("got %d, want 400", err.HTTPStatus)
			}
		})
	}
}

// --- canModifyAttachments ---------------------------------------------------

func attachReq(stat string) *models.RingiRequest {
	return &models.RingiRequest{ID: "r-1", ApplicantID: uidApplicant, Status: stat}
}

func TestCanModifyAttachments_申請者本人は決裁前に変更できる(t *testing.T) {
	owner := user(uidApplicant, models.RoleApplicant)
	for _, stat := range []string{
		models.StatusPendingSystem, models.StatusPendingProducer,
		models.StatusPendingCEO, models.StatusReturned,
	} {
		if err := canModifyAttachments(owner, attachReq(stat)); err != nil {
			t.Errorf("%s で申請者本人が変更できない: %v", stat, err.Message)
		}
	}
}

func TestCanModifyAttachments_決裁確定後は変更できない(t *testing.T) {
	owner := user(uidApplicant, models.RoleApplicant)
	for _, stat := range []string{models.StatusApproved, models.StatusRejected, models.StatusWithdrawn} {
		err := canModifyAttachments(owner, attachReq(stat))
		if err == nil {
			t.Errorf("%s で変更が許可された", stat)
			continue
		}
		if err.Code != "invalid_state_transition" {
			t.Errorf("%s: got %s, want invalid_state_transition", stat, err.Code)
		}
	}

	// マスターであっても決裁確定後は変更できない
	master := user("uid-master", models.RoleMaster)
	if err := canModifyAttachments(master, attachReq(models.StatusApproved)); err == nil {
		t.Error("マスターが決裁確定後の添付を変更できてしまう")
	}
}

func TestCanModifyAttachments_他人は変更できない(t *testing.T) {
	for _, actor := range []*models.User{
		user("uid-other", models.RoleApplicant),
		user(uidSysAdmin, models.RoleSystemAdmin),
		user(uidCEO, models.RoleCEO),
	} {
		err := canModifyAttachments(actor, attachReq(models.StatusPendingSystem))
		if err == nil {
			t.Errorf("ロール %s が他人の添付を変更できてしまう", actor.Role)
			continue
		}
		if err.Code != "permission_denied" {
			t.Errorf("got %s, want permission_denied", err.Code)
		}
	}
}

func TestCanModifyAttachments_マスターは決裁前なら変更できる(t *testing.T) {
	master := user("uid-master", models.RoleMaster)
	if err := canModifyAttachments(master, attachReq(models.StatusPendingCEO)); err != nil {
		t.Errorf("マスターが変更できない: %v", err.Message)
	}
}
