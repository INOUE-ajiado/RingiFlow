import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { environment } from '../../environments/environment';
import {
  Attachment,
  AuditLog,
  RingiAction,
  RingiRequest,
  RingiStatus,
  SummaryItem,
} from './models';

export interface CreateRingiInput {
  title: string;
  content: string;
  amount: number;
  /** 決裁希望日（YYYY-MM-DD）。未指定は空文字。 */
  dueDate?: string;
  /** 概要欄の項目。 */
  summary?: SummaryItem[];
}

export interface TransitionInput {
  comment?: string;
  /** 再申請時のみ有効。省略した項目は既存の値を維持する。 */
  title?: string;
  content?: string;
  amount?: number;
  dueDate?: string;
  summary?: SummaryItem[];
}

export interface RingiDetail {
  request: RingiRequest;
  history: AuditLog[];
}

export type ListScope = 'all' | 'mine' | 'inbox';

export interface ListQuery {
  scope?: ListScope;
  /** 絞り込むステータス。空の場合は絞り込まない。 */
  statuses?: RingiStatus[];
  /** 申請日時の範囲（YYYY-MM-DD、日本時間）。to は指定日の終わりまでを含む。 */
  from?: string;
  to?: string;
  /** 稟議番号・タイトル・内容・申請者に対する部分一致。 */
  keyword?: string;
  limit?: number;
  /** 前回の応答が返した nextCursor。続きを読み込むときに指定する。 */
  cursor?: string;
}

export interface ListResult {
  items: RingiRequest[];
  /** 次ページが存在する場合のカーソル。無い場合は空文字。 */
  nextCursor: string;
  /** キーワード検索が走査上限に達し、調べきれなかったことを示す。 */
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

  list(query: ListQuery = {}): Promise<ListResult> {
    let params = new HttpParams();
    if (query.scope) params = params.set('scope', query.scope);
    if (query.statuses?.length) params = params.set('status', query.statuses.join(','));
    if (query.from) params = params.set('from', query.from);
    if (query.to) params = params.set('to', query.to);
    if (query.keyword) params = params.set('q', query.keyword);
    if (query.limit) params = params.set('limit', String(query.limit));
    if (query.cursor) params = params.set('cursor', query.cursor);

    return firstValueFrom(this.http.get<ListResult>(this.base, { params })).then((res) => ({
      items: res.items ?? [],
      nextCursor: res.nextCursor ?? '',
      truncated: res.truncated ?? false,
    }));
  }

  get(id: string): Promise<RingiDetail> {
    return firstValueFrom(this.http.get<RingiDetail>(`${this.base}/${id}`));
  }

  create(input: CreateRingiInput): Promise<{ requestId: string }> {
    return firstValueFrom(this.http.post<{ requestId: string }>(this.base, input));
  }

  /** 承認・差し戻し・却下・再申請・取り下げを実行する。 */
  transition(id: string, action: RingiAction, input: TransitionInput = {}): Promise<void> {
    return firstValueFrom(this.http.post<void>(`${this.base}/${id}/${action}`, input));
  }

  uploadAttachment(id: string, file: File): Promise<{ attachment: Attachment }> {
    const form = new FormData();
    form.append('file', file, file.name);
    return firstValueFrom(
      this.http.post<{ attachment: Attachment }>(`${this.base}/${id}/attachments`, form),
    );
  }

  deleteAttachment(id: string, attachmentId: string): Promise<void> {
    return firstValueFrom(
      this.http.delete<void>(`${this.base}/${id}/attachments/${attachmentId}`),
    );
  }

  /**
   * 添付ファイルを取得して保存する。
   *
   * APIは認証トークンを要求するため、単純なリンクでは取得できない。
   * 内容を取得したうえで一時的なURLを作り、ダウンロードを発火させる。
   */
  async downloadAttachment(id: string, attachment: Attachment): Promise<void> {
    const blob = await firstValueFrom(
      this.http.get(`${this.base}/${id}/attachments/${attachment.id}`, { responseType: 'blob' }),
    );
    const url = URL.createObjectURL(blob);
    try {
      const link = document.createElement('a');
      link.href = url;
      link.download = attachment.fileName;
      link.click();
    } finally {
      // 発火後すぐに解放するとダウンロードが中断される場合があるため猶予を置く
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  }
}

/** APIのエラーレスポンスから日本語メッセージを取り出す。 */
export function apiErrorMessage(error: unknown): string {
  const message = (error as { error?: { message?: string } })?.error?.message;
  return message ?? '処理に失敗しました。時間をおいて再度お試しください。';
}
