package handlers

import (
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/INOUE-ajiado/RingiFlow/backend-go/middleware"
	"github.com/INOUE-ajiado/RingiFlow/backend-go/services"
)

// AttachmentHandler は添付ファイルのエンドポイントを実装する。
type AttachmentHandler struct {
	svc *services.AttachmentService
}

// NewAttachmentHandler は AttachmentHandler を生成する。
func NewAttachmentHandler(svc *services.AttachmentService) *AttachmentHandler {
	return &AttachmentHandler{svc: svc}
}

// Register は添付ファイル関連のエンドポイントを ServeMux に登録する。
func (h *AttachmentHandler) Register(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/v1/ringi/{id}/attachments", h.upload)
	mux.HandleFunc("GET /api/v1/ringi/{id}/attachments/{attachmentId}", h.download)
	mux.HandleFunc("DELETE /api/v1/ringi/{id}/attachments/{attachmentId}", h.delete)
}

func (h *AttachmentHandler) upload(w http.ResponseWriter, r *http.Request) {
	user, ok := middleware.UserFrom(r.Context())
	if !ok {
		writeError(w, nil)
		return
	}

	// 上限を超えるリクエストはメモリを消費する前に打ち切る。
	// 余裕分はマルチパートの境界やヘッダーのぶん。
	r.Body = http.MaxBytesReader(w, r.Body, services.MaxAttachmentSize+(1<<20))

	file, header, err := r.FormFile("file")
	if err != nil {
		var maxErr *http.MaxBytesError
		if strings.Contains(err.Error(), "request body too large") || asMaxBytes(err, &maxErr) {
			writeError(w, &services.Error{
				HTTPStatus: http.StatusRequestEntityTooLarge,
				Code:       "file_too_large",
				Message: fmt.Sprintf("ファイルサイズが上限（%dMB）を超えています。",
					services.MaxAttachmentSize>>20),
			})
			return
		}
		writeError(w, badRequest("ファイルが指定されていません。"))
		return
	}
	defer file.Close()

	attachment, err := h.svc.Upload(r.Context(), user, r.PathValue("id"), services.UploadInput{
		FileName:    header.Filename,
		ContentType: contentTypeOf(header.Header.Get("Content-Type"), header.Filename),
		Size:        header.Size,
		Reader:      file,
	})
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"success":    true,
		"attachment": attachment,
	})
}

func (h *AttachmentHandler) download(w http.ResponseWriter, r *http.Request) {
	user, ok := middleware.UserFrom(r.Context())
	if !ok {
		writeError(w, nil)
		return
	}

	reader, attachment, err := h.svc.Download(
		r.Context(), user, r.PathValue("id"), r.PathValue("attachmentId"))
	if err != nil {
		writeError(w, err)
		return
	}
	defer reader.Close()

	w.Header().Set("Content-Type", attachment.ContentType)
	w.Header().Set("Content-Length", fmt.Sprintf("%d", attachment.Size))
	// 日本語ファイル名を正しく扱うため RFC 5987 形式で指定する。
	w.Header().Set("Content-Disposition",
		mime.FormatMediaType("attachment", map[string]string{"filename": attachment.FileName}))
	// 稟議は社内機密のため中間キャッシュに残さない。
	w.Header().Set("Cache-Control", "private, no-store")

	if _, err := io.Copy(w, reader); err != nil {
		// ヘッダー送出後のため、ここではステータスを変更できない。
		log.Printf("stream attachment %s failed: %v", attachment.ID, err)
	}
}

func (h *AttachmentHandler) delete(w http.ResponseWriter, r *http.Request) {
	user, ok := middleware.UserFrom(r.Context())
	if !ok {
		writeError(w, nil)
		return
	}
	if err := h.svc.Delete(
		r.Context(), user, r.PathValue("id"), r.PathValue("attachmentId")); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

// contentTypeOf はブラウザが送ってきた MIME タイプを採用し、
// 未指定または汎用的すぎる場合は拡張子から補う。
func contentTypeOf(declared, fileName string) string {
	declared = strings.TrimSpace(declared)
	if declared != "" && declared != "application/octet-stream" {
		return declared
	}
	if byExt := mime.TypeByExtension(strings.ToLower(filepath.Ext(fileName))); byExt != "" {
		return byExt
	}
	return declared
}

func asMaxBytes(err error, target **http.MaxBytesError) bool {
	e, ok := err.(*http.MaxBytesError)
	if ok {
		*target = e
	}
	return ok
}
