# syntax=docker/dockerfile:1

# ---- ビルドステージ ----
FROM golang:1.25-alpine AS build
WORKDIR /src

# 依存関係を先に解決し、ソース変更時のビルドキャッシュを効かせる
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/server .

# ---- 実行ステージ ----
# Cloud Run 上では Application Default Credentials が自動的に適用されるため、
# サービスアカウントキーをイメージへ含める必要はない。
FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /
COPY --from=build /out/server /server
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/server"]
