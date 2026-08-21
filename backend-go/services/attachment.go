package services

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"path"
	"slices"
	"strings"
	"time"
	"unicode"

	"cloud.google.com/go/firestore"
	"cloud.google.com/go/storage"
	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/INOUE-ajiado/RingiFlow/backend-go/models"
)

const (
	// MaxAttachmentSize は添付ファイル1件あたりの上限（10MiB）。
	// Cloud Run のリクエストサイズ上限（32MiB）に収まる値としている。
	MaxAttachmentSize = 10 << 20

	// MaxAttachmentsPerRingi は1つの稟議に添付できる件数の上限。
	MaxAttachmentsPerRingi = 10

	// maxFileNameLength はファイル名の最大長。
	maxFileNameLength = 120
)

// allowedContentTypes は添付を許可する MIME タイプ。
// 実行可能ファイルやスクリプトを受け付けないよう、明示的な許可制とする。
var allowedContentTypes = []string{
	"application/pdf",
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"text/plain",
	"text/csv",
	"application/vnd.ms-excel",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"application/msword",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"application/vnd.ms-powerpoint",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	"application/zip",
}

// AttachmentService は稟議への添付ファイルを扱う。
//
// 基本設計書 4.2節の方針に従い、Cloud Storage への直接アクセスも禁止し、
// アップロード・ダウンロード・削除はすべて本APIを経由させる。これにより
// 稟議の閲覧権限とファイルの閲覧権限を必ず一致させられる。
type AttachmentService struct {
	fs     *firestore.Client
	bucket *storage.BucketHandle
	ringi  *RingiService
}

// NewAttachmentService は AttachmentService を生成する。
func NewAttachmentService(fs *firestore.Client, bucket *storage.BucketHandle, ringi *RingiService) *AttachmentService {
	return &AttachmentService{fs: fs, bucket: bucket, ringi: ringi}
}

// UploadInput はアップロードの入力。
type UploadInput struct {
	FileName    string
	ContentType string
	Size        int64
	Reader      io.Reader
}

// Upload は添付ファイルを保存し、稟議のメタデータへ追加する。
//
// 実体を Cloud Storage へ書き込んだうえで Firestore をトランザクション更新する。
// Firestore 側が失敗した場合は書き込んだ実体を削除し、参照されない孤児ファイルが
// 残らないようにする。
func (s *AttachmentService) Upload(ctx context.Context, actor *models.User, ringiID string, in UploadInput) (*models.Attachment, error) {
	fileName, appErr := sanitizeFileName(in.FileName)
	if appErr != nil {
		return nil, appErr
	}
	if in.Size <= 0 {
		return nil, newError(http.StatusBadRequest, "invalid_argument", "空のファイルは添付できません。")
	}
	if in.Size > MaxAttachmentSize {
		return nil, newError(http.StatusRequestEntityTooLarge, "file_too_large",
			fmt.Sprintf("ファイルサイズが上限（%dMB）を超えています。", MaxAttachmentSize>>20))
	}
	contentType := strings.TrimSpace(strings.ToLower(in.ContentType))
	if i := strings.Index(contentType, ";"); i >= 0 {
		contentType = strings.TrimSpace(contentType[:i])
	}
	if !slices.Contains(allowedContentTypes, contentType) {
		return nil, newError(http.StatusUnsupportedMediaType, "unsupported_file_type",
			"この形式のファイルは添付できません。PDF・画像・Office文書・テキスト・ZIPをご利用ください。")
	}

	// 添付前に権限とステータスを確認する（実体の書き込みを無駄にしないため）。
	docRef := s.fs.Collection(collectionRingi).Doc(ringiID)
	snap, err := docRef.Get(ctx)
	if err != nil {
		if status.Code(err) == codes.NotFound {
			return nil, errNotFound()
		}
		log.Printf("get ringi %s failed: %v", ringiID, err)
		return nil, errInternal()
	}
	var req models.RingiRequest
	if err := snap.DataTo(&req); err != nil {
		log.Printf("decode ringi %s failed: %v", ringiID, err)
		return nil, errInternal()
	}
	if appErr := canModifyAttachments(actor, &req); appErr != nil {
		return nil, appErr
	}
	if len(req.Attachments) >= MaxAttachmentsPerRingi {
		return nil, newError(http.StatusConflict, "too_many_attachments",
			fmt.Sprintf("添付できるファイルは%d件までです。", MaxAttachmentsPerRingi))
	}

	now := time.Now().UTC()
	attachment := models.Attachment{
		ID:             uuid.NewString(),
		FileName:       fileName,
		ContentType:    contentType,
		Size:           in.Size,
		UploadedBy:     actor.UID,
		UploadedByName: actor.Name,
		UploadedAt:     now,
	}
	attachment.StoragePath = fmt.Sprintf("ringi/%s/%s/%s", ringiID, attachment.ID, fileName)

	// 実体の書き込み。上限を超えるデータが送られてきた場合はここで打ち切る。
	object := s.bucket.Object(attachment.StoragePath)
	writer := object.NewWriter(ctx)
	writer.ContentType = contentType
	written, err := io.Copy(writer, io.LimitReader(in.Reader, MaxAttachmentSize+1))
	if err != nil {
		_ = writer.Close()
		_ = object.Delete(ctx)
		log.Printf("upload attachment failed: %v", err)
		return nil, errInternal()
	}
	if err := writer.Close(); err != nil {
		_ = object.Delete(ctx)
		log.Printf("close attachment writer failed: %v", err)
		return nil, errInternal()
	}
	if written > MaxAttachmentSize {
		_ = object.Delete(ctx)
		return nil, newError(http.StatusRequestEntityTooLarge, "file_too_large",
			fmt.Sprintf("ファイルサイズが上限（%dMB）を超えています。", MaxAttachmentSize>>20))
	}
	attachment.Size = written

	// メタデータの追加と監査ログをトランザクションで書き込む。
	err = s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		snap, err := tx.Get(docRef)
		if err != nil {
			if status.Code(err) == codes.NotFound {
				return errNotFound()
			}
			return err
		}
		var current models.RingiRequest
		if err := snap.DataTo(&current); err != nil {
			return err
		}
		// トランザクション内で最新の状態を読み直し、待っている間に決裁が
		// 確定していた場合や件数上限に達した場合を検出する。
		if appErr := canModifyAttachments(actor, &current); appErr != nil {
			return appErr
		}
		if len(current.Attachments) >= MaxAttachmentsPerRingi {
			return newError(http.StatusConflict, "too_many_attachments",
				fmt.Sprintf("添付できるファイルは%d件までです。", MaxAttachmentsPerRingi))
		}

		if err := tx.Update(docRef, []firestore.Update{
			{Path: "attachments", Value: append(current.Attachments, attachment)},
			{Path: "updatedAt", Value: now},
		}); err != nil {
			return err
		}
		return tx.Create(s.fs.Collection(collectionLogs).NewDoc(), &models.AuditLog{
			RequestID: ringiID,
			Action:    models.ActionAttach,
			ActorID:   actor.UID,
			ActorName: actor.Name,
			Comment:   fileName,
			Timestamp: now,
		})
	})
	if err != nil {
		// メタデータを残せなかったので、参照されない実体を消す。
		_ = object.Delete(ctx)
		var appErr *Error
		if errors.As(err, &appErr) {
			return nil, appErr
		}
		log.Printf("attach %s to %s failed: %v", attachment.ID, ringiID, err)
		return nil, errInternal()
	}
	return &attachment, nil
}

// Download は添付ファイルの実体を返す。稟議を閲覧できる利用者のみ取得できる。
// 呼び出し側は戻り値の ReadCloser を必ず閉じること。
func (s *AttachmentService) Download(ctx context.Context, actor *models.User, ringiID, attachmentID string) (io.ReadCloser, *models.Attachment, error) {
	// 閲覧権限の判定は稟議本体と同じ規則を用いる。
	detail, err := s.ringi.Get(ctx, actor, ringiID)
	if err != nil {
		return nil, nil, err
	}

	idx := slices.IndexFunc(detail.Request.Attachments, func(a models.Attachment) bool {
		return a.ID == attachmentID
	})
	if idx < 0 {
		return nil, nil, newError(http.StatusNotFound, "not_found", "指定された添付ファイルが見つかりません。")
	}
	attachment := detail.Request.Attachments[idx]

	reader, err := s.bucket.Object(attachment.StoragePath).NewReader(ctx)
	if err != nil {
		if errors.Is(err, storage.ErrObjectNotExist) {
			return nil, nil, newError(http.StatusNotFound, "not_found", "添付ファイルの実体が見つかりません。")
		}
		log.Printf("download attachment %s failed: %v", attachmentID, err)
		return nil, nil, errInternal()
	}
	return reader, &attachment, nil
}

// Delete は添付ファイルを削除する。
//
// メタデータを先に外してから実体を削除する。実体の削除に失敗しても
// 参照は既に外れているため画面上の不整合は生じない（孤児ファイルは残る）。
func (s *AttachmentService) Delete(ctx context.Context, actor *models.User, ringiID, attachmentID string) error {
	docRef := s.fs.Collection(collectionRingi).Doc(ringiID)
	now := time.Now().UTC()
	var removed models.Attachment

	err := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
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
		if appErr := canModifyAttachments(actor, &req); appErr != nil {
			return appErr
		}

		idx := slices.IndexFunc(req.Attachments, func(a models.Attachment) bool {
			return a.ID == attachmentID
		})
		if idx < 0 {
			return newError(http.StatusNotFound, "not_found", "指定された添付ファイルが見つかりません。")
		}
		removed = req.Attachments[idx]

		if err := tx.Update(docRef, []firestore.Update{
			{Path: "attachments", Value: slices.Delete(slices.Clone(req.Attachments), idx, idx+1)},
			{Path: "updatedAt", Value: now},
		}); err != nil {
			return err
		}
		return tx.Create(s.fs.Collection(collectionLogs).NewDoc(), &models.AuditLog{
			RequestID: ringiID,
			Action:    models.ActionDetach,
			ActorID:   actor.UID,
			ActorName: actor.Name,
			Comment:   removed.FileName,
			Timestamp: now,
		})
	})
	if err != nil {
		var appErr *Error
		if errors.As(err, &appErr) {
			return appErr
		}
		log.Printf("detach %s from %s failed: %v", attachmentID, ringiID, err)
		return errInternal()
	}

	if err := s.bucket.Object(removed.StoragePath).Delete(ctx); err != nil &&
		!errors.Is(err, storage.ErrObjectNotExist) {
		// 参照は外れているため利用者への影響はない。孤児ファイルとして記録に残す。
		log.Printf("orphaned attachment object %s: %v", removed.StoragePath, err)
	}
	return nil
}

// canModifyAttachments は添付の追加・削除が可能かを判定する。
//
// 添付は申請内容の一部であるため、変更できるのは申請者本人に限り、
// かつ決裁が確定する前（承認待ちまたは差し戻し）に限る。
func canModifyAttachments(actor *models.User, req *models.RingiRequest) *Error {
	if models.IsTerminal(req.Status) {
		return newError(http.StatusConflict, "invalid_state_transition",
			"決裁が確定した稟議の添付ファイルは変更できません。")
	}
	if models.IsMaster(actor.Role) {
		return nil
	}
	if req.ApplicantID != actor.UID {
		return newError(http.StatusConflict, "permission_denied",
			"添付ファイルを変更できるのは申請者本人のみです。")
	}
	return nil
}

// sanitizeFileName はアップロードされたファイル名を安全な形へ整える。
//
// ディレクトリ区切りや制御文字を除去し、Cloud Storage のパスに
// 意図しない階層が作られたり、ダウンロード時のヘッダーが壊れたりするのを防ぐ。
func sanitizeFileName(raw string) (string, *Error) {
	name := strings.TrimSpace(raw)
	// パス区切りを含む場合は最後の要素だけを採用する
	name = strings.ReplaceAll(name, "\\", "/")
	name = path.Base(name)

	// path.Base はパスだけの入力に対して "/" や "." を返す。
	// これらはファイル名ではないため、この時点で不正として扱う。
	switch name {
	case "/", ".", "..":
		return "", newError(http.StatusBadRequest, "invalid_argument", "ファイル名が不正です。")
	}

	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		if strings.ContainsRune(`/\:*?"<>|`, r) {
			return '_'
		}
		return r
	}, name)
	name = strings.TrimSpace(strings.Trim(name, "."))

	if name == "" {
		return "", newError(http.StatusBadRequest, "invalid_argument", "ファイル名が不正です。")
	}
	if len([]rune(name)) > maxFileNameLength {
		return "", newError(http.StatusBadRequest, "invalid_argument",
			fmt.Sprintf("ファイル名が長すぎます（%d文字以内）。", maxFileNameLength))
	}
	return name, nil
}
