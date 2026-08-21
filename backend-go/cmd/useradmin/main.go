// useradmin は RingiFlow の利用者アカウントを発行・管理する管理者向けCLIツール。
//
// 基本設計書 3.4節のとおり、アカウントのセルフ登録は行わず、
// Firebase Auth のユーザーと users コレクションのドキュメントを
// 必ず対で作成する必要がある。本ツールはその両方を一括で行う。
//
// 実行例:
//
//	go run ./cmd/useradmin create -employee E1234 -name "井上健二" -role ceo
//	go run ./cmd/useradmin list
//	go run ./cmd/useradmin setrole -employee E1234 -role producer
//	go run ./cmd/useradmin passwd -employee E1234
//
// 認証情報は Application Default Credentials を使用する。
// 事前に `gcloud auth application-default login` を実行しておくこと。
package main

import (
	"context"
	"crypto/rand"
	"errors"
	"flag"
	"fmt"
	"math/big"
	"os"
	"strings"
	"text/tabwriter"

	"cloud.google.com/go/firestore"
	firebase "firebase.google.com/go/v4"
	firebaseauth "firebase.google.com/go/v4/auth"
	"google.golang.org/api/iterator"

	"github.com/INOUE-ajiado/RingiFlow/backend-go/models"
)

const (
	defaultProjectID   = "ringiflow-81f8d"
	defaultEmailDomain = "ringiflow.ajiado.co.jp"
	passwordLength     = 14
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}

	var err error
	switch os.Args[1] {
	case "create":
		err = createCmd(os.Args[2:])
	case "list":
		err = listCmd(os.Args[2:])
	case "setrole":
		err = setRoleCmd(os.Args[2:])
	case "setdept":
		err = setDeptCmd(os.Args[2:])
	case "passwd":
		err = passwdCmd(os.Args[2:])
	case "-h", "--help", "help":
		usage()
		return
	default:
		fmt.Fprintf(os.Stderr, "不明なコマンド: %s\n\n", os.Args[1])
		usage()
		os.Exit(2)
	}

	if err != nil {
		fmt.Fprintf(os.Stderr, "エラー: %v\n", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `RingiFlow ユーザー管理ツール

使い方:
  useradmin create  -employee <社員ID> -name <氏名> -role <ロール> [-department <所属>] [-password <初期パスワード>]
  useradmin list
  useradmin setrole -employee <社員ID> -role <ロール>
  useradmin setdept -employee <社員ID> -department <所属>
  useradmin passwd  -employee <社員ID> [-password <新しいパスワード>]

ロール:
  applicant     申請者
  system_admin  システム担当
  producer      プロデューサー
  ceo           代表

共通オプション:
  -project  Firebase プロジェクトID (既定: `+defaultProjectID+`)
  -domain   認証用メールアドレスのドメイン (既定: `+defaultEmailDomain+`)

パスワードを省略した場合はランダムな初期パスワードを生成して表示する。
`)
}

type clients struct {
	auth *firebaseauth.Client
	fs   *firestore.Client
}

func newClients(ctx context.Context, projectID string) (*clients, func(), error) {
	app, err := firebase.NewApp(ctx, &firebase.Config{ProjectID: projectID})
	if err != nil {
		return nil, nil, err
	}
	authClient, err := app.Auth(ctx)
	if err != nil {
		return nil, nil, err
	}
	fsClient, err := app.Firestore(ctx)
	if err != nil {
		return nil, nil, err
	}
	return &clients{auth: authClient, fs: fsClient}, func() { _ = fsClient.Close() }, nil
}

func createCmd(args []string) error {
	fs := flag.NewFlagSet("create", flag.ExitOnError)
	employee := fs.String("employee", "", "社員ID（必須）")
	name := fs.String("name", "", "氏名（必須）")
	department := fs.String("department", "", "所属部門（稟議書の所属欄に表示）")
	role := fs.String("role", "", "権限ロール（必須）")
	password := fs.String("password", "", "初期パスワード（省略時は自動生成）")
	projectID := fs.String("project", defaultProjectID, "Firebase プロジェクトID")
	domain := fs.String("domain", defaultEmailDomain, "認証用メールアドレスのドメイン")
	if err := fs.Parse(args); err != nil {
		return err
	}

	if *employee == "" || *name == "" || *role == "" {
		fs.Usage()
		return errors.New("-employee, -name, -role は必須です")
	}
	if !models.IsValidRole(*role) {
		return fmt.Errorf("不正なロールです: %s（applicant / system_admin / producer / ceo のいずれか）", *role)
	}

	pw := *password
	if pw == "" {
		generated, err := generatePassword()
		if err != nil {
			return err
		}
		pw = generated
	}
	if len(pw) < 6 {
		return errors.New("パスワードは6文字以上である必要があります")
	}

	ctx := context.Background()
	c, closeFn, err := newClients(ctx, *projectID)
	if err != nil {
		return err
	}
	defer closeFn()

	email := fmt.Sprintf("%s@%s", strings.TrimSpace(*employee), *domain)

	user, err := c.auth.CreateUser(ctx, (&firebaseauth.UserToCreate{}).
		Email(email).
		Password(pw).
		DisplayName(*name))
	if err != nil {
		return fmt.Errorf("Firebase Auth ユーザーの作成に失敗しました: %w", err)
	}

	// users ドキュメントは Firebase Auth の uid をドキュメントIDとする（基本設計書 3.4節）。
	_, err = c.fs.Collection("users").Doc(user.UID).Set(ctx, models.User{
		UID:        user.UID,
		EmployeeID: strings.TrimSpace(*employee),
		Name:       *name,
		Role:       *role,
		Department: strings.TrimSpace(*department),
	})
	if err != nil {
		// Firestore 側の作成に失敗した場合、Auth 側だけが残ると
		// ログインはできるが権限を解決できない不整合状態になるため取り消す。
		if delErr := c.auth.DeleteUser(ctx, user.UID); delErr != nil {
			return fmt.Errorf("users ドキュメントの作成に失敗し、Auth ユーザーの取り消しにも失敗しました（uid=%s）: %w", user.UID, err)
		}
		return fmt.Errorf("users ドキュメントの作成に失敗したため、Auth ユーザーを取り消しました: %w", err)
	}

	fmt.Printf("アカウントを作成しました\n")
	fmt.Printf("  社員ID        : %s\n", *employee)
	fmt.Printf("  氏名          : %s\n", *name)
	fmt.Printf("  ロール        : %s\n", *role)
	if *department != "" {
		fmt.Printf("  所属          : %s\n", *department)
	}
	fmt.Printf("  ログインID    : %s（画面では社員IDのみ入力）\n", email)
	fmt.Printf("  初期パスワード: %s\n", pw)
	fmt.Printf("  uid           : %s\n", user.UID)
	return nil
}

func listCmd(args []string) error {
	fs := flag.NewFlagSet("list", flag.ExitOnError)
	projectID := fs.String("project", defaultProjectID, "Firebase プロジェクトID")
	if err := fs.Parse(args); err != nil {
		return err
	}

	ctx := context.Background()
	c, closeFn, err := newClients(ctx, *projectID)
	if err != nil {
		return err
	}
	defer closeFn()

	iter := c.fs.Collection("users").Documents(ctx)
	defer iter.Stop()

	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "社員ID\t氏名\t所属\tロール\tuid")
	count := 0
	for {
		snap, err := iter.Next()
		if errors.Is(err, iterator.Done) {
			break
		}
		if err != nil {
			return err
		}
		var u models.User
		if err := snap.DataTo(&u); err != nil {
			return err
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\n", u.EmployeeID, u.Name, u.Department, u.Role, snap.Ref.ID)
		count++
	}
	if err := w.Flush(); err != nil {
		return err
	}
	fmt.Printf("\n%d 件\n", count)
	return nil
}

func setRoleCmd(args []string) error {
	fs := flag.NewFlagSet("setrole", flag.ExitOnError)
	employee := fs.String("employee", "", "社員ID（必須）")
	role := fs.String("role", "", "新しいロール（必須）")
	projectID := fs.String("project", defaultProjectID, "Firebase プロジェクトID")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *employee == "" || *role == "" {
		fs.Usage()
		return errors.New("-employee と -role は必須です")
	}
	if !models.IsValidRole(*role) {
		return fmt.Errorf("不正なロールです: %s", *role)
	}

	ctx := context.Background()
	c, closeFn, err := newClients(ctx, *projectID)
	if err != nil {
		return err
	}
	defer closeFn()

	uid, err := findUIDByEmployeeID(ctx, c, *employee)
	if err != nil {
		return err
	}
	if _, err := c.fs.Collection("users").Doc(uid).Update(ctx, []firestore.Update{
		{Path: "role", Value: *role},
	}); err != nil {
		return err
	}
	fmt.Printf("社員ID %s のロールを %s に変更しました\n", *employee, *role)
	return nil
}

// setDeptCmd は既存ユーザーの所属部門を変更する。
// 既に作成済みの稟議に記録された所属は、当時の記録として変更しない。
func setDeptCmd(args []string) error {
	fs := flag.NewFlagSet("setdept", flag.ExitOnError)
	employee := fs.String("employee", "", "社員ID（必須）")
	department := fs.String("department", "", "新しい所属部門（必須）")
	projectID := fs.String("project", defaultProjectID, "Firebase プロジェクトID")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *employee == "" || *department == "" {
		fs.Usage()
		return errors.New("-employee と -department は必須です")
	}

	ctx := context.Background()
	c, closeFn, err := newClients(ctx, *projectID)
	if err != nil {
		return err
	}
	defer closeFn()

	uid, err := findUIDByEmployeeID(ctx, c, *employee)
	if err != nil {
		return err
	}
	if _, err := c.fs.Collection("users").Doc(uid).Update(ctx, []firestore.Update{
		{Path: "department", Value: strings.TrimSpace(*department)},
	}); err != nil {
		return err
	}
	fmt.Printf("社員ID %s の所属を %s に変更しました\n", *employee, *department)
	return nil
}

func passwdCmd(args []string) error {
	fs := flag.NewFlagSet("passwd", flag.ExitOnError)
	employee := fs.String("employee", "", "社員ID（必須）")
	password := fs.String("password", "", "新しいパスワード（省略時は自動生成）")
	projectID := fs.String("project", defaultProjectID, "Firebase プロジェクトID")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *employee == "" {
		fs.Usage()
		return errors.New("-employee は必須です")
	}

	pw := *password
	if pw == "" {
		generated, err := generatePassword()
		if err != nil {
			return err
		}
		pw = generated
	}
	if len(pw) < 6 {
		return errors.New("パスワードは6文字以上である必要があります")
	}

	ctx := context.Background()
	c, closeFn, err := newClients(ctx, *projectID)
	if err != nil {
		return err
	}
	defer closeFn()

	uid, err := findUIDByEmployeeID(ctx, c, *employee)
	if err != nil {
		return err
	}
	if _, err := c.auth.UpdateUser(ctx, uid, (&firebaseauth.UserToUpdate{}).Password(pw)); err != nil {
		return err
	}
	fmt.Printf("社員ID %s のパスワードを変更しました\n", *employee)
	fmt.Printf("  新しいパスワード: %s\n", pw)
	return nil
}

func findUIDByEmployeeID(ctx context.Context, c *clients, employeeID string) (string, error) {
	iter := c.fs.Collection("users").
		Where("employeeId", "==", strings.TrimSpace(employeeID)).
		Limit(1).
		Documents(ctx)
	defer iter.Stop()

	snap, err := iter.Next()
	if errors.Is(err, iterator.Done) {
		return "", fmt.Errorf("社員ID %s のユーザーが見つかりません", employeeID)
	}
	if err != nil {
		return "", err
	}
	return snap.Ref.ID, nil
}

// generatePassword は暗号論的に安全な乱数から初期パスワードを生成する。
// 紛らわしい文字（0/O/1/l/I）は除いている。
func generatePassword() (string, error) {
	const charset = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	buf := make([]byte, passwordLength)
	for i := range buf {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(charset))))
		if err != nil {
			return "", err
		}
		buf[i] = charset[n.Int64()]
	}
	return string(buf), nil
}
