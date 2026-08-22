import { CurrencyPipe, DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { AuthService } from '../core/auth.service';
import {
  ACTION_LABELS,
  Attachment,
  FIELD_LABELS,
  FieldChange,
  AuditLog,
  LogAction,
  RingiAction,
  RingiRequest,
  RingiStatus,
  approvalRoute,
  availableActions,
  canModifyAttachments,
  formatFieldValue,
  formatFileSize,
  requiresCEOApproval,
} from '../core/models';
import { RingiService, apiErrorMessage } from '../core/ringi.service';
import { ActionDialog } from '../shared/action-dialog';
import { Icon } from '../shared/icon';
import { StatusBadge } from '../shared/status-badge';

/** 承認印の状態。 */
type StampState = 'approved' | 'current' | 'pending';

/** 承認印1枠の表示内容。 */
interface Stamp {
  status: RingiStatus;
  label: string;
  state: StampState;
  /** 承認済のときの承認者名。 */
  actor: string;
}

/**
 * 稟議の詳細と承認履歴を表示する。
 * 実行可能な操作は現在のステータスとログインユーザーのロールから判定して動的に表示する
 * （基本設計書 3.3 / 6.1節）。最終的な可否判定は常にバックエンドが行う。
 */
@Component({
  selector: 'app-ringi-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, DatePipe, CurrencyPipe, StatusBadge, ActionDialog, Icon],
  template: `
    <div class="page-nav">
      <a routerLink="/ringi" class="back">
        <app-icon name="arrow-left" [size]="16" />
        一覧へ戻る
      </a>
      @if (request(); as req) {
        <a [routerLink]="['/ringi', req.id, 'print']" class="btn btn-secondary btn-sm">
          <app-icon name="print" [size]="14" />
          印刷 / PDF
        </a>
      }
    </div>

    @if (loading()) {
      <div class="empty-state loading">
        <app-icon name="spinner" [size]="24" />
        読み込んでいます...
      </div>
    } @else if (loadError()) {
      <div class="card empty-state">
        <p class="error-message">{{ loadError() }}</p>
      </div>
    } @else if (request(); as req) {
      <article class="card sheet">
        <!-- 表紙: 稟議書のヘッダー -->
        <header class="sheet-head">
          <div class="head-main">
            <div class="title-block">
              <h1>稟議書</h1>
              <p class="head-en">APPROVAL REQUEST FORM</p>
            </div>
            <dl class="head-dates">
              <div>
                <dt>起案日</dt>
                <dd>{{ req.createdAt | date: 'yyyy年M月d日' }}</dd>
              </div>
              @if (req.dueDate) {
                <div>
                  <dt>決裁希望日</dt>
                  <dd>{{ req.dueDate | date: 'yyyy年M月d日' }}</dd>
                </div>
              }
            </dl>
          </div>
          <div class="head-rule"></div>
        </header>

        <div class="sheet-body">
          <!-- 起案者情報と承認印 -->
          <div class="applicant-row">
            <dl class="applicant">
              <div>
                <dt>所属</dt>
                <dd>{{ req.department || '—' }}</dd>
              </div>
              <div>
                <dt>氏名</dt>
                <dd>{{ req.applicantName }}（{{ req.applicantEmployeeId }}）</dd>
              </div>
              <div>
                <dt>稟議番号</dt>
                <dd class="tnum">{{ req.requestNo }}</dd>
              </div>
            </dl>

            <!-- 承認印。ルート上の各段階の状態を示す -->
            <div class="stamps">
              @for (stamp of stamps(); track stamp.status) {
                <div class="stamp">
                  <span class="stamp-label">{{ stamp.label }}</span>
                  <div class="stamp-mark" [class]="stamp.state">
                    @switch (stamp.state) {
                      @case ('approved') {
                        <app-icon name="check" [size]="18" />
                        <span class="stamp-name">{{ stamp.actor }}</span>
                      }
                      @case ('current') {
                        <span class="stamp-text">審査中</span>
                      }
                      @default {
                        <span class="stamp-text">未</span>
                      }
                    }
                  </div>
                </div>
              }
            </div>
          </div>

          <div class="status-row">
            <app-status-badge [status]="req.status" />
            @if (routeNote()) {
              <span class="route-note">{{ routeNote() }}</span>
            }
          </div>

          <!-- 件名 -->
          <section class="block">
            <h2 class="block-label">件名</h2>
            <p class="subject">{{ req.title }}</p>
          </section>

          <!-- 概要 -->
          <section class="block">
            <h2 class="block-label">概要</h2>
            <table class="summary">
              <tbody>
                @if (req.amount > 0 || !summaryItems().length) {
                  <tr>
                    <th>金額</th>
                    <td class="tnum amount">
                      {{ req.amount | currency: 'JPY' : 'symbol' : '1.0-0' }}
                    </td>
                  </tr>
                }
                @for (item of summaryItems(); track $index) {
                  <tr>
                    <th>{{ item.label }}</th>
                    <td>{{ item.value }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </section>

          <!-- 申請理由・目的 -->
          <section class="block">
            <h2 class="block-label">申請理由・目的</h2>
            <p class="purpose">{{ req.content }}</p>
          </section>

          <!-- 添付資料 -->
          <section class="block">
            <div class="block-head">
              <h2 class="block-label">
                <app-icon name="paperclip" [size]="13" />
                添付資料・備考
              </h2>
              @if (canEditAttachments()) {
                <label class="btn btn-secondary btn-sm upload">
                  {{ uploading() ? 'アップロード中...' : 'ファイルを追加' }}
                  <input
                    type="file"
                    hidden
                    [disabled]="uploading()"
                    (change)="onFileSelected($event)"
                  />
                </label>
              }
            </div>

            @if (attachmentError()) {
              <p class="error-message">{{ attachmentError() }}</p>
            }

            @if (attachments().length === 0) {
              <p class="empty">添付資料はありません。</p>
            } @else {
              <ul class="file-list">
                @for (file of attachments(); track file.id) {
                  <li>
                    <button type="button" class="file-name" (click)="download(file)">
                      {{ file.fileName }}
                    </button>
                    <span class="file-meta">
                      {{ fileSize(file.size) }} ・ {{ file.uploadedByName }}
                    </span>
                    @if (canEditAttachments()) {
                      <button
                        type="button"
                        class="icon-btn icon-btn-danger file-remove"
                        [attr.aria-label]="file.fileName + ' を削除'"
                        (click)="removeAttachment(file)"
                      >
                        <app-icon name="trash" [size]="16" />
                      </button>
                    }
                  </li>
                }
              </ul>
            }
          </section>

          <p class="closing">以上</p>
        </div>

        @if (actions().length > 0) {
          <footer class="sheet-actions">
            @for (action of actions(); track action) {
              @if (action === 'resubmit') {
                <a [routerLink]="['/ringi', req.id, 'edit']" class="btn btn-primary">
                  修正して再申請
                </a>
              } @else {
                <button
                  type="button"
                  class="btn"
                  [class]="buttonClass(action)"
                  (click)="open(action)"
                >
                  {{ label(action) }}
                </button>
              }
            }
          </footer>
        }
      </article>

      <section class="card panel history">
        <h2>承認履歴</h2>
        @if (history().length === 0) {
          <p class="empty">履歴はまだありません。</p>
        } @else {
          <ol class="timeline">
            @for (log of history(); track $index; let first = $first) {
              <li>
                <app-icon class="pip" [name]="first ? 'dot' : 'circle'" [size]="12" />
                <div class="line">
                  <span class="action">{{ label(log.action) }}</span>
                  <span class="actor">{{ log.actorName }}</span>
                  <time>{{ log.timestamp | date: 'yyyy/MM/dd HH:mm' }}</time>
                </div>
                @if (log.comment) {
                  <p class="comment">{{ log.comment }}</p>
                }
                @if (log.changes?.length) {
                  <ul class="changes">
                    @for (change of log.changes; track change.field) {
                      <li>
                        <span class="change-field">{{ fieldLabel(change.field) }}</span>
                        <span class="change-before">{{ fieldValue(change, 'before') }}</span>
                        <app-icon name="chevron-right" [size]="12" />
                        <span class="change-after">{{ fieldValue(change, 'after') }}</span>
                      </li>
                    }
                  </ul>
                }
              </li>
            }
          </ol>
        }
      </section>
    }

    @if (pendingAction(); as action) {
      <app-action-dialog
        [action]="action"
        [busy]="busy()"
        [errorMessage]="actionError()"
        (confirmed)="execute(action, $event)"
        (cancelled)="close()"
      />
    }
  `,
  styles: `
    .page-nav {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
      margin-bottom: var(--space-4);
    }

    .back {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
      font-size: var(--text-sm);
      font-weight: 600;
      color: var(--text-muted);
      text-decoration: none;

      &:hover {
        color: var(--accent);
      }
    }

    .loading {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--space-3);
      color: var(--text-muted);

      app-icon {
        color: var(--accent);
      }
    }

    /* ==== 稟議書 ==== */
    .sheet {
      overflow: hidden;
      margin-bottom: var(--space-4);
    }

    .sheet-head {
      padding: var(--space-6) var(--space-6) 0;
      background: var(--gray-900);
      color: var(--gray-0);
    }

    .head-main {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: var(--space-5);
      flex-wrap: wrap;
      padding-bottom: var(--space-4);
    }

    .title-block h1 {
      margin: 0;
      font-size: var(--text-2xl);
      letter-spacing: 0.35em;
      color: var(--gray-0);
    }

    .head-en {
      margin: var(--space-1) 0 0;
      font-size: 10px;
      letter-spacing: 0.2em;
      color: var(--gray-400);
    }

    .head-dates {
      display: flex;
      gap: var(--space-5);
      margin: 0;
      text-align: right;
    }

    .head-dates div {
      margin: 0;
    }

    .head-dates dt {
      font-size: 10px;
      color: var(--gray-400);
      margin-bottom: 2px;
    }

    .head-dates dd {
      margin: 0;
      font-size: var(--text-sm);
      color: var(--gray-0);
      font-variant-numeric: tabular-nums;
    }

    /* 見出し下のアクセント線 */
    .head-rule {
      height: 4px;
      width: 5rem;
      background: var(--accent);
      border-radius: 2px 2px 0 0;
    }

    .sheet-body {
      padding: var(--space-6);
    }

    /* ==== 起案者と承認印 ==== */
    .applicant-row {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: var(--space-5);
      flex-wrap: wrap;
      margin-bottom: var(--space-5);
    }

    .applicant {
      margin: 0;
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
      min-width: 16rem;
      flex: 1 1 16rem;
    }

    .applicant div {
      display: flex;
      align-items: baseline;
      gap: var(--space-3);
      margin: 0;
      padding-bottom: var(--space-2);
      border-bottom: 1px solid var(--border-subtle);
    }

    .applicant dt {
      flex: none;
      width: 5rem;
      font-size: var(--text-xs);
      font-weight: 700;
      color: var(--text-muted);
    }

    .applicant dd {
      margin: 0;
      font-size: var(--text-base);
      font-weight: 600;
      color: var(--text-strong);
    }

    /* 承認印。丸枠で押印欄を模す */
    .stamps {
      display: flex;
      gap: var(--space-3);
    }

    .stamp {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--space-1);
    }

    .stamp-label {
      font-size: 10px;
      font-weight: 700;
      color: var(--text-muted);
    }

    .stamp-mark {
      width: 3.5rem;
      height: 3.5rem;
      border-radius: 50%;
      border: 1px dashed var(--border);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 1px;
      color: var(--text-faint);
      background: var(--bg-subtle);
    }

    .stamp-mark.approved {
      border-style: solid;
      border-color: var(--success-600);
      color: var(--success-600);
      background: var(--success-50);
    }

    .stamp-mark.current {
      border-color: var(--accent);
      color: var(--accent);
      background: var(--accent-soft);
    }

    .stamp-text {
      font-size: 10px;
      font-weight: 700;
    }

    .stamp-name {
      font-size: 9px;
      font-weight: 700;
      max-width: 3rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .status-row {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      flex-wrap: wrap;
      padding: var(--space-3) 0;
      margin-bottom: var(--space-5);
      border-top: 1px solid var(--border-subtle);
      border-bottom: 1px solid var(--border-subtle);
    }

    .route-note {
      font-size: var(--text-xs);
      color: var(--text-muted);
    }

    /* ==== 各ブロック ==== */
    .block {
      margin-bottom: var(--space-6);
    }

    .block-label {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      margin: 0 0 var(--space-3);
      padding-left: var(--space-3);
      font-size: var(--text-sm);
      font-weight: 700;
      color: var(--text-strong);
      position: relative;
    }

    /* 見出し左の縦棒 */
    .block-label::before {
      content: '';
      position: absolute;
      left: 0;
      top: 0.15em;
      bottom: 0.15em;
      width: 3px;
      border-radius: 2px;
      background: var(--text-strong);
    }

    .block-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
      margin-bottom: var(--space-3);

      .block-label {
        margin-bottom: 0;
      }
    }

    .subject {
      margin: 0;
      padding-left: var(--space-3);
      font-size: var(--text-xl);
      font-weight: 600;
      line-height: 1.5;
      color: var(--text-strong);
    }

    /* 概要テーブル */
    .summary {
      width: 100%;
      border-collapse: collapse;
      border-top: 1px solid var(--border);
    }

    .summary th {
      width: 8rem;
      text-align: left;
      padding: var(--space-3);
      font-size: var(--text-xs);
      font-weight: 700;
      color: var(--text-muted);
      background: var(--bg-subtle);
      border-bottom: 1px solid var(--border-subtle);
      vertical-align: top;
    }

    .summary td {
      padding: var(--space-3);
      font-size: var(--text-base);
      color: var(--text-strong);
      border-bottom: 1px solid var(--border-subtle);
      line-height: 1.7;
    }

    .summary .amount {
      font-weight: 700;
    }

    .purpose {
      margin: 0;
      padding: var(--space-4) var(--space-5);
      background: var(--bg-subtle);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      white-space: pre-wrap;
      line-height: 2;
      color: var(--text-body);
    }

    /* 添付資料 */
    .file-list {
      list-style: none;
      margin: 0;
      padding: 0;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      overflow: hidden;
    }

    .file-list li {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: var(--space-1) var(--space-3);
      padding: var(--space-3) var(--space-4);
      background: var(--bg-surface);
      border-bottom: 1px solid var(--border-subtle);

      &:last-child {
        border-bottom: none;
      }

      &:hover {
        background: var(--bg-subtle);
      }
    }

    .file-name {
      background: none;
      border: none;
      padding: 0;
      font-family: inherit;
      font-size: var(--text-sm);
      font-weight: 600;
      color: var(--accent);
      cursor: pointer;
      text-align: left;

      &:hover {
        color: var(--accent-hover);
      }
    }

    .file-meta {
      font-size: var(--text-xs);
      color: var(--text-muted);
    }

    .file-remove {
      margin-left: auto;
    }

    .empty {
      margin: 0;
      padding: var(--space-4);
      border: 1px dashed var(--border);
      border-radius: var(--radius-sm);
      text-align: center;
      color: var(--text-muted);
      font-size: var(--text-sm);
    }

    .closing {
      margin: var(--space-6) 0 0;
      text-align: center;
      font-size: var(--text-xs);
      letter-spacing: 0.5em;
      color: var(--text-faint);
    }

    /* ==== 操作 ==== */
    .sheet-actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      justify-content: flex-end;
      padding: var(--space-4) var(--space-6);
      background: var(--bg-subtle);
      border-top: 1px solid var(--border-subtle);
    }

    /* ==== 承認履歴 ==== */
    .panel {
      padding: var(--space-5) var(--space-6);
    }

    .history h2 {
      font-size: var(--text-sm);
      font-weight: 700;
      color: var(--text-muted);
      margin: 0 0 var(--space-4);
    }

    .timeline {
      list-style: none;
      margin: 0;
      padding: 0 0 0 var(--space-5);
      border-left: 2px solid var(--border-subtle);
    }

    .timeline li {
      position: relative;
      padding-bottom: var(--space-5);

      &:last-child {
        padding-bottom: 0;
      }
    }

    .pip {
      position: absolute;
      left: calc(var(--space-5) * -1 - 7px);
      top: 0.35rem;
      color: var(--border);
      background: var(--bg-surface);
      border-radius: 50%;
    }

    .timeline li:first-child .pip {
      color: var(--accent);
    }

    .line {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: var(--space-2) var(--space-3);
    }

    .action {
      font-size: var(--text-sm);
      font-weight: 700;
      color: var(--text-strong);
    }

    .actor {
      font-size: var(--text-sm);
      color: var(--text-body);
    }

    time {
      font-size: var(--text-xs);
      color: var(--text-muted);
      font-variant-numeric: tabular-nums;
      margin-left: auto;
    }

    .comment {
      margin: var(--space-2) 0 0;
      padding: var(--space-3) var(--space-4);
      background: var(--bg-inset);
      border-radius: var(--radius-sm);
      font-size: var(--text-sm);
      line-height: 1.75;
      white-space: pre-wrap;
      color: var(--text-body);
    }

    /* 再申請の変更差分 */
    .changes {
      list-style: none;
      margin: var(--space-2) 0 0;
      padding: var(--space-2) var(--space-3);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      background: var(--bg-subtle);
    }

    .changes li {
      display: flex;
      align-items: baseline;
      flex-wrap: wrap;
      gap: var(--space-1) var(--space-2);
      padding: var(--space-1) 0;
      font-size: var(--text-xs);
      line-height: 1.7;

      app-icon {
        color: var(--text-faint);
        align-self: center;
      }
    }

    .change-field {
      flex: none;
      min-width: 4.5rem;
      font-weight: 700;
      color: var(--text-muted);
    }

    .change-before {
      color: var(--text-muted);
      text-decoration: line-through;
      text-decoration-color: var(--text-faint);
      word-break: break-word;
    }

    .change-after {
      color: var(--text-strong);
      font-weight: 600;
      word-break: break-word;
    }

    @media (max-width: 44rem) {
      .sheet-head,
      .sheet-body,
      .sheet-actions,
      .panel {
        padding-left: var(--space-4);
        padding-right: var(--space-4);
      }

      .head-dates {
        text-align: left;
      }

      .stamps {
        width: 100%;
      }

      time {
        margin-left: 0;
      }

      .sheet-actions .btn {
        flex: 1 1 auto;
      }
    }
  `,
})
export class RingiDetailComponent {
  private readonly ringi = inject(RingiService);
  private readonly auth = inject(AuthService);

  readonly id = input.required<string>();

  readonly request = signal<RingiRequest | null>(null);
  readonly history = signal<AuditLog[]>([]);
  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);

  readonly pendingAction = signal<RingiAction | null>(null);
  readonly busy = signal(false);
  readonly actionError = signal<string | null>(null);

  readonly uploading = signal(false);
  readonly attachmentError = signal<string | null>(null);

  readonly attachments = computed(() => this.request()?.attachments ?? []);

  readonly summaryItems = computed(() => this.request()?.summary ?? []);

  /**
   * 承認印の状態。金額に応じたルート（3.6節）の各段階を、
   * 現在のステータスと承認履歴から「承認済 / 審査中 / 未」に振り分ける。
   *
   * 承認者名は監査ログから引く。ルート上の段階と履歴の承認操作は
   * 順番に対応するため、n段目の承認は n 番目の approve に当たる。
   */
  readonly stamps = computed<Stamp[]>(() => {
    const req = this.request();
    const steps = this.route();
    if (!req) return [];

    // 履歴は新しい順なので、古い順に直してから承認だけを取り出す
    const approvals = [...this.history()]
      .reverse()
      .filter((log) => log.action === 'approve');

    return steps.map((step, index) => {
      const approval = approvals[index];
      let state: StampState = 'pending';
      if (approval) {
        state = 'approved';
      } else if (req.status === step.status) {
        state = 'current';
      }
      return { status: step.status, label: step.label, state, actor: approval?.actorName ?? '' };
    });
  });

  /**
   * 金額に応じた承認ルート。閾値はサーバーから配られた設定値を用いる。
   * 金額は再申請時に変更されうるため、都度その時点の金額から求める。
   */
  readonly route = computed(() => {
    const req = this.request();
    const threshold = this.auth.config()?.ceoApprovalThreshold;
    return req && threshold !== undefined ? approvalRoute(req.amount, threshold) : [];
  });

  readonly routeNote = computed(() => {
    const req = this.request();
    const threshold = this.auth.config()?.ceoApprovalThreshold;
    if (!req || threshold === undefined) return '';
    return requiresCEOApproval(req.amount, threshold)
      ? `${threshold.toLocaleString()}円以上のため、代表決裁を要します。`
      : `${threshold.toLocaleString()}円未満のため、プロデューサー承認をもって決裁完了となります。`;
  });

  /** 添付の追加・削除が可能か（申請者本人かつ決裁確定前）。 */
  readonly canEditAttachments = computed(() => {
    const req = this.request();
    const user = this.auth.appUser();
    return !!req && !!user && canModifyAttachments(req, user);
  });

  /** 現在のステータスとロールから実行可能な操作を求める。 */
  readonly actions = computed(() => {
    const req = this.request();
    const user = this.auth.appUser();
    return req && user ? availableActions(req, user) : [];
  });

  constructor() {
    queueMicrotask(() => void this.load());
  }

  label(action: LogAction): string {
    return ACTION_LABELS[action];
  }

  fieldLabel(field: string): string {
    return FIELD_LABELS[field] ?? field;
  }

  /** 差分の値を表示用に整える。長い本文は途中で省略する。 */
  fieldValue(change: FieldChange, side: 'before' | 'after'): string {
    const formatted = formatFieldValue(change.field, change[side]);
    return formatted.length > 60 ? formatted.slice(0, 60) + '…' : formatted;
  }

  fileSize(bytes: number): string {
    return formatFileSize(bytes);
  }

  /** その承認段階を通過済みか（現在位置より前にあるか）。 */
  stepDone(status: RingiStatus): boolean {
    const req = this.request();
    if (!req) return false;
    if (req.status === 'approved') return true;
    const steps = this.route();
    const currentIndex = steps.findIndex((s) => s.status === req.status);
    const stepIndex = steps.findIndex((s) => s.status === status);
    // 現在位置が承認待ちでない（差し戻し等）場合は通過判定を行わない
    return currentIndex >= 0 && stepIndex >= 0 && stepIndex < currentIndex;
  }

  /** ファイル選択ダイアログで選ばれたファイルを添付する。 */
  async onFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    // 同じファイルを続けて選べるよう、値を毎回クリアする
    input.value = '';
    if (!file) return;

    this.uploading.set(true);
    this.attachmentError.set(null);
    try {
      await this.ringi.uploadAttachment(this.id(), file);
      await this.load();
    } catch (err) {
      this.attachmentError.set(apiErrorMessage(err));
    } finally {
      this.uploading.set(false);
    }
  }

  async download(attachment: Attachment): Promise<void> {
    this.attachmentError.set(null);
    try {
      await this.ringi.downloadAttachment(this.id(), attachment);
    } catch {
      this.attachmentError.set('ファイルの取得に失敗しました。');
    }
  }

  async removeAttachment(attachment: Attachment): Promise<void> {
    if (!confirm(`「${attachment.fileName}」を削除します。よろしいですか？`)) return;

    this.attachmentError.set(null);
    try {
      await this.ringi.deleteAttachment(this.id(), attachment.id);
      await this.load();
    } catch (err) {
      this.attachmentError.set(apiErrorMessage(err));
    }
  }

  buttonClass(action: RingiAction): string {
    switch (action) {
      case 'approve':
        return 'btn-success';
      case 'return':
        return 'btn-warning';
      case 'reject':
        return 'btn-danger';
      case 'withdraw':
        return 'btn-secondary';
      default:
        return 'btn-primary';
    }
  }

  open(action: RingiAction): void {
    this.actionError.set(null);
    this.pendingAction.set(action);
  }

  close(): void {
    this.pendingAction.set(null);
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.loadError.set(null);
    try {
      const detail = await this.ringi.get(this.id());
      this.request.set(detail.request);
      this.history.set(detail.history);
    } catch (err) {
      this.loadError.set(apiErrorMessage(err));
    } finally {
      this.loading.set(false);
    }
  }

  async execute(action: RingiAction, comment: string): Promise<void> {
    this.busy.set(true);
    this.actionError.set(null);
    try {
      await this.ringi.transition(this.id(), action, { comment });
      this.pendingAction.set(null);
      await this.load();
    } catch (err) {
      // 他の承認者が先に処理した場合（409）もここに到達する。
      // 最新の状態を反映するため再読み込みしたうえでエラーを表示する。
      this.actionError.set(apiErrorMessage(err));
      await this.load();
    } finally {
      this.busy.set(false);
    }
  }
}
