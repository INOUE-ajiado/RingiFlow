package handlers

import (
	"net/http"

	"github.com/INOUE-ajiado/RingiFlow/backend-go/middleware"
	"github.com/INOUE-ajiado/RingiFlow/backend-go/models"
	"github.com/INOUE-ajiado/RingiFlow/backend-go/services"
)

// RingiHandler は稟議関連のエンドポイントを実装する。
type RingiHandler struct {
	svc *services.RingiService
}

// NewRingiHandler は RingiHandler を生成する。
func NewRingiHandler(svc *services.RingiService) *RingiHandler {
	return &RingiHandler{svc: svc}
}

// Register は基本設計書 5.1節のエンドポイントを ServeMux に登録する。
// 認証はすべてのエンドポイントで必須のため、呼び出し側で auth ミドルウェアを適用する。
func (h *RingiHandler) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/me", h.me)
	mux.HandleFunc("GET /api/v1/config", h.config)
	mux.HandleFunc("POST /api/v1/ringi", h.create)
	mux.HandleFunc("GET /api/v1/ringi", h.list)
	mux.HandleFunc("GET /api/v1/ringi/{id}", h.get)
	mux.HandleFunc("POST /api/v1/ringi/{id}/approve", h.transition(models.ActionApprove))
	mux.HandleFunc("POST /api/v1/ringi/{id}/return", h.transition(models.ActionReturn))
	mux.HandleFunc("POST /api/v1/ringi/{id}/reject", h.transition(models.ActionReject))
	mux.HandleFunc("POST /api/v1/ringi/{id}/resubmit", h.transition(models.ActionResubmit))
	mux.HandleFunc("POST /api/v1/ringi/{id}/withdraw", h.transition(models.ActionWithdraw))
}

// me は認証済みユーザー自身の情報（氏名・社員ID・ロール）を返す。
// フロントエンドは表示可能な操作ボタンの判定にロールを用いる。
func (h *RingiHandler) me(w http.ResponseWriter, r *http.Request) {
	user, ok := middleware.UserFrom(r.Context())
	if !ok {
		writeError(w, nil)
		return
	}
	writeJSON(w, http.StatusOK, user)
}

// config は画面が判定に用いる業務ルールの設定値を返す。
//
// 金額の閾値などをフロントエンド側にも定数として持たせると、変更時に
// 二重管理となり食い違う。判断の根拠は常にサーバーが配る。
func (h *RingiHandler) config(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"ceoApprovalThreshold": models.CEOApprovalThreshold,
		"maxAttachmentSize":    services.MaxAttachmentSize,
		"maxAttachments":       services.MaxAttachmentsPerRingi,
	})
}

func (h *RingiHandler) create(w http.ResponseWriter, r *http.Request) {
	user, ok := middleware.UserFrom(r.Context())
	if !ok {
		writeError(w, nil)
		return
	}
	var in services.CreateInput
	if err := decodeJSON(r, &in); err != nil {
		writeError(w, err)
		return
	}
	req, err := h.svc.Create(r.Context(), user, in)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"success":   true,
		"requestId": req.ID,
		"newStatus": req.Status,
		"updatedAt": req.UpdatedAt,
		"request":   req,
	})
}

func (h *RingiHandler) list(w http.ResponseWriter, r *http.Request) {
	user, ok := middleware.UserFrom(r.Context())
	if !ok {
		writeError(w, nil)
		return
	}
	query, appErr := parseListQuery(r.URL.Query())
	if appErr != nil {
		writeError(w, appErr)
		return
	}
	result, err := h.svc.List(r.Context(), user, query)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"success":    true,
		"items":      result.Items,
		"nextCursor": result.NextCursor,
		"truncated":  result.Truncated,
	})
}

func (h *RingiHandler) get(w http.ResponseWriter, r *http.Request) {
	user, ok := middleware.UserFrom(r.Context())
	if !ok {
		writeError(w, nil)
		return
	}
	detail, err := h.svc.Get(r.Context(), user, r.PathValue("id"))
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"request": detail.Request,
		"history": detail.History,
	})
}

// transition は承認・差し戻し・却下・再申請の各エンドポイントを生成する。
// いずれも同一のトランザクション処理フローを通る（基本設計書 5.2節）。
func (h *RingiHandler) transition(action string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := middleware.UserFrom(r.Context())
		if !ok {
			writeError(w, nil)
			return
		}
		var in services.TransitionInput
		if err := decodeJSON(r, &in); err != nil {
			writeError(w, err)
			return
		}
		result, err := h.svc.Transition(r.Context(), user, r.PathValue("id"), action, in)
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"success":   true,
			"requestId": result.RequestID,
			"newStatus": result.NewStatus,
			"updatedAt": result.UpdatedAt,
		})
	}
}
