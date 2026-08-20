// RingiFlow バックエンドAPI
//
// Firestore のセキュリティルールによりクライアントからの直接アクセスは全面禁止されているため、
// すべてのデータ取得・更新はこのAPIを経由する（基本設計書 4.2 / 5節）。
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	firebase "firebase.google.com/go/v4"

	"github.com/INOUE-ajiado/RingiFlow/backend-go/handlers"
	"github.com/INOUE-ajiado/RingiFlow/backend-go/middleware"
	"github.com/INOUE-ajiado/RingiFlow/backend-go/services"
)

func main() {
	if err := run(); err != nil {
		log.Fatalf("fatal: %v", err)
	}
}

func run() error {
	ctx := context.Background()

	projectID := env("FIREBASE_PROJECT_ID", "ringiflow-81f8d")
	port := env("PORT", "8080")
	origins := strings.Split(env("ALLOWED_ORIGINS", "http://localhost:4200"), ",")
	for i := range origins {
		origins[i] = strings.TrimSpace(origins[i])
	}

	// 認証情報は Application Default Credentials から取得する。
	// ローカル: gcloud auth application-default login
	// Cloud Run: サービスアカウントが自動的に適用される
	app, err := firebase.NewApp(ctx, &firebase.Config{ProjectID: projectID})
	if err != nil {
		return err
	}
	authClient, err := app.Auth(ctx)
	if err != nil {
		return err
	}
	fsClient, err := app.Firestore(ctx)
	if err != nil {
		return err
	}
	defer fsClient.Close()

	apiMux := http.NewServeMux()
	handlers.NewRingiHandler(services.NewRingiService(fsClient)).Register(apiMux)

	auth := &middleware.Auth{AuthClient: authClient, Firestore: fsClient}

	root := http.NewServeMux()
	root.Handle("/api/", auth.Wrap(apiMux))
	// ヘルスチェック。Cloud Run の Google Frontend は /healthz を予約パスとして
	// 横取りしコンテナへ転送しないため、正となるパスは /health とする。
	// /healthz はローカルや他の実行環境向けに併せて公開する。
	health := func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}
	root.HandleFunc("GET /health", health)
	root.HandleFunc("GET /healthz", health)

	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           middleware.CORS(origins)(root),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	// Cloud Run のシャットダウンシグナルを受けて処理中のリクエストを完了させる。
	shutdownErr := make(chan error, 1)
	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
		<-sig
		log.Println("shutting down...")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		shutdownErr <- srv.Shutdown(shutdownCtx)
	}()

	log.Printf("RingiFlow API listening on :%s (project=%s, origins=%v)", port, projectID, origins)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return <-shutdownErr
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
