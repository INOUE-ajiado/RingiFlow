package services

import (
	"net/http"
	"testing"
	"time"

	"github.com/INOUE-ajiado/RingiFlow/backend-go/models"
)

const (
	uidApplicant = "uid-applicant"
	uidSysAdmin  = "uid-sysadmin"
	uidProducer  = "uid-producer"
	uidCEO       = "uid-ceo"
)

func user(uid, role string) *models.User {
	return &models.User{UID: uid, EmployeeID: "E0001", Name: "テスト太郎", Role: role}
}

func req(stat string) *models.RingiRequest {
	return &models.RingiRequest{
		ID:          "r-1",
		Title:       "テスト稟議",
		Content:     "内容",
		Amount:      10000,
		ApplicantID: uidApplicant,
		Status:      stat,
	}
}

func ptr[T any](v T) *T { return &v }

// --- evaluateTransition ---------------------------------------------------

func TestEvaluateTransition_正常系(t *testing.T) {
	cases := []struct {
		name    string
		status  string
		actor   *models.User
		action  string
		comment string
		wantTo  string
	}{
		{"システム担当が承認", models.StatusPendingSystem, user(uidSysAdmin, models.RoleSystemAdmin), models.ActionApprove, "", models.StatusPendingProducer},
		{"システム担当が差し戻し", models.StatusPendingSystem, user(uidSysAdmin, models.RoleSystemAdmin), models.ActionReturn, "不備あり", models.StatusReturned},
		{"システム担当が却下", models.StatusPendingSystem, user(uidSysAdmin, models.RoleSystemAdmin), models.ActionReject, "認められない", models.StatusRejected},
		{"PDが承認", models.StatusPendingProducer, user(uidProducer, models.RoleProducer), models.ActionApprove, "", models.StatusPendingCEO},
		{"PDが差し戻し", models.StatusPendingProducer, user(uidProducer, models.RoleProducer), models.ActionReturn, "要修正", models.StatusReturned},
		{"代表が承認して決裁完了", models.StatusPendingCEO, user(uidCEO, models.RoleCEO), models.ActionApprove, "", models.StatusApproved},
		{"代表が却下", models.StatusPendingCEO, user(uidCEO, models.RoleCEO), models.ActionReject, "見送り", models.StatusRejected},
		{"申請者本人が再申請", models.StatusReturned, user(uidApplicant, models.RoleApplicant), models.ActionResubmit, "", models.StatusPendingSystem},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rule, err := evaluateTransition(req(c.status), c.actor, c.action, c.comment)
			if err != nil {
				t.Fatalf("予期しないエラー: %v", err)
			}
			if rule.To != c.wantTo {
				t.Errorf("遷移先: got %q, want %q", rule.To, c.wantTo)
			}
		})
	}
}

func TestEvaluateTransition_ロール不一致は拒否する(t *testing.T) {
	cases := []struct {
		name   string
		status string
		actor  *models.User
	}{
		{"PDがシステム担当の工程を承認しようとする", models.StatusPendingSystem, user(uidProducer, models.RoleProducer)},
		{"代表がシステム担当の工程を承認しようとする", models.StatusPendingSystem, user(uidCEO, models.RoleCEO)},
		{"システム担当がPDの工程を承認しようとする", models.StatusPendingProducer, user(uidSysAdmin, models.RoleSystemAdmin)},
		{"PDが代表の工程を承認しようとする", models.StatusPendingCEO, user(uidProducer, models.RoleProducer)},
		{"申請者が承認しようとする", models.StatusPendingSystem, user(uidApplicant, models.RoleApplicant)},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := evaluateTransition(req(c.status), c.actor, models.ActionApprove, "")
			if err == nil {
				t.Fatal("拒否されるべき操作が許可された")
			}
			if err.HTTPStatus != http.StatusConflict || err.Code != "permission_denied" {
				t.Errorf("got %d/%s, want 409/permission_denied", err.HTTPStatus, err.Code)
			}
		})
	}
}

func TestEvaluateTransition_終端ステータスは操作できない(t *testing.T) {
	for _, stat := range []string{models.StatusApproved, models.StatusRejected} {
		for _, action := range []string{models.ActionApprove, models.ActionReject, models.ActionReturn, models.ActionResubmit} {
			_, err := evaluateTransition(req(stat), user(uidCEO, models.RoleCEO), action, "コメント")
			if err == nil {
				t.Errorf("%s に対する %s が許可された", stat, action)
				continue
			}
			if err.HTTPStatus != http.StatusConflict || err.Code != "invalid_state_transition" {
				t.Errorf("%s/%s: got %d/%s, want 409/invalid_state_transition",
					stat, action, err.HTTPStatus, err.Code)
			}
		}
	}
}

// 他の承認者が先に処理した場合、後続の操作は409で弾かれる必要がある。
// トランザクション内で最新のステータスを読んだうえで本判定を行うため、
// 同時操作によるデータ不整合はここで防止される。
func TestEvaluateTransition_処理済みの稟議への二重操作を拒否する(t *testing.T) {
	// システム担当が承認済み（pending_producer）の稟議に、もう一度承認を試みる
	_, err := evaluateTransition(req(models.StatusPendingProducer), user(uidSysAdmin, models.RoleSystemAdmin), models.ActionApprove, "")
	if err == nil {
		t.Fatal("二重承認が許可された")
	}
	if err.Code != "permission_denied" && err.Code != "invalid_state_transition" {
		t.Errorf("unexpected code: %s", err.Code)
	}
}

func TestEvaluateTransition_再申請は申請者本人のみ(t *testing.T) {
	// 別の申請者ロールのユーザー
	_, err := evaluateTransition(req(models.StatusReturned), user("uid-other", models.RoleApplicant), models.ActionResubmit, "")
	if err == nil {
		t.Fatal("他人による再申請が許可された")
	}
	if err.Code != "permission_denied" {
		t.Errorf("got %s, want permission_denied", err.Code)
	}

	// 承認者ロールであっても本人でなければ再申請できない
	if _, err := evaluateTransition(req(models.StatusReturned), user(uidCEO, models.RoleCEO), models.ActionResubmit, ""); err == nil {
		t.Error("代表による他人の稟議の再申請が許可された")
	}
}

func TestEvaluateTransition_差し戻しと却下はコメント必須(t *testing.T) {
	for _, action := range []string{models.ActionReturn, models.ActionReject} {
		for _, comment := range []string{"", "   ", "\t\n"} {
			_, err := evaluateTransition(req(models.StatusPendingSystem), user(uidSysAdmin, models.RoleSystemAdmin), action, comment)
			if err == nil {
				t.Errorf("%s がコメント %q で許可された", action, comment)
				continue
			}
			if err.HTTPStatus != http.StatusBadRequest || err.Code != "comment_required" {
				t.Errorf("%s: got %d/%s, want 400/comment_required", action, err.HTTPStatus, err.Code)
			}
		}
	}
}

func TestEvaluateTransition_承認と再申請はコメント任意(t *testing.T) {
	if _, err := evaluateTransition(req(models.StatusPendingSystem), user(uidSysAdmin, models.RoleSystemAdmin), models.ActionApprove, ""); err != nil {
		t.Errorf("コメントなしの承認が拒否された: %v", err)
	}
	if _, err := evaluateTransition(req(models.StatusReturned), user(uidApplicant, models.RoleApplicant), models.ActionResubmit, ""); err != nil {
		t.Errorf("コメントなしの再申請が拒否された: %v", err)
	}
}

func TestEvaluateTransition_未定義のアクションを拒否する(t *testing.T) {
	_, err := evaluateTransition(req(models.StatusPendingSystem), user(uidSysAdmin, models.RoleSystemAdmin), "delete", "")
	if err == nil || err.Code != "invalid_state_transition" {
		t.Errorf("未定義アクションが拒否されなかった: %v", err)
	}
}

// --- resubmitUpdates ------------------------------------------------------

func TestResubmitUpdates(t *testing.T) {
	t.Run("未指定のフィールドは更新対象に含まれない", func(t *testing.T) {
		updates, err := resubmitUpdates(TransitionInput{})
		if err != nil {
			t.Fatalf("予期しないエラー: %v", err)
		}
		if len(updates) != 0 {
			t.Errorf("更新対象: got %d件, want 0件", len(updates))
		}
	})

	t.Run("指定されたフィールドのみ更新対象となる", func(t *testing.T) {
		updates, err := resubmitUpdates(TransitionInput{Title: ptr("新タイトル"), Amount: ptr(int64(500))})
		if err != nil {
			t.Fatalf("予期しないエラー: %v", err)
		}
		if len(updates) != 2 {
			t.Fatalf("更新対象: got %d件, want 2件", len(updates))
		}
		if updates[0].Path != "title" || updates[0].Value != "新タイトル" {
			t.Errorf("title の更新内容が不正: %+v", updates[0])
		}
		if updates[1].Path != "amount" || updates[1].Value != int64(500) {
			t.Errorf("amount の更新内容が不正: %+v", updates[1])
		}
	})

	t.Run("前後の空白を除去する", func(t *testing.T) {
		updates, err := resubmitUpdates(TransitionInput{Title: ptr("  タイトル  ")})
		if err != nil {
			t.Fatalf("予期しないエラー: %v", err)
		}
		if updates[0].Value != "タイトル" {
			t.Errorf("got %q, want %q", updates[0].Value, "タイトル")
		}
	})

	t.Run("空文字や負の金額を拒否する", func(t *testing.T) {
		cases := []struct {
			name string
			in   TransitionInput
		}{
			{"空のタイトル", TransitionInput{Title: ptr("")}},
			{"空白のみのタイトル", TransitionInput{Title: ptr("   ")}},
			{"空の内容", TransitionInput{Content: ptr("")}},
			{"負の金額", TransitionInput{Amount: ptr(int64(-1))}},
		}
		for _, c := range cases {
			if _, err := resubmitUpdates(c.in); err == nil {
				t.Errorf("%s が許可された", c.name)
			} else if err.HTTPStatus != http.StatusBadRequest {
				t.Errorf("%s: got %d, want 400", c.name, err.HTTPStatus)
			}
		}
	})

	t.Run("金額0は有効な値として扱う", func(t *testing.T) {
		updates, err := resubmitUpdates(TransitionInput{Amount: ptr(int64(0))})
		if err != nil {
			t.Fatalf("金額0が拒否された: %v", err)
		}
		if len(updates) != 1 || updates[0].Value != int64(0) {
			t.Errorf("got %+v", updates)
		}
	})
}

// --- CreateInput.validate -------------------------------------------------

func TestCreateInputValidate(t *testing.T) {
	valid := CreateInput{Title: "タイトル", Content: "内容", Amount: 100}
	if err := valid.validate(); err != nil {
		t.Fatalf("正当な入力が拒否された: %v", err)
	}
	if err := (CreateInput{Title: "T", Content: "C", Amount: 0}).validate(); err != nil {
		t.Errorf("金額0が拒否された: %v", err)
	}

	invalid := []struct {
		name string
		in   CreateInput
	}{
		{"タイトルなし", CreateInput{Content: "内容"}},
		{"空白のみのタイトル", CreateInput{Title: "  ", Content: "内容"}},
		{"内容なし", CreateInput{Title: "タイトル"}},
		{"空白のみの内容", CreateInput{Title: "タイトル", Content: "\t"}},
		{"負の金額", CreateInput{Title: "タイトル", Content: "内容", Amount: -1}},
	}
	for _, c := range invalid {
		if err := c.in.validate(); err == nil {
			t.Errorf("%s が許可された", c.name)
		}
	}
}

// --- canView --------------------------------------------------------------

func TestCanView(t *testing.T) {
	logs := []models.AuditLog{
		{RequestID: "r-1", Action: models.ActionApprove, ActorID: uidSysAdmin, Timestamp: time.Now()},
	}

	t.Run("申請者本人は常に閲覧できる", func(t *testing.T) {
		for _, stat := range []string{models.StatusPendingSystem, models.StatusApproved, models.StatusRejected, models.StatusReturned} {
			if !canView(user(uidApplicant, models.RoleApplicant), req(stat), nil) {
				t.Errorf("申請者が自身の稟議(%s)を閲覧できない", stat)
			}
		}
	})

	t.Run("自身の承認待ちの稟議は閲覧できる", func(t *testing.T) {
		if !canView(user(uidProducer, models.RoleProducer), req(models.StatusPendingProducer), nil) {
			t.Error("PDが承認待ちの稟議を閲覧できない")
		}
	})

	t.Run("過去に操作した稟議は閲覧できる", func(t *testing.T) {
		// システム担当は承認済みで担当ステータスから外れているが、履歴に記録がある
		if !canView(user(uidSysAdmin, models.RoleSystemAdmin), req(models.StatusPendingCEO), logs) {
			t.Error("過去に承認した稟議を閲覧できない")
		}
	})

	t.Run("無関係な申請者は他者の稟議を閲覧できない", func(t *testing.T) {
		if canView(user("uid-other", models.RoleApplicant), req(models.StatusPendingSystem), logs) {
			t.Error("他者の稟議が閲覧できてしまう")
		}
	})

	t.Run("担当外かつ未操作の承認者は閲覧できない", func(t *testing.T) {
		// 代表はまだ自分の番が来ておらず、履歴にも記録がない
		if canView(user(uidCEO, models.RoleCEO), req(models.StatusPendingSystem), nil) {
			t.Error("順番が来ていない承認者が閲覧できてしまう")
		}
	})
}
