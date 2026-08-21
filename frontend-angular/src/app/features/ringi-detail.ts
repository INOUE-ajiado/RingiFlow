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
    <a routerLink="/ringi" class="back">
      <app-icon name="arrow-left" [size]="16" />
      一覧へ戻る
    </a>

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
      <article class="card panel">
        <header>
          <div class="head-row">
            <span class="request-no">{{ req.requestNo }}</span>
            <app-status-badge [status]="req.status" />
          </div>
          <h1>{{ req.title }}</h1>
        </header>

        <dl class="meta">
          <div>
            <dt>申請者</dt>
            <dd>{{ req.applicantName }}（{{ req.applicantEmployeeId }}）</dd>
          </div>
          <div>
            <dt>金額</dt>
            <dd class="amount">{{ req.amount | currency: 'JPY' : 'symbol' : '1.0-0' }}</dd>
          </div>
          <div>
            <dt>申請日時</dt>
            <dd>{{ req.createdAt | date: 'yyyy/MM/dd HH:mm' }}</dd>
          </div>
          <div>
            <dt>最終更新</dt>
            <dd>{{ req.updatedAt | date: 'yyyy/MM/dd HH:mm' }}</dd>
          </div>
        </dl>

        <section class="route">
          <h2>承認ルート</h2>
          <ol class="steps">
            @for (step of route(); track step.status; let first = $first) {
              @if (!first) {
                <li class="sep" aria-hidden="true"><app-icon name="chevron-right" [size]="14" /></li>
              }
              <li [class.done]="stepDone(step.status)" [class.current]="req.status === step.status">
                {{ step.label }}
              </li>
            }
            <li class="sep" aria-hidden="true"><app-icon name="chevron-right" [size]="14" /></li>
            <li class="final" [class.done]="req.status === 'approved'">
              @if (req.status === 'approved') {
                <app-icon name="check" [size]="14" />
              }
              決裁完了
            </li>
          </ol>
          @if (routeNote()) {
            <p class="route-note">{{ routeNote() }}</p>
          }
        </section>

        <section class="content">
          <h2>申請内容</h2>
          <p>{{ req.content }}</p>
        </section>

        <section class="attachments">
          <div class="section-head">
            <h2><app-icon name="paperclip" [size]="14" />添付ファイル</h2>
            @if (canEditAttachments()) {
              <label class="btn btn-secondary upload">
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
            <p class="empty">添付ファイルはありません。</p>
          } @else {
            <ul class="file-list">
              @for (file of attachments(); track file.id) {
                <li>
                  <button type="button" class="file-name" (click)="download(file)">
                    {{ file.fileName }}
                  </button>
                  <span class="file-meta">
                    {{ fileSize(file.size) }} ・ {{ file.uploadedByName }} ・
                    {{ file.uploadedAt | date: 'yyyy/MM/dd HH:mm' }}
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

        @if (actions().length > 0) {
          <footer class="actions">
            @for (action of actions(); track action) {
              @if (action === 'resubmit') {
                <a [routerLink]="['/ringi', req.id, 'edit']" class="btn btn-primary">
                  修正して再申請
                </a>
              } @else {
                <button type="button" class="btn" [class]="buttonClass(action)" (click)="open(action)">
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
    .back {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
      margin-bottom: var(--space-4);
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

    .panel {
      padding: var(--space-5) var(--space-6);
      margin-bottom: var(--space-4);
    }

    .head-row {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      flex-wrap: wrap;
    }

    .request-no {
      font-size: var(--text-xs);
      font-weight: 700;
      letter-spacing: 0.04em;
      color: var(--text-muted);
      font-variant-numeric: tabular-nums;
    }

    header h1 {
      margin: var(--space-3) 0 0;
      font-size: var(--text-xl);
    }

    /* --- 属性 --- */
    .meta {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
      gap: var(--space-4) var(--space-5);
      margin: var(--space-5) 0;
      padding: var(--space-4) 0;
      border-top: 1px solid var(--border-subtle);
      border-bottom: 1px solid var(--border-subtle);
    }

    .meta div {
      margin: 0;
    }

    dt {
      font-size: var(--text-xs);
      font-weight: 600;
      color: var(--text-muted);
      margin-bottom: var(--space-1);
    }

    dd {
      margin: 0;
      font-size: var(--text-base);
      font-weight: 600;
      color: var(--text-strong);
    }

    .amount {
      font-variant-numeric: tabular-nums;
      font-size: var(--text-lg);
    }

    /* --- 節見出し --- */
    .content h2,
    .history h2,
    .attachments h2,
    .route h2 {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      font-size: var(--text-sm);
      font-weight: 700;
      letter-spacing: 0.02em;
      color: var(--text-muted);
      margin: 0 0 var(--space-3);
    }

    /* --- 承認ルート --- */
    .route {
      margin-bottom: var(--space-5);
    }

    .steps {
      list-style: none;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2);
      margin: 0;
      padding: 0;
    }

    .steps li {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.3rem 0.85rem;
      border-radius: var(--radius-full);
      border: 1px solid var(--border-subtle);
      background: var(--bg-inset);
      font-size: var(--text-xs);
      font-weight: 600;
      color: var(--text-muted);
    }

    /* ステップ間の区切り。枠を持たない矢印だけの項目 */
    .steps li.sep {
      padding: 0;
      border: none;
      background: none;
      color: var(--text-faint);
    }

    .steps li.done {
      background: var(--success-50);
      border-color: var(--success-200);
      color: var(--success-700);
    }

    .steps li.current {
      background: var(--accent);
      border-color: var(--accent);
      color: var(--text-on-accent);
      box-shadow: var(--shadow-xs);
    }

    .route-note {
      margin: var(--space-3) 0 0;
      font-size: var(--text-xs);
      color: var(--text-muted);
    }

    /* --- 申請内容 --- */
    .content p {
      margin: 0;
      white-space: pre-wrap;
      line-height: 1.9;
      color: var(--text-body);
    }

    /* --- 添付ファイル --- */
    .attachments {
      margin-top: var(--space-5);
      padding-top: var(--space-5);
      border-top: 1px solid var(--border-subtle);
    }

    .section-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-4);
      margin-bottom: var(--space-3);

      h2 {
        margin: 0;
      }
    }

    .upload {
      cursor: pointer;
      padding: 0.35rem 0.75rem;
      font-size: var(--text-xs);
    }

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
      transition: background-color var(--duration) var(--ease);

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
        text-decoration: underline;
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

    /* --- 操作 --- */
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      justify-content: flex-end;
      margin-top: var(--space-5);
      padding-top: var(--space-4);
      border-top: 1px solid var(--border-subtle);
    }

    /* --- 承認履歴 --- */
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

    /* 履歴の点。最新だけ塗りつぶし、それ以外は枠のみ */
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

    /* 再申請の変更差分。何が直ったかを履歴だけで追えるようにする */
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

    @media (max-width: 40rem) {
      .panel {
        padding: var(--space-4);
      }

      time {
        margin-left: 0;
      }

      .actions .btn {
        flex: 1 1 auto;
      }
    }  `,
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
