// Package services は稟議の作成・状態遷移・取得に関するビジネスロジックを提供する。
//
// 状態を変更する操作はすべて Firestore のトランザクション内で行い、
// 「対象ドキュメントの読み取り → 状態遷移表による検証 → 更新 → 監査ログ追加」を
// 不可分に実行する（基本設計書 5.2節）。これにより複数の承認者が同時に操作した場合でも
// データの不整合が発生しない。
package services

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"slices"
	"strings"
	"time"

	"cloud.google.com/go/firestore"
	"google.golang.org/api/iterator"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/INOUE-ajiado/RingiFlow/backend-go/models"
)

const (
	collectionRingi    = "ringi_requests"
	collectionLogs     = "audit_logs"
	collectionCounters = "counters"

	// listLimit は一覧取得の最大件数。
	// 上限に達した場合は結果を打ち切るが、呼び出し元へ truncated を返して
	// 「該当なし」と誤認されないようにする。
	listLimit = 200
)

// jst は稟議番号の年度判定に用いる日本時間。
var jst = time.FixedZone("JST", 9*60*60)

// RingiService は稟議に関するユースケースを実装する。
type RingiService struct {
	fs *firestore.Client
}

// NewRingiService は RingiService を生成する。
func NewRingiService(fs *firestore.Client) *RingiService {
	return &RingiService{fs: fs}
}

// CreateInput は新規申請の入力。
type CreateInput struct {
	Title   string `json:"title"`
	Content string `json:"content"`
	Amount  int64  `json:"amount"`
}

func (in CreateInput) validate() *Error {
	if strings.TrimSpace(in.Title) == "" {
		return newError(http.StatusBadRequest, "invalid_argument", "タイトルを入力してください。")
	}
	if strings.TrimSpace(in.Content) == "" {
		return newError(http.StatusBadRequest, "invalid_argument", "申請内容を入力してください。")
	}
	if in.Amount < 0 {
		return newError(http.StatusBadRequest, "invalid_argument", "金額には0以上の値を指定してください。")
	}
	return nil
}

// Create は新規稟議を作成し、ステータスを pending_system に設定する（基本設計書 3.1 Step3）。
// 稟議ドキュメントと監査ログを同一トランザクションで書き込む。
func (s *RingiService) Create(ctx context.Context, actor *models.User, in CreateInput) (*models.RingiRequest, error) {
	if err := in.validate(); err != nil {
		return nil, err
	}

	now := time.Now().UTC()
	docRef := s.fs.Collection(collectionRingi).NewDoc()

	req := &models.RingiRequest{
		ID:                  docRef.ID,
		Title:               strings.TrimSpace(in.Title),
		Content:             strings.TrimSpace(in.Content),
		Amount:              in.Amount,
		ApplicantID:         actor.UID,
		ApplicantName:       actor.Name,
		ApplicantEmployeeID: actor.EmployeeID,
		Status:              models.StatusPendingSystem,
		CreatedAt:           now,
		UpdatedAt:           now,
	}

	err := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		// 採番はドキュメント作成と同一トランザクション内で行う。
		// Firestore のトランザクションは読み取りをすべて書き込みより先に実行する
		// 必要があるため、ここでカウンタを読んでから各ドキュメントを書き込む。
		requestNo, counterRef, next, err := s.nextRequestNo(tx, now)
		if err != nil {
			return err
		}
		req.RequestNo = requestNo

		if err := tx.Set(counterRef, map[string]any{"value": next}); err != nil {
			return err
		}
		if err := tx.Create(docRef, req); err != nil {
			return err
		}
		return tx.Create(s.fs.Collection(collectionLogs).NewDoc(), &models.AuditLog{
			RequestID: docRef.ID,
			Action:    models.ActionCreate,
			ActorID:   actor.UID,
			ActorName: actor.Name,
			Comment:   "",
			Timestamp: now,
		})
	})
	if err != nil {
		log.Printf("create ringi failed: %v", err)
		return nil, errInternal()
	}
	return req, nil
}

// nextRequestNo は年度ごとのカウンタから次の稟議番号を求める。
//
// 同時申請が発生した場合、カウンタドキュメントの読み取りが競合するため
// Firestore がトランザクションを再試行する。これにより番号は重複しない。
func (s *RingiService) nextRequestNo(tx *firestore.Transaction, now time.Time) (string, *firestore.DocumentRef, int64, error) {
	year := now.In(jst).Year()
	counterRef := s.fs.Collection(collectionCounters).Doc(fmt.Sprintf("ringi_%d", year))

	var next int64 = 1
	snap, err := tx.Get(counterRef)
	switch {
	case err == nil:
		if v, err := snap.DataAt("value"); err == nil {
			if current, ok := v.(int64); ok {
				next = current + 1
			}
		}
	case status.Code(err) == codes.NotFound:
		// その年の最初の申請。next は 1 のまま。
	default:
		return "", nil, 0, err
	}

	return fmt.Sprintf("R-%d-%04d", year, next), counterRef, next, nil
}

// TransitionInput は状態遷移操作の入力。
type TransitionInput struct {
	Comment string `json:"comment"`
	// 以下は再申請（resubmit）時のみ有効。空の場合は既存の値を維持する。
	Title   *string `json:"title,omitempty"`
	Content *string `json:"content,omitempty"`
	Amount  *int64  `json:"amount,omitempty"`
}

// TransitionResult は状態遷移の結果。
type TransitionResult struct {
	RequestID string    `json:"requestId"`
	NewStatus string    `json:"newStatus"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// Transition は承認・差し戻し・却下・再申請を実行する（基本設計書 5.2節）。
//
// 遷移の可否は models.Transitions（設計書 3.3節の状態遷移表）のみを判定基準とし、
// 表に定義のない遷移はすべて 409 で拒否する。
func (s *RingiService) Transition(ctx context.Context, actor *models.User, id, action string, in TransitionInput) (*TransitionResult, error) {
	docRef := s.fs.Collection(collectionRingi).Doc(id)
	now := time.Now().UTC()

	var result *TransitionResult

	err := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		// Step 3: 対象ドキュメントの取得
		snap, err := tx.Get(docRef)
		if err != nil {
			if status.Code(err) == codes.NotFound {
				return errNotFound()
			}
			return err
		}

		var req models.RingiRequest
		if err := snap.DataTo(&req); err != nil {
			return err
		}

		// Step 4: 状態遷移表による権限・ステータス整合性チェック
		rule, appErr := evaluateTransition(&req, actor, action, in.Comment)
		if appErr != nil {
			return appErr
		}
		comment := strings.TrimSpace(in.Comment)

		// Step 5-6: 次ステータスの決定と更新
		updates := []firestore.Update{
			{Path: "status", Value: rule.To},
			{Path: "updatedAt", Value: now},
		}
		// 再申請時は申請内容の修正を許可する（基本設計書 3.2 Step3）。
		if action == models.ActionResubmit {
			edits, appErr := resubmitUpdates(in)
			if appErr != nil {
				return appErr
			}
			updates = append(updates, edits...)
		}
		if err := tx.Update(docRef, updates); err != nil {
			return err
		}

		// Step 7: 同一トランザクション内での監査ログ追加
		if err := tx.Create(s.fs.Collection(collectionLogs).NewDoc(), &models.AuditLog{
			RequestID: id,
			Action:    action,
			ActorID:   actor.UID,
			ActorName: actor.Name,
			Comment:   comment,
			Timestamp: now,
		}); err != nil {
			return err
		}

		result = &TransitionResult{RequestID: id, NewStatus: rule.To, UpdatedAt: now}
		return nil
	})

	// Step 8: コミット結果の判定
	if err != nil {
		var appErr *Error
		if errors.As(err, &appErr) {
			return nil, appErr
		}
		log.Printf("transition %s on %s failed: %v", action, id, err)
		return nil, errInternal()
	}
	return result, nil
}

// evaluateTransition は状態遷移表に基づいて操作の可否を判定する。
//
// Firestore に依存しない純粋関数として切り出しているのは、承認フローの正しさを
// 左右する最も重要な判定であり、単体テストで網羅的に検証できるようにするため。
// 判定順序は「遷移の存在 → 本人確認 → ロール確認 → コメント必須」の順とする。
func evaluateTransition(req *models.RingiRequest, actor *models.User, action, comment string) (models.TransitionRule, *Error) {
	rule, ok := models.Transitions[models.TransitionKey{From: req.Status, Action: action}]
	if !ok {
		return rule, newError(http.StatusConflict, "invalid_state_transition",
			"現在のステータスではこの操作を実行できません。他の承認者によって既に処理された可能性があります。")
	}

	// マスターロールは担当者判定のみを迂回する。状態遷移表そのものは迂回しないため、
	// 終端ステータスへの操作や未定義の遷移は引き続き拒否される。
	if !models.IsMaster(actor.Role) {
		if rule.RequireOwner && req.ApplicantID != actor.UID {
			return rule, newError(http.StatusConflict, "permission_denied",
				"この操作は申請者本人のみが実行できます。")
		}
		if rule.RequiredRole != "" && rule.RequiredRole != actor.Role {
			return rule, newError(http.StatusConflict, "permission_denied",
				"この稟議を処理する権限がありません。")
		}
	}

	// コメント必須は権限ではなく業務ルールのため、マスターにも適用する。
	if rule.CommentRequired && strings.TrimSpace(comment) == "" {
		return rule, newError(http.StatusBadRequest, "comment_required",
			"理由コメントの入力は必須です。")
	}
	return rule, nil
}

// resubmitUpdates は再申請時に指定された申請内容の修正を検証し、
// 更新対象のフィールドを返す。nil のフィールドは既存の値を維持する。
func resubmitUpdates(in TransitionInput) ([]firestore.Update, *Error) {
	updates := make([]firestore.Update, 0, 3)
	if in.Title != nil {
		title := strings.TrimSpace(*in.Title)
		if title == "" {
			return nil, newError(http.StatusBadRequest, "invalid_argument", "タイトルを入力してください。")
		}
		updates = append(updates, firestore.Update{Path: "title", Value: title})
	}
	if in.Content != nil {
		content := strings.TrimSpace(*in.Content)
		if content == "" {
			return nil, newError(http.StatusBadRequest, "invalid_argument", "申請内容を入力してください。")
		}
		updates = append(updates, firestore.Update{Path: "content", Value: content})
	}
	if in.Amount != nil {
		if *in.Amount < 0 {
			return nil, newError(http.StatusBadRequest, "invalid_argument", "金額には0以上の値を指定してください。")
		}
		updates = append(updates, firestore.Update{Path: "amount", Value: *in.Amount})
	}
	return updates, nil
}

// ListScope は一覧取得の絞り込み範囲。
type ListScope string

const (
	// ScopeMine は自身が申請した稟議。
	ScopeMine ListScope = "mine"
	// ScopeInbox は自身が承認すべき稟議。
	ScopeInbox ListScope = "inbox"
	// ScopeAll は上記の和集合（既定）。
	ScopeAll ListScope = "all"
)

// List は閲覧可能な稟議の一覧を返す（基本設計書 5.1節）。
//
// クライアントからの Firestore 直接読み取りは禁止されているため、
// 閲覧範囲の絞り込みは必ずここで行う。applicant ロールは自身の申請しか取得できない。
// ListResult は一覧取得の結果。
type ListResult struct {
	Items []models.RingiRequest `json:"items"`
	// Truncated は件数上限で結果を打ち切ったかどうか。
	Truncated bool `json:"truncated"`
}

func (s *RingiService) List(ctx context.Context, actor *models.User, scope ListScope) (*ListResult, error) {
	col := s.fs.Collection(collectionRingi)

	var queries []firestore.Query
	switch {
	case models.IsMaster(actor.Role):
		// マスターロールは全工程を代行するため、絞り込みの基準が異なる。
		switch scope {
		case ScopeMine:
			queries = append(queries, col.Where("applicantId", "==", actor.UID).
				OrderBy("createdAt", firestore.Desc).Limit(listLimit))
		case ScopeInbox:
			queries = append(queries, col.Where("status", "in", models.PendingStatuses).
				OrderBy("createdAt", firestore.Desc).Limit(listLimit))
		default:
			queries = append(queries, col.OrderBy("createdAt", firestore.Desc).Limit(listLimit))
		}

	default:
		if scope == ScopeMine || scope == ScopeAll {
			queries = append(queries, col.Where("applicantId", "==", actor.UID).
				OrderBy("createdAt", firestore.Desc).Limit(listLimit))
		}
		if scope == ScopeInbox || scope == ScopeAll {
			if pending, ok := models.PendingStatusForRole(actor.Role); ok {
				queries = append(queries, col.Where("status", "==", pending).
					OrderBy("createdAt", firestore.Desc).Limit(listLimit))
			}
		}
	}

	seen := make(map[string]struct{})
	results := make([]models.RingiRequest, 0, listLimit)
	for _, q := range queries {
		iter := q.Documents(ctx)
		for {
			snap, err := iter.Next()
			if errors.Is(err, iterator.Done) {
				break
			}
			if err != nil {
				iter.Stop()
				log.Printf("list ringi failed: %v", err)
				return nil, errInternal()
			}
			var req models.RingiRequest
			if err := snap.DataTo(&req); err != nil {
				iter.Stop()
				log.Printf("decode ringi %s failed: %v", snap.Ref.ID, err)
				return nil, errInternal()
			}
			if _, dup := seen[req.ID]; dup {
				continue
			}
			seen[req.ID] = struct{}{}
			results = append(results, req)
		}
		iter.Stop()
	}

	// 複数クエリの結果を結合するため、申請日時の降順で並べ直す。
	slices.SortFunc(results, func(a, b models.RingiRequest) int {
		return b.CreatedAt.Compare(a.CreatedAt)
	})

	// 上限に達した場合は打ち切るが、その事実を必ず呼び出し元へ伝える。
	// 黙って切り捨てると「一覧に無い＝存在しない」と誤認される。
	truncated := len(results) >= listLimit
	if truncated {
		results = results[:listLimit]
		log.Printf("list truncated at %d items (uid=%s role=%s scope=%s)",
			listLimit, actor.UID, actor.Role, scope)
	}
	return &ListResult{Items: results, Truncated: truncated}, nil
}

// Detail は稟議の詳細と承認履歴を返す。
type Detail struct {
	Request models.RingiRequest `json:"request"`
	History []models.AuditLog   `json:"history"`
}

// Get は稟議の詳細と監査ログを取得する。閲覧権限がない場合は 403 を返す。
func (s *RingiService) Get(ctx context.Context, actor *models.User, id string) (*Detail, error) {
	snap, err := s.fs.Collection(collectionRingi).Doc(id).Get(ctx)
	if err != nil {
		if status.Code(err) == codes.NotFound {
			return nil, errNotFound()
		}
		log.Printf("get ringi %s failed: %v", id, err)
		return nil, errInternal()
	}

	var req models.RingiRequest
	if err := snap.DataTo(&req); err != nil {
		log.Printf("decode ringi %s failed: %v", id, err)
		return nil, errInternal()
	}

	history, err := s.history(ctx, id)
	if err != nil {
		return nil, err
	}

	if !canView(actor, &req, history) {
		return nil, errForbidden()
	}
	return &Detail{Request: req, History: history}, nil
}

// canView は閲覧可否を判定する。
//
//   - 申請者本人は常に閲覧できる
//   - 現在のステータスが自身の承認待ちであれば閲覧できる
//   - 過去に自身が操作した稟議（監査ログに記録がある）は閲覧できる
//
// これにより applicant ロールが他者の稟議を閲覧することはできない。
func canView(actor *models.User, req *models.RingiRequest, history []models.AuditLog) bool {
	// マスターロールは全工程を代行するため、すべての稟議を閲覧できる。
	if models.IsMaster(actor.Role) {
		return true
	}
	if req.ApplicantID == actor.UID {
		return true
	}
	if pending, ok := models.PendingStatusForRole(actor.Role); ok && req.Status == pending {
		return true
	}
	return slices.ContainsFunc(history, func(l models.AuditLog) bool {
		return l.ActorID == actor.UID
	})
}

// history は稟議の監査ログを新しい順に取得する。
func (s *RingiService) history(ctx context.Context, id string) ([]models.AuditLog, error) {
	iter := s.fs.Collection(collectionLogs).
		Where("requestId", "==", id).
		OrderBy("timestamp", firestore.Desc).
		Documents(ctx)
	defer iter.Stop()

	logs := make([]models.AuditLog, 0, 8)
	for {
		snap, err := iter.Next()
		if errors.Is(err, iterator.Done) {
			break
		}
		if err != nil {
			log.Printf("list audit_logs for %s failed: %v", id, err)
			return nil, errInternal()
		}
		var l models.AuditLog
		if err := snap.DataTo(&l); err != nil {
			log.Printf("decode audit_log failed: %v", err)
			return nil, errInternal()
		}
		logs = append(logs, l)
	}
	return logs, nil
}
