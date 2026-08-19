import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import {
  User as FirebaseUser,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth';
import { firstValueFrom } from 'rxjs';

import { environment } from '../../environments/environment';
import { FIREBASE_AUTH } from './firebase';
import { AppUser } from './models';

/**
 * 認証状態の管理。
 *
 * ユーザーが入力するのは社員IDとパスワードのみであり、社員IDは
 * `{社員ID}@{authEmailDomain}` へ変換したうえで Firebase Auth に渡す（基本設計書 3.4節）。
 *
 * 権限ロールはクライアントで判断せず、必ず Go バックエンドAPI の /api/v1/me から取得する。
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly auth = inject(FIREBASE_AUTH);
  private readonly http = inject(HttpClient);

  /** ログイン中のユーザー情報（氏名・社員ID・ロール）。未ログイン時は null。 */
  readonly appUser = signal<AppUser | null>(null);

  /** Firebase の認証状態の初期解決が完了したか。 */
  readonly ready = signal(false);

  private readyPromise: Promise<void>;

  constructor() {
    this.readyPromise = new Promise<void>((resolve) => {
      onAuthStateChanged(this.auth, async (user: FirebaseUser | null) => {
        if (user) {
          try {
            this.appUser.set(await this.fetchMe());
          } catch {
            // users ドキュメント未整備などで自身の情報を取得できない場合は
            // ログイン状態として扱わず、サインアウトさせる。
            await signOut(this.auth);
            this.appUser.set(null);
          }
        } else {
          this.appUser.set(null);
        }
        this.ready.set(true);
        resolve();
      });
    });
  }

  /** 認証状態の初期解決を待つ。ルートガードから使用する。 */
  whenReady(): Promise<void> {
    return this.readyPromise;
  }

  /** 社員IDとパスワードでログインする。 */
  async login(employeeId: string, password: string): Promise<void> {
    const email = toAuthEmail(employeeId);
    await signInWithEmailAndPassword(this.auth, email, password);
    this.appUser.set(await this.fetchMe());
  }

  async logout(): Promise<void> {
    await signOut(this.auth);
    this.appUser.set(null);
  }

  private fetchMe(): Promise<AppUser> {
    return firstValueFrom(this.http.get<AppUser>(`${environment.apiBaseUrl}/api/v1/me`));
  }
}

/** 社員IDを認証用メールアドレスへ変換する（基本設計書 3.4節）。 */
export function toAuthEmail(employeeId: string): string {
  return `${employeeId.trim()}@${environment.authEmailDomain}`;
}

/** Firebase Auth のエラーコードを日本語メッセージへ変換する。 */
export function authErrorMessage(error: unknown): string {
  const code = (error as { code?: string })?.code ?? '';
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return '社員IDまたはパスワードが正しくありません。';
    case 'auth/invalid-email':
      return '社員IDの形式が正しくありません。';
    case 'auth/user-disabled':
      return 'このアカウントは無効化されています。管理者にお問い合わせください。';
    case 'auth/too-many-requests':
      return '試行回数が上限に達しました。しばらく時間をおいて再度お試しください。';
    case 'auth/network-request-failed':
      return 'ネットワークに接続できません。通信状況をご確認ください。';
    default:
      return 'ログインに失敗しました。時間をおいて再度お試しください。';
  }
}
