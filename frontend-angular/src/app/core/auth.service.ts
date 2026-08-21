import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import {
  User as FirebaseUser,
  onAuthStateChanged,
  signInWithEmailAndPassword,
} from 'firebase/auth';
import { firstValueFrom } from 'rxjs';

import { environment } from '../../environments/environment';
import { FIREBASE_AUTH } from './firebase';
import { AppUser } from './models';

/**
 * 認証状態の管理。
 *
 * 本システムは当面スタンドアロンのテストシステムとして運用し、認証・権限は
 * 統合先システムから受け取る想定である。そのためログイン画面は設けず、
 * 起動時に role=master のマスターユーザーで自動ログインする。
 *
 * Firebase Auth と JWT 検証の仕組みはそのまま残しているため、統合時は
 * ここでの自動ログインを実際の認証へ差し替えるだけでよい。
 *
 * 権限ロールはクライアントで判断せず、必ず Go バックエンドAPI の
 * /api/v1/me から取得する。
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly auth = inject(FIREBASE_AUTH);
  private readonly http = inject(HttpClient);

  /** ログイン中のユーザー情報（氏名・社員ID・ロール）。未確立時は null。 */
  readonly appUser = signal<AppUser | null>(null);

  /** 自動ログインの試行が完了したか（成否は問わない）。 */
  readonly ready = signal(false);

  /** 自動ログインに失敗した場合のメッセージ。 */
  readonly error = signal<string | null>(null);

  private readonly readyPromise = this.bootstrap();

  /** 自動ログインの完了を待つ。 */
  whenReady(): Promise<void> {
    return this.readyPromise;
  }

  private async bootstrap(): Promise<void> {
    try {
      // 既存のセッションがあれば再利用し、なければマスターで自動ログインする。
      if (!(await this.restoreSession())) {
        const { employeeId, password } = environment.masterUser;
        await signInWithEmailAndPassword(this.auth, toAuthEmail(employeeId), password);
      }
      this.appUser.set(await this.fetchMe());
    } catch (err) {
      this.error.set(bootstrapErrorMessage(err));
      this.appUser.set(null);
    } finally {
      this.ready.set(true);
    }
  }

  /** Firebase が保持している既存セッションの有無を解決する。 */
  private restoreSession(): Promise<FirebaseUser | null> {
    return new Promise((resolve) => {
      const unsubscribe = onAuthStateChanged(this.auth, (user) => {
        unsubscribe();
        resolve(user);
      });
    });
  }

  private fetchMe(): Promise<AppUser> {
    return firstValueFrom(this.http.get<AppUser>(`${environment.apiBaseUrl}/api/v1/me`));
  }
}

/** 社員IDを認証用メールアドレスへ変換する（基本設計書 3.4節）。 */
export function toAuthEmail(employeeId: string): string {
  return `${employeeId.trim()}@${environment.authEmailDomain}`;
}

/** 自動ログイン失敗時のエラーメッセージを組み立てる。 */
export function bootstrapErrorMessage(error: unknown): string {
  const code = (error as { code?: string })?.code ?? '';
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'マスターユーザーでログインできませんでした。アカウントが発行されているか確認してください。';
    case 'auth/network-request-failed':
      return 'ネットワークに接続できません。通信状況をご確認ください。';
    case 'auth/too-many-requests':
      return '試行回数が上限に達しました。しばらく時間をおいて再度お試しください。';
    default:
      return 'システムの初期化に失敗しました。バックエンドAPIが起動しているか確認してください。';
  }
}
