// Package models は RingiFlow のドメインモデルと状態遷移定義を提供する。
//
// 状態遷移テーブル（Transitions）は基本設計書 3.3節の唯一の実装であり、
// ここに定義のない遷移はすべて拒否される。
package models

import "time"

// ステータス（基本設計書 3.3節）
const (
	StatusPendingSystem   = "pending_system"   // システム担当承認待ち
	StatusPendingProducer = "pending_producer" // プロデューサー承認待ち
	StatusPendingCEO      = "pending_ceo"      // 代表承認待ち
	StatusApproved        = "approved"         // 決裁完了（終端）
	StatusRejected        = "rejected"         // 却下（終端）
	StatusReturned        = "returned"         // 差し戻し
)

// 権限ロール（基本設計書 4.1節）
const (
	RoleApplicant   = "applicant"
	RoleSystemAdmin = "system_admin"
	RoleProducer    = "producer"
	RoleCEO         = "ceo"
)

// 監査ログのアクション（基本設計書 4.1節）
const (
	ActionCreate   = "create"
	ActionApprove  = "approve"
	ActionReject   = "reject"
	ActionReturn   = "return"
	ActionResubmit = "resubmit"
)

// User は users コレクションのドキュメント。ドキュメントIDは Firebase Auth の uid。
type User struct {
	UID        string `firestore:"uid" json:"uid"`
	EmployeeID string `firestore:"employeeId" json:"employeeId"`
	Name       string `firestore:"name" json:"name"`
	Role       string `firestore:"role" json:"role"`
}

// RingiRequest は ringi_requests コレクションのドキュメント。
type RingiRequest struct {
	ID                  string    `firestore:"id" json:"id"`
	Title               string    `firestore:"title" json:"title"`
	Content             string    `firestore:"content" json:"content"`
	Amount              int64     `firestore:"amount" json:"amount"`
	ApplicantID         string    `firestore:"applicantId" json:"applicantId"`
	ApplicantName       string    `firestore:"applicantName" json:"applicantName"`
	ApplicantEmployeeID string    `firestore:"applicantEmployeeId" json:"applicantEmployeeId"`
	Status              string    `firestore:"status" json:"status"`
	CreatedAt           time.Time `firestore:"createdAt" json:"createdAt"`
	UpdatedAt           time.Time `firestore:"updatedAt" json:"updatedAt"`
}

// AuditLog は audit_logs コレクションのドキュメント。
type AuditLog struct {
	RequestID string    `firestore:"requestId" json:"requestId"`
	Action    string    `firestore:"action" json:"action"`
	ActorID   string    `firestore:"actorId" json:"actorId"`
	ActorName string    `firestore:"actorName" json:"actorName"`
	Comment   string    `firestore:"comment" json:"comment"`
	Timestamp time.Time `firestore:"timestamp" json:"timestamp"`
}

// TransitionKey は「現在ステータス」と「アクション」の組。
type TransitionKey struct {
	From   string
	Action string
}

// TransitionRule は遷移の実行条件と結果。
type TransitionRule struct {
	// RequiredRole は遷移に必要な権限ロール。空文字の場合はロールを問わない。
	RequiredRole string
	// RequireOwner が true の場合、操作者が申請者本人であることを要求する。
	RequireOwner bool
	// To は遷移後のステータス。
	To string
	// CommentRequired が true の場合、理由コメントの入力を必須とする。
	CommentRequired bool
}

// Transitions は基本設計書 3.3節の状態遷移表をそのまま表現したもの。
// approved / rejected は終端であり、キーが存在しないためすべての操作が拒否される。
var Transitions = map[TransitionKey]TransitionRule{
	// システム担当承認待ち
	{StatusPendingSystem, ActionApprove}: {RequiredRole: RoleSystemAdmin, To: StatusPendingProducer},
	{StatusPendingSystem, ActionReturn}:  {RequiredRole: RoleSystemAdmin, To: StatusReturned, CommentRequired: true},
	{StatusPendingSystem, ActionReject}:  {RequiredRole: RoleSystemAdmin, To: StatusRejected, CommentRequired: true},

	// プロデューサー承認待ち
	{StatusPendingProducer, ActionApprove}: {RequiredRole: RoleProducer, To: StatusPendingCEO},
	{StatusPendingProducer, ActionReturn}:  {RequiredRole: RoleProducer, To: StatusReturned, CommentRequired: true},
	{StatusPendingProducer, ActionReject}:  {RequiredRole: RoleProducer, To: StatusRejected, CommentRequired: true},

	// 代表承認待ち
	{StatusPendingCEO, ActionApprove}: {RequiredRole: RoleCEO, To: StatusApproved},
	{StatusPendingCEO, ActionReturn}:  {RequiredRole: RoleCEO, To: StatusReturned, CommentRequired: true},
	{StatusPendingCEO, ActionReject}:  {RequiredRole: RoleCEO, To: StatusRejected, CommentRequired: true},

	// 差し戻し → 再申請（ロールではなく申請者本人であることを条件とする）
	{StatusReturned, ActionResubmit}: {RequireOwner: true, To: StatusPendingSystem},
}

// PendingStatusForRole は、そのロールが承認すべきステータスを返す。
// 承認権限を持たないロールの場合は空文字と false を返す。
func PendingStatusForRole(role string) (string, bool) {
	switch role {
	case RoleSystemAdmin:
		return StatusPendingSystem, true
	case RoleProducer:
		return StatusPendingProducer, true
	case RoleCEO:
		return StatusPendingCEO, true
	default:
		return "", false
	}
}

// IsValidRole は role が定義済みのロールかを判定する。
func IsValidRole(role string) bool {
	switch role {
	case RoleApplicant, RoleSystemAdmin, RoleProducer, RoleCEO:
		return true
	}
	return false
}
