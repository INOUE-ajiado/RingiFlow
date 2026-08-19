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
	mux.HandleFunc("POST /api/v1/ringi", h.create)
	mux.HandleFunc("GET /api/v1/ringi", h.list)
	mux.HandleFunc("GET /api/v1/ringi/{id}", h.get)
	mux.HandleFunc("POST /api/v1/ringi/{id}/approve", h.transition(models.ActionApprove))
	mux.HandleFunc("POST /api/v1/ringi/{id}/return", h.transition(models.ActionReturn))
	mux.HandleFunc("POST /api/v1/ringi/{id}/reject", h.transition(models.ActionReject))
	mux.HandleFunc("POST /api/v1/ringi/{id}/resubmit", h.transition(models.ActionResubmit))
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
	scope := services.ScopeAll
	switch r.URL.Query().Get("scope") {
	case string(services.ScopeMine):
		scope = services.ScopeMine
	case string(services.ScopeInbox):
		scope = services.ScopeInbox
	}
	items, err := h.svc.List(r.Context(), user, scope)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"items":   items,
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
