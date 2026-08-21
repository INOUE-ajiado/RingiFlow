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

// req は代表決裁を要する金額（閾値以上）の稟議を返す。
// 金額によって承認ルートが変わるため、既定は最長ルートとする。
func req(stat string) *models.RingiRequest {
	return reqAmount(stat, 250000)
}

// reqAmount は金額を指定した稟議を返す。
func reqAmount(stat string, amount int64) *models.RingiRequest {
	return &models.RingiRequest{
		ID:          "r-1",
		Title:       "テスト稟議",
		Content:     "内容",
		Amount:      amount,
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
			to, err := evaluateTransition(req(c.status), c.actor, c.action, c.comment)
			if err != nil {
				t.Fatalf("予期しないエラー: %v", err)
			}
			if to != c.wantTo {
				t.Errorf("遷移先: got %q, want %q", to, c.wantTo)
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

// --- マスターロール（テスト運用専用） -------------------------------------

func TestEvaluateTransition_マスターは全工程を操作できる(t *testing.T) {
	master := user("uid-master", models.RoleMaster)
	cases := []struct {
		status  string
		action  string
		comment string
		wantTo  string
	}{
		{models.StatusPendingSystem, models.ActionApprove, "", models.StatusPendingProducer},
		{models.StatusPendingProducer, models.ActionApprove, "", models.StatusPendingCEO},
		{models.StatusPendingCEO, models.ActionApprove, "", models.StatusApproved},
		{models.StatusPendingSystem, models.ActionReturn, "理由", models.StatusReturned},
		{models.StatusPendingCEO, models.ActionReject, "理由", models.StatusRejected},
		{models.StatusReturned, models.ActionResubmit, "", models.StatusPendingSystem},
	}
	for _, c := range cases {
		to, err := evaluateTransition(req(c.status), master, c.action, c.comment)
		if err != nil {
			t.Errorf("%s + %s が拒否された: %v", c.status, c.action, err)
			continue
		}
		if to != c.wantTo {
			t.Errorf("%s + %s: got %q, want %q", c.status, c.action, to, c.wantTo)
		}
	}
}

// マスターであっても状態遷移表そのものは迂回しない。
func TestEvaluateTransition_マスターでも終端ステータスは操作できない(t *testing.T) {
	master := user("uid-master", models.RoleMaster)
	for _, stat := range []string{models.StatusApproved, models.StatusRejected} {
		for _, action := range []string{models.ActionApprove, models.ActionReject, models.ActionReturn, models.ActionResubmit} {
			if _, err := evaluateTransition(req(stat), master, action, "コメント"); err == nil {
				t.Errorf("マスターが %s に対して %s を実行できてしまう", stat, action)
			}
		}
	}
}

// コメント必須は権限ではなく業務ルールのため、マスターにも適用される。
func TestEvaluateTransition_マスターにもコメント必須が適用される(t *testing.T) {
	master := user("uid-master", models.RoleMaster)
	for _, action := range []string{models.ActionReturn, models.ActionReject} {
		_, err := evaluateTransition(req(models.StatusPendingSystem), master, action, "")
		if err == nil {
			t.Errorf("マスターがコメントなしで %s を実行できてしまう", action)
			continue
		}
		if err.Code != "comment_required" {
			t.Errorf("%s: got %s, want comment_required", action, err.Code)
		}
	}
}

func TestCanView_マスターは全件閲覧できる(t *testing.T) {
	master := user("uid-master", models.RoleMaster)
	for _, stat := range []string{
		models.StatusPendingSystem, models.StatusPendingProducer, models.StatusPendingCEO,
		models.StatusApproved, models.StatusRejected, models.StatusReturned,
	} {
		// 申請者が別人（uidApplicant）の稟議でも閲覧できる
		if !canView(master, req(stat), nil) {
			t.Errorf("マスターが %s の稟議を閲覧できない", stat)
		}
	}
}

// --- 取り下げ -------------------------------------------------------------

func TestEvaluateTransition_取り下げは申請者本人のみ(t *testing.T) {
	owner := user(uidApplicant, models.RoleApplicant)
	for _, from := range []string{
		models.StatusPendingSystem, models.StatusPendingProducer,
		models.StatusPendingCEO, models.StatusReturned,
	} {
		to, err := evaluateTransition(req(from), owner, models.ActionWithdraw, "")
		if err != nil {
			t.Errorf("%s からの取り下げが拒否された: %v", from, err)
			continue
		}
		if to != models.StatusWithdrawn {
			t.Errorf("%s: got %q, want withdrawn", from, to)
		}

		// 他人は取り下げられない
		if _, err := evaluateTransition(req(from), user("uid-other", models.RoleApplicant), models.ActionWithdraw, ""); err == nil {
			t.Errorf("%s で他人による取り下げが許可された", from)
		}
		// 承認者であっても本人でなければ取り下げられない
		if _, err := evaluateTransition(req(from), user(uidCEO, models.RoleCEO), models.ActionWithdraw, ""); err == nil {
			t.Errorf("%s で代表による他人の稟議の取り下げが許可された", from)
		}
	}
}

func TestEvaluateTransition_取り下げ後は操作できない(t *testing.T) {
	owner := user(uidApplicant, models.RoleApplicant)
	for _, action := range []string{
		models.ActionApprove, models.ActionReject, models.ActionReturn,
		models.ActionResubmit, models.ActionWithdraw,
	} {
		if _, err := evaluateTransition(req(models.StatusWithdrawn), owner, action, "コメント"); err == nil {
			t.Errorf("取り下げ済みの稟議に対する %s が許可された", action)
		}
	}
	// マスターであっても同様
	if _, err := evaluateTransition(req(models.StatusWithdrawn), user("uid-master", models.RoleMaster), models.ActionApprove, ""); err == nil {
		t.Error("マスターが取り下げ済みの稟議を承認できてしまう")
	}
}

func TestEvaluateTransition_決裁済みは取り下げられない(t *testing.T) {
	owner := user(uidApplicant, models.RoleApplicant)
	for _, from := range []string{models.StatusApproved, models.StatusRejected} {
		if _, err := evaluateTransition(req(from), owner, models.ActionWithdraw, ""); err == nil {
			t.Errorf("%s の稟議が取り下げられてしまう", from)
		}
	}
}

// --- 金額による承認ルート分岐 ---------------------------------------------

func TestEvaluateTransition_少額はプロデューサー決裁で完了する(t *testing.T) {
	const small = models.CEOApprovalThreshold - 1

	to, err := evaluateTransition(reqAmount(models.StatusPendingSystem, small),
		user(uidSysAdmin, models.RoleSystemAdmin), models.ActionApprove, "")
	if err != nil {
		t.Fatalf("システム担当の承認が拒否された: %v", err)
	}
	if to != models.StatusPendingProducer {
		t.Errorf("got %q, want %q", to, models.StatusPendingProducer)
	}

	// プロデューサーの承認で決裁完了となり、代表を経由しない
	to, err = evaluateTransition(reqAmount(models.StatusPendingProducer, small),
		user(uidProducer, models.RoleProducer), models.ActionApprove, "")
	if err != nil {
		t.Fatalf("PDの承認が拒否された: %v", err)
	}
	if to != models.StatusApproved {
		t.Errorf("少額案件がPD承認で完了しない: got %q, want %q", to, models.StatusApproved)
	}
}

func TestEvaluateTransition_閾値以上は代表決裁を経由する(t *testing.T) {
	const large = models.CEOApprovalThreshold

	to, err := evaluateTransition(reqAmount(models.StatusPendingProducer, large),
		user(uidProducer, models.RoleProducer), models.ActionApprove, "")
	if err != nil {
		t.Fatalf("PDの承認が拒否された: %v", err)
	}
	if to != models.StatusPendingCEO {
		t.Errorf("got %q, want %q", to, models.StatusPendingCEO)
	}

	to, err = evaluateTransition(reqAmount(models.StatusPendingCEO, large),
		user(uidCEO, models.RoleCEO), models.ActionApprove, "")
	if err != nil {
		t.Fatalf("代表の承認が拒否された: %v", err)
	}
	if to != models.StatusApproved {
		t.Errorf("got %q, want %q", to, models.StatusApproved)
	}
}

// 閾値ちょうどの金額は代表決裁を要する（以上／未満の境界）。
func TestEvaluateTransition_閾値の境界(t *testing.T) {
	cases := []struct {
		amount int64
		wantTo string
	}{
		{models.CEOApprovalThreshold - 1, models.StatusApproved},
		{models.CEOApprovalThreshold, models.StatusPendingCEO},
		{models.CEOApprovalThreshold + 1, models.StatusPendingCEO},
		{0, models.StatusApproved},
	}
	for _, c := range cases {
		to, err := evaluateTransition(reqAmount(models.StatusPendingProducer, c.amount),
			user(uidProducer, models.RoleProducer), models.ActionApprove, "")
		if err != nil {
			t.Errorf("金額 %d が拒否された: %v", c.amount, err)
			continue
		}
		if to != c.wantTo {
			t.Errorf("金額 %d: got %q, want %q", c.amount, to, c.wantTo)
		}
	}
}

// 差し戻し後に金額を修正した場合、修正後の金額でルートが決まる。
func TestEvaluateTransition_再申請後の金額でルートが決まる(t *testing.T) {
	// 高額で申請 → 差し戻し → 少額に修正して再申請したケースを想定し、
	// PD承認時点の金額が少額であれば代表を経由せず完了する。
	to, err := evaluateTransition(reqAmount(models.StatusPendingProducer, 50000),
		user(uidProducer, models.RoleProducer), models.ActionApprove, "")
	if err != nil {
		t.Fatalf("拒否された: %v", err)
	}
	if to != models.StatusApproved {
		t.Errorf("減額後もCEOを経由している: got %q", to)
	}
}

// 金額を減額したことで代表承認待ちがルート外になった稟議は、
// 不整合として拒否し、勝手に決裁完了させない。
func TestEvaluateTransition_ルート外のステータスは拒否する(t *testing.T) {
	_, err := evaluateTransition(reqAmount(models.StatusPendingCEO, 1000),
		user(uidCEO, models.RoleCEO), models.ActionApprove, "")
	if err == nil {
		t.Fatal("ルート外の承認が許可された")
	}
	if err.Code != "invalid_state_transition" {
		t.Errorf("got %s, want invalid_state_transition", err.Code)
	}
}

// 承認以外の遷移は金額の影響を受けない。
func TestEvaluateTransition_差し戻しと却下は金額に依存しない(t *testing.T) {
	for _, amount := range []int64{0, models.CEOApprovalThreshold - 1, models.CEOApprovalThreshold} {
		to, err := evaluateTransition(reqAmount(models.StatusPendingProducer, amount),
			user(uidProducer, models.RoleProducer), models.ActionReturn, "理由")
		if err != nil || to != models.StatusReturned {
			t.Errorf("金額 %d の差し戻し: got %q, err=%v", amount, to, err)
		}
		to, err = evaluateTransition(reqAmount(models.StatusPendingProducer, amount),
			user(uidProducer, models.RoleProducer), models.ActionReject, "理由")
		if err != nil || to != models.StatusRejected {
			t.Errorf("金額 %d の却下: got %q, err=%v", amount, to, err)
		}
	}
}
