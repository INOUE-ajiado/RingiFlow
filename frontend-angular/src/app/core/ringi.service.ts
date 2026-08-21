import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { environment } from '../../environments/environment';
import { AuditLog, RingiAction, RingiRequest } from './models';

export interface CreateRingiInput {
  title: string;
  content: string;
  amount: number;
}

export interface TransitionInput {
  comment?: string;
  /** 再申請時のみ有効。省略した項目は既存の値を維持する。 */
  title?: string;
  content?: string;
  amount?: number;
}

export interface RingiDetail {
  request: RingiRequest;
  history: AuditLog[];
}

export type ListScope = 'all' | 'mine' | 'inbox';

export interface ListResult {
  items: RingiRequest[];
  /** 件数上限で結果が打ち切られたか。true のとき画面に警告を表示する。 */
  truncated: boolean;
}

/**
 * Go バックエンドAPI との通信。
 *
 * 基本設計書 4.2節の方針により Firestore への直接アクセスは行わないため、
 * 読み取りを含むすべてのデータアクセスは本サービスを経由する。
 */
@Injectable({ providedIn: 'root' })
export class RingiService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiBaseUrl}/api/v1/ringi`;

  list(scope: ListScope = 'all'): Promise<ListResult> {
    return firstValueFrom(this.http.get<ListResult>(this.base, { params: { scope } })).then(
      (res) => ({ items: res.items ?? [], truncated: res.truncated ?? false }),
    );
  }

  get(id: string): Promise<RingiDetail> {
    return firstValueFrom(this.http.get<RingiDetail>(`${this.base}/${id}`));
  }

  create(input: CreateRingiInput): Promise<{ requestId: string }> {
    return firstValueFrom(this.http.post<{ requestId: string }>(this.base, input));
  }

  /** 承認・差し戻し・却下・再申請を実行する。 */
  transition(id: string, action: RingiAction, input: TransitionInput = {}): Promise<void> {
    return firstValueFrom(
      this.http.post<void>(`${this.base}/${id}/${action}`, input),
    );
  }
}

/** APIのエラーレスポンスから日本語メッセージを取り出す。 */
export function apiErrorMessage(error: unknown): string {
  const message = (error as { error?: { message?: string } })?.error?.message;
  return message ?? '処理に失敗しました。時間をおいて再度お試しください。';
}
