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
	StatusWithdrawn       = "withdrawn"        // 取り下げ（終端）
)

// PendingStatuses は承認待ちのステータス一覧（決裁の進行中を表す）。
var PendingStatuses = []string{StatusPendingSystem, StatusPendingProducer, StatusPendingCEO}

// 権限ロール（基本設計書 4.1節）
const (
	RoleApplicant   = "applicant"
	RoleSystemAdmin = "system_admin"
	RoleProducer    = "producer"
	RoleCEO         = "ceo"

	// RoleMaster は全工程を単独で操作できるテスト運用専用のロール。
	//
	// 本システムは当面スタンドアロンのテストシステムとして運用し、認証・権限は
	// 統合先システムから受け取る想定である。それまでの間、承認フローの構造を
	// 検証できるようマスターユーザー1名で全ロールの操作を代行する。
	//
	// 状態遷移表（Transitions）自体は変更せず、ロール判定のみを迂回する設計と
	// しているため、統合時は本ロールの付与をやめるだけで通常の権限制御に戻る。
	RoleMaster = "master"
)

// 監査ログのアクション（基本設計書 4.1節）
const (
	ActionCreate   = "create"
	ActionApprove  = "approve"
	ActionReject   = "reject"
	ActionReturn   = "return"
	ActionResubmit = "resubmit"
	ActionWithdraw = "withdraw"
	ActionAttach   = "attach"
	ActionDetach   = "detach"
)

// User は users コレクションのドキュメント。ドキュメントIDは Firebase Auth の uid。
type User struct {
	UID        string `firestore:"uid" json:"uid"`
	EmployeeID string `firestore:"employeeId" json:"employeeId"`
	Name       string `firestore:"name" json:"name"`
	Role       string `firestore:"role" json:"role"`
	// Department は所属部門。稟議書の「所属」欄に表示する。
	Department string `firestore:"department" json:"department"`
}

// RingiRequest は ringi_requests コレクションのドキュメント。
type RingiRequest struct {
	ID string `firestore:"id" json:"id"`
	// RequestNo は人が読める稟議番号（例: R-2026-0001）。
	// 申請と同一トランザクション内でカウンタを採番するため重複しない。
	RequestNo           string `firestore:"requestNo" json:"requestNo"`
	Title               string `firestore:"title" json:"title"`
	Content             string `firestore:"content" json:"content"`
	Amount              int64  `firestore:"amount" json:"amount"`
	ApplicantID         string `firestore:"applicantId" json:"applicantId"`
	ApplicantName       string `firestore:"applicantName" json:"applicantName"`
	ApplicantEmployeeID string `firestore:"applicantEmployeeId" json:"applicantEmployeeId"`
	// Department は申請時点の申請者の所属部門。異動後も当時の記録を残すため
	// 参照ではなく値をコピーして保持する。
	Department string `firestore:"department" json:"department"`
	// DueDate は決裁希望日（任意）。日付のみを扱い、時刻は使わない。
	DueDate *time.Time `firestore:"dueDate" json:"dueDate"`
	// Summary は「概要」欄の項目。品名・予算・購入先のように、
	// 稟議の種類ごとに必要な項目が変わるため固定のフィールドを持たず、
	// ラベルと値の並びとして扱う。
	Summary []SummaryItem `firestore:"summary" json:"summary"`
	Status  string        `firestore:"status" json:"status"`
	// Attachments は添付ファイルの一覧。実体は Cloud Storage に置き、
	// ここにはメタデータのみを保持する。
	Attachments []Attachment `firestore:"attachments" json:"attachments"`
	CreatedAt   time.Time    `firestore:"createdAt" json:"createdAt"`
	UpdatedAt   time.Time    `firestore:"updatedAt" json:"updatedAt"`
}

// AuditLog は audit_logs コレクションのドキュメント。
type AuditLog struct {
	RequestID string    `firestore:"requestId" json:"requestId"`
	Action    string    `firestore:"action" json:"action"`
	ActorID   string    `firestore:"actorId" json:"actorId"`
	ActorName string    `firestore:"actorName" json:"actorName"`
	Comment   string    `firestore:"comment" json:"comment"`
	Timestamp time.Time `firestore:"timestamp" json:"timestamp"`
	// Changes は再申請時に変更された項目。差し戻した承認者が
	// 「指摘した点が直っているか」を履歴だけで判断できるようにする。
	Changes []FieldChange `firestore:"changes" json:"changes"`
}

// 変更を記録する対象のフィールド名。
const (
	FieldTitle   = "title"
	FieldContent = "content"
	FieldAmount  = "amount"
	FieldDueDate = "dueDate"
	FieldSummary = "summary"
)

// FieldChange は1項目の変更内容。表示用のラベルはフロントエンドが
// Field の値から解決するため、ここでは持たない。
type FieldChange struct {
	Field  string `firestore:"field" json:"field"`
	Before string `firestore:"before" json:"before"`
	After  string `firestore:"after" json:"after"`
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

	// 取り下げ。決裁が確定する前であれば、申請者本人がいつでも取り下げられる。
	// 承認者による却下（rejected）とは区別し、終端ステータス withdrawn へ遷移する。
	{StatusPendingSystem, ActionWithdraw}:   {RequireOwner: true, To: StatusWithdrawn},
	{StatusPendingProducer, ActionWithdraw}: {RequireOwner: true, To: StatusWithdrawn},
	{StatusPendingCEO, ActionWithdraw}:      {RequireOwner: true, To: StatusWithdrawn},
	{StatusReturned, ActionWithdraw}:        {RequireOwner: true, To: StatusWithdrawn},
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
	case RoleApplicant, RoleSystemAdmin, RoleProducer, RoleCEO, RoleMaster:
		return true
	}
	return false
}

// IsMaster は全工程を操作できるテスト運用専用ロールかを判定する。
func IsMaster(role string) bool {
	return role == RoleMaster
}

// IsValidStatus は status が定義済みのステータスかを判定する。
func IsValidStatus(status string) bool {
	switch status {
	case StatusPendingSystem, StatusPendingProducer, StatusPendingCEO,
		StatusApproved, StatusRejected, StatusReturned, StatusWithdrawn:
		return true
	}
	return false
}

// Attachment は稟議に添付されたファイルのメタデータ。
// 実体は Cloud Storage の StoragePath に置かれる。
type Attachment struct {
	ID          string `firestore:"id" json:"id"`
	FileName    string `firestore:"fileName" json:"fileName"`
	ContentType string `firestore:"contentType" json:"contentType"`
	Size        int64  `firestore:"size" json:"size"`
	// StoragePath は Cloud Storage 上の位置。クライアントへは公開しない。
	StoragePath    string    `firestore:"storagePath" json:"-"`
	UploadedBy     string    `firestore:"uploadedBy" json:"uploadedBy"`
	UploadedByName string    `firestore:"uploadedByName" json:"uploadedByName"`
	UploadedAt     time.Time `firestore:"uploadedAt" json:"uploadedAt"`
}

// IsTerminal は決裁が確定し、以降の操作ができないステータスかを判定する。
func IsTerminal(status string) bool {
	return status == StatusApproved || status == StatusRejected || status == StatusWithdrawn
}

// CEOApprovalThreshold は代表決裁を要する金額の下限（円）。
//
// この金額未満の稟議はプロデューサーの承認をもって決裁完了とし、
// 代表の承認を経由しない。少額案件が代表に滞留するのを避けるための規定。
const CEOApprovalThreshold int64 = 100000

// ApprovalRoute は金額に応じた承認ステップの並びを返す。
//
// 金額は再申請時に変更されうるため、ルートは固定値として保持せず
// 承認のたびにその時点の金額から求める。これにより差し戻し後に
// 金額を修正した場合も、修正後の金額に応じたルートが適用される。
func ApprovalRoute(amount int64) []string {
	if amount >= CEOApprovalThreshold {
		return []string{StatusPendingSystem, StatusPendingProducer, StatusPendingCEO}
	}
	return []string{StatusPendingSystem, StatusPendingProducer}
}

// NextAfterApprove は承認後のステータスを返す。
// 現在が最終承認ステップの場合は決裁完了（approved）となる。
// current がそのルート上に存在しない場合は false を返す。
func NextAfterApprove(current string, amount int64) (string, bool) {
	route := ApprovalRoute(amount)
	for i, step := range route {
		if step != current {
			continue
		}
		if i == len(route)-1 {
			return StatusApproved, true
		}
		return route[i+1], true
	}
	return "", false
}

// RequiresCEOApproval は代表決裁を要する金額かを判定する。
func RequiresCEOApproval(amount int64) bool {
	return amount >= CEOApprovalThreshold
}

// SummaryItem は「概要」欄の1項目。
type SummaryItem struct {
	Label string `firestore:"label" json:"label"`
	Value string `firestore:"value" json:"value"`
}

// 概要欄の制限。
const (
	MaxSummaryItems      = 10
	MaxSummaryLabelRunes = 20
	MaxSummaryValueRunes = 200
)
