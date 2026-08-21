package models

import "testing"

// TestTransitionsMatchesDesign は、状態遷移テーブルが基本設計書 3.3節の
// 状態遷移表と完全に一致することを検証する。
// 設計書の表を変更した場合はこのテストも同時に更新すること。
func TestTransitionsMatchesDesign(t *testing.T) {
	want := map[TransitionKey]TransitionRule{
		{StatusPendingSystem, ActionApprove}: {RequiredRole: RoleSystemAdmin, To: StatusPendingProducer},
		{StatusPendingSystem, ActionReturn}:  {RequiredRole: RoleSystemAdmin, To: StatusReturned, CommentRequired: true},
		{StatusPendingSystem, ActionReject}:  {RequiredRole: RoleSystemAdmin, To: StatusRejected, CommentRequired: true},

		{StatusPendingProducer, ActionApprove}: {RequiredRole: RoleProducer, To: StatusPendingCEO},
		{StatusPendingProducer, ActionReturn}:  {RequiredRole: RoleProducer, To: StatusReturned, CommentRequired: true},
		{StatusPendingProducer, ActionReject}:  {RequiredRole: RoleProducer, To: StatusRejected, CommentRequired: true},

		{StatusPendingCEO, ActionApprove}: {RequiredRole: RoleCEO, To: StatusApproved},
		{StatusPendingCEO, ActionReturn}:  {RequiredRole: RoleCEO, To: StatusReturned, CommentRequired: true},
		{StatusPendingCEO, ActionReject}:  {RequiredRole: RoleCEO, To: StatusRejected, CommentRequired: true},

		{StatusReturned, ActionResubmit}: {RequireOwner: true, To: StatusPendingSystem},

		{StatusPendingSystem, ActionWithdraw}:   {RequireOwner: true, To: StatusWithdrawn},
		{StatusPendingProducer, ActionWithdraw}: {RequireOwner: true, To: StatusWithdrawn},
		{StatusPendingCEO, ActionWithdraw}:      {RequireOwner: true, To: StatusWithdrawn},
		{StatusReturned, ActionWithdraw}:        {RequireOwner: true, To: StatusWithdrawn},
	}

	if len(Transitions) != len(want) {
		t.Fatalf("遷移数が一致しません: got %d, want %d", len(Transitions), len(want))
	}
	for key, wantRule := range want {
		gotRule, ok := Transitions[key]
		if !ok {
			t.Errorf("遷移が定義されていません: %s + %s", key.From, key.Action)
			continue
		}
		if gotRule != wantRule {
			t.Errorf("遷移 %s + %s: got %+v, want %+v", key.From, key.Action, gotRule, wantRule)
		}
	}
}

// TestTerminalStatusesHaveNoTransitions は approved / rejected / withdrawn が終端であり、
// いかなる操作も受け付けないことを検証する。
func TestTerminalStatusesHaveNoTransitions(t *testing.T) {
	actions := []string{ActionApprove, ActionReject, ActionReturn, ActionResubmit, ActionCreate, ActionWithdraw}
	for _, terminal := range []string{StatusApproved, StatusRejected, StatusWithdrawn} {
		for _, action := range actions {
			if _, ok := Transitions[TransitionKey{From: terminal, Action: action}]; ok {
				t.Errorf("終端ステータス %s に遷移 %s が定義されています", terminal, action)
			}
		}
	}
}

// TestReturnedAcceptsOnlyResubmit は差し戻し状態から実行できるのが
// 申請者本人による再申請と取り下げのみであることを検証する。
func TestReturnedAcceptsOnlyResubmit(t *testing.T) {
	for _, action := range []string{ActionApprove, ActionReject, ActionReturn} {
		if _, ok := Transitions[TransitionKey{From: StatusReturned, Action: action}]; ok {
			t.Errorf("returned から %s が実行可能になっています", action)
		}
	}
	rule, ok := Transitions[TransitionKey{From: StatusReturned, Action: ActionResubmit}]
	if !ok {
		t.Fatal("returned + resubmit が定義されていません")
	}
	if !rule.RequireOwner {
		t.Error("再申請は申請者本人のみに限定されている必要があります")
	}
	if rule.RequiredRole != "" {
		t.Errorf("再申請はロールで判定してはいけません: got %q", rule.RequiredRole)
	}
}

// TestApproverRolesRequireComment は差し戻し・却下でコメントが必須であり、
// 承認では任意であることを検証する（基本設計書 5.1節）。
func TestCommentRequirement(t *testing.T) {
	for key, rule := range Transitions {
		switch key.Action {
		case ActionReturn, ActionReject:
			if !rule.CommentRequired {
				t.Errorf("%s + %s はコメント必須である必要があります", key.From, key.Action)
			}
		case ActionApprove, ActionResubmit:
			if rule.CommentRequired {
				t.Errorf("%s + %s のコメントは任意である必要があります", key.From, key.Action)
			}
		}
	}
}

func TestPendingStatusForRole(t *testing.T) {
	cases := []struct {
		role       string
		wantStatus string
		wantOK     bool
	}{
		{RoleSystemAdmin, StatusPendingSystem, true},
		{RoleProducer, StatusPendingProducer, true},
		{RoleCEO, StatusPendingCEO, true},
		{RoleApplicant, "", false},
		{"unknown", "", false},
	}
	for _, c := range cases {
		gotStatus, gotOK := PendingStatusForRole(c.role)
		if gotStatus != c.wantStatus || gotOK != c.wantOK {
			t.Errorf("PendingStatusForRole(%q) = (%q, %v), want (%q, %v)",
				c.role, gotStatus, gotOK, c.wantStatus, c.wantOK)
		}
	}
}

// TestWithdrawTransitions は取り下げが決裁確定前のすべての状態から
// 申請者本人のみによって実行できることを検証する。
func TestWithdrawTransitions(t *testing.T) {
	// 決裁確定前の状態からは取り下げられる
	for _, from := range []string{StatusPendingSystem, StatusPendingProducer, StatusPendingCEO, StatusReturned} {
		rule, ok := Transitions[TransitionKey{From: from, Action: ActionWithdraw}]
		if !ok {
			t.Errorf("%s から取り下げできません", from)
			continue
		}
		if rule.To != StatusWithdrawn {
			t.Errorf("%s の取り下げ先: got %q, want %q", from, rule.To, StatusWithdrawn)
		}
		if !rule.RequireOwner {
			t.Errorf("%s の取り下げが申請者本人に限定されていません", from)
		}
		if rule.RequiredRole != "" {
			t.Errorf("%s の取り下げはロールで判定してはいけません: got %q", from, rule.RequiredRole)
		}
		if rule.CommentRequired {
			t.Errorf("%s の取り下げのコメントは任意である必要があります", from)
		}
	}
}
