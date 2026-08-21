package services

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"cloud.google.com/go/firestore"
	"google.golang.org/api/iterator"

	"github.com/INOUE-ajiado/RingiFlow/backend-go/models"
)

// ListScope は一覧取得の絞り込み範囲。
type ListScope string

const (
	// ScopeMine は自身が申請した稟議。
	ScopeMine ListScope = "mine"
	// ScopeInbox は自身が承認すべき稟議。
	ScopeInbox ListScope = "inbox"
	// ScopeAll は閲覧可能なすべての稟議（既定）。
	ScopeAll ListScope = "all"
)

const (
	defaultPageSize = 50
	maxPageSize     = 100

	// keywordScanLimit はキーワード検索時に走査するドキュメントの上限。
	//
	// Firestore は部分一致検索を提供しないため、キーワード検索は取得済みの
	// ドキュメントに対してサーバー側で絞り込む。無制限に走査すると読み取り
	// コストが際限なく増えるため上限を設け、達した場合は Truncated で通知する。
	keywordScanLimit = 1000
	keywordBatchSize = 200
)

// ListQuery は一覧取得の条件。
type ListQuery struct {
	Scope ListScope
	// Statuses は絞り込むステータス。空の場合は絞り込まない。
	Statuses []string
	// From / To は申請日時の範囲（To は指定日の終わりまでを含む）。
	From *time.Time
	To   *time.Time
	// Keyword は稟議番号・タイトル・内容・申請者名に対する部分一致。
	Keyword string
	// Limit は1ページの件数。
	Limit int
	// Cursor は前回の応答が返した NextCursor。
	Cursor string
}

// ListResult は一覧取得の結果。
type ListResult struct {
	Items []models.RingiRequest `json:"items"`
	// NextCursor は次ページが存在する場合のカーソル。無い場合は空文字。
	NextCursor string `json:"nextCursor"`
	// Truncated はキーワード検索が走査上限に達し、
	// 一致するものをすべて調べきれなかったことを示す。
	Truncated bool `json:"truncated"`
}

// List は閲覧可能な稟議の一覧を返す（基本設計書 5.1節）。
//
// クライアントからの Firestore 直接読み取りは禁止されているため、
// 閲覧範囲の絞り込みは必ずここで行う。applicant ロールは自身の申請しか取得できない。
func (s *RingiService) List(ctx context.Context, actor *models.User, q ListQuery) (*ListResult, error) {
	pageSize := q.Limit
	if pageSize <= 0 {
		pageSize = defaultPageSize
	}
	if pageSize > maxPageSize {
		pageSize = maxPageSize
	}

	query, appErr := s.buildQuery(actor, q)
	if appErr != nil {
		return nil, appErr
	}

	if q.Cursor != "" {
		createdAt, docID, err := decodeCursor(q.Cursor)
		if err != nil {
			return nil, newError(http.StatusBadRequest, "invalid_cursor", "一覧の読み込み位置が不正です。")
		}
		query = query.StartAfter(createdAt, docID)
	}

	keyword := strings.TrimSpace(q.Keyword)
	if keyword == "" {
		return s.fetchPage(ctx, query, pageSize)
	}
	return s.fetchPageWithKeyword(ctx, query, pageSize, keyword)
}

// buildQuery は閲覧範囲と絞り込み条件から Firestore クエリを組み立てる。
//
// 並び順は「申請日時の降順 → ドキュメントIDの降順」で固定する。
// ページングのカーソルがこの2つの値に依存するため、同時刻の稟議が複数あっても
// 順序が安定し、ページの境界で重複や取りこぼしが起きない。
func (s *RingiService) buildQuery(actor *models.User, q ListQuery) (firestore.Query, *Error) {
	query := s.fs.Collection(collectionRingi).Query

	// 閲覧範囲による絞り込み
	switch {
	case models.IsMaster(actor.Role):
		// マスターは全工程を代行するため、閲覧範囲による制限を受けない。
		switch q.Scope {
		case ScopeMine:
			query = query.Where("applicantId", "==", actor.UID)
		case ScopeInbox:
			query = query.Where("status", "in", models.PendingStatuses)
		}

	default:
		pending, isApprover := models.PendingStatusForRole(actor.Role)
		switch q.Scope {
		case ScopeMine:
			query = query.Where("applicantId", "==", actor.UID)
		case ScopeInbox:
			if !isApprover {
				// 承認権限を持たないロールに承認待ち一覧は存在しない。
				return query, nil
			}
			query = query.Where("status", "==", pending)
		default:
			// 自身の申請、または自身が承認すべき稟議。
			if isApprover {
				query = query.WhereEntity(firestore.OrFilter{Filters: []firestore.EntityFilter{
					firestore.PropertyFilter{Path: "applicantId", Operator: "==", Value: actor.UID},
					firestore.PropertyFilter{Path: "status", Operator: "==", Value: pending},
				}})
			} else {
				query = query.Where("applicantId", "==", actor.UID)
			}
		}
	}

	// ステータスによる絞り込み
	if len(q.Statuses) > 0 {
		for _, st := range q.Statuses {
			if !models.IsValidStatus(st) {
				return query, newError(http.StatusBadRequest, "invalid_argument",
					fmt.Sprintf("不正なステータスが指定されています: %s", st))
			}
		}
		query = query.Where("status", "in", q.Statuses)
	}

	// 申請日時の範囲
	if q.From != nil {
		query = query.Where("createdAt", ">=", *q.From)
	}
	if q.To != nil {
		query = query.Where("createdAt", "<=", *q.To)
	}

	return query.OrderBy("createdAt", firestore.Desc).
		OrderBy(firestore.DocumentID, firestore.Desc), nil
}

// fetchPage はキーワード指定がない場合の1ページ分を取得する。
// 次ページの有無を判定するため、必要数より1件多く読み取る。
func (s *RingiService) fetchPage(ctx context.Context, query firestore.Query, pageSize int) (*ListResult, error) {
	items, err := s.collect(ctx, query.Limit(pageSize+1))
	if err != nil {
		return nil, err
	}

	result := &ListResult{Items: items}
	if len(items) > pageSize {
		result.Items = items[:pageSize]
		result.NextCursor = encodeCursor(result.Items[pageSize-1])
	}
	return result, nil
}

// fetchPageWithKeyword はキーワードで絞り込みながら1ページ分を集める。
//
// Firestore は部分一致検索を提供しないため、条件に一致するドキュメントを
// 順に読み取りながらサーバー側で絞り込む。走査量が際限なく増えないよう
// keywordScanLimit で上限を設け、達した場合は Truncated を立てる。
func (s *RingiService) fetchPageWithKeyword(ctx context.Context, query firestore.Query, pageSize int, keyword string) (*ListResult, error) {
	needle := strings.ToLower(keyword)
	matched := make([]models.RingiRequest, 0, pageSize+1)
	scanned := 0
	var last *models.RingiRequest

	for len(matched) <= pageSize && scanned < keywordScanLimit {
		batchQuery := query.Limit(keywordBatchSize)
		if last != nil {
			batchQuery = batchQuery.StartAfter(last.CreatedAt, last.ID)
		}

		batch, err := s.collect(ctx, batchQuery)
		if err != nil {
			return nil, err
		}
		if len(batch) == 0 {
			break
		}
		scanned += len(batch)
		last = &batch[len(batch)-1]

		for i := range batch {
			if matchesKeyword(&batch[i], needle) {
				matched = append(matched, batch[i])
				if len(matched) > pageSize {
					break
				}
			}
		}
		if len(batch) < keywordBatchSize {
			// 全件を読み切った
			break
		}
	}

	result := &ListResult{Items: matched}
	if len(matched) > pageSize {
		result.Items = matched[:pageSize]
		result.NextCursor = encodeCursor(result.Items[pageSize-1])
	} else if scanned >= keywordScanLimit {
		// 走査上限に達したため、これ以上一致するものがあるか確認できていない。
		result.Truncated = true
		log.Printf("keyword search hit scan limit %d (keyword=%q)", keywordScanLimit, keyword)
	}
	return result, nil
}

// matchesKeyword は稟議番号・タイトル・内容・申請者情報に対する部分一致を判定する。
func matchesKeyword(req *models.RingiRequest, lowerNeedle string) bool {
	for _, field := range []string{
		req.RequestNo, req.Title, req.Content, req.ApplicantName, req.ApplicantEmployeeID,
	} {
		if strings.Contains(strings.ToLower(field), lowerNeedle) {
			return true
		}
	}
	return false
}

func (s *RingiService) collect(ctx context.Context, query firestore.Query) ([]models.RingiRequest, error) {
	iter := query.Documents(ctx)
	defer iter.Stop()

	items := make([]models.RingiRequest, 0, defaultPageSize)
	for {
		snap, err := iter.Next()
		if errors.Is(err, iterator.Done) {
			break
		}
		if err != nil {
			log.Printf("list ringi failed: %v", err)
			return nil, errInternal()
		}
		var req models.RingiRequest
		if err := snap.DataTo(&req); err != nil {
			log.Printf("decode ringi %s failed: %v", snap.Ref.ID, err)
			return nil, errInternal()
		}
		items = append(items, req)
	}
	return items, nil
}

// encodeCursor は並び順のキー（申請日時とドキュメントID）をカーソルへ符号化する。
func encodeCursor(req models.RingiRequest) string {
	raw := req.CreatedAt.UTC().Format(time.RFC3339Nano) + "|" + req.ID
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

func decodeCursor(cursor string) (time.Time, string, error) {
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return time.Time{}, "", err
	}
	createdAt, docID, ok := strings.Cut(string(raw), "|")
	if !ok || docID == "" {
		return time.Time{}, "", errors.New("malformed cursor")
	}
	t, err := time.Parse(time.RFC3339Nano, createdAt)
	if err != nil {
		return time.Time{}, "", err
	}
	return t, docID, nil
}
