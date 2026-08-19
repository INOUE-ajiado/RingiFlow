import { CurrencyPipe, DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import { AuthService } from '../core/auth.service';
import {
  ACTION_LABELS,
  AuditLog,
  RingiAction,
  RingiRequest,
  availableActions,
} from '../core/models';
import { RingiService, apiErrorMessage } from '../core/ringi.service';
import { ActionDialog } from '../shared/action-dialog';
import { StatusBadge } from '../shared/status-badge';

/**
 * 稟議の詳細と承認履歴を表示する。
 * 実行可能な操作は現在のステータスとログインユーザーのロールから判定して動的に表示する
 * （基本設計書 3.3 / 6.1節）。最終的な可否判定は常にバックエンドが行う。
 */
@Component({
  selector: 'app-ringi-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, DatePipe, CurrencyPipe, StatusBadge, ActionDialog],
  template: `
    <div class="head">
      <a routerLink="/ringi" class="back">← 一覧へ戻る</a>
    </div>

    @if (loading()) {
      <div class="empty-state">読み込み中...</div>
    } @else if (loadError()) {
      <div class="card empty-state">
        <p class="error-message">{{ loadError() }}</p>
      </div>
    } @else if (request(); as req) {
      <article class="card panel">
        <header>
          <app-status-badge [status]="req.status" />
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

        <section class="content">
          <h2>申請内容</h2>
          <p>{{ req.content }}</p>
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
            @for (log of history(); track $index) {
              <li>
                <div class="line">
                  <span class="action">{{ label(log.action) }}</span>
                  <span class="actor">{{ log.actorName }}</span>
                  <time>{{ log.timestamp | date: 'yyyy/MM/dd HH:mm' }}</time>
                </div>
                @if (log.comment) {
                  <p class="comment">{{ log.comment }}</p>
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
    .head {
      margin-bottom: 1rem;
    }

    .back {
      font-size: 0.9rem;
      text-decoration: none;

      &:hover {
        text-decoration: underline;
      }
    }

    .panel {
      padding: 1.75rem;
      margin-bottom: 1.25rem;
    }

    header h1 {
      margin: 0.6rem 0 0;
      font-size: 1.4rem;
    }

    .meta {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
      gap: 1rem 1.5rem;
      margin: 1.5rem 0;
      padding: 1.15rem 0;
      border-top: 1px solid var(--border);
      border-bottom: 1px solid var(--border);
    }

    .meta div {
      margin: 0;
    }

    dt {
      font-size: 0.78rem;
      color: var(--text-muted);
      margin-bottom: 0.2rem;
    }

    dd {
      margin: 0;
      font-size: 0.95rem;
      font-weight: 500;
      color: var(--text-heading);
    }

    .amount {
      font-variant-numeric: tabular-nums;
    }

    .content h2,
    .history h2 {
      font-size: 1rem;
      margin: 0 0 0.75rem;
    }

    .content p {
      margin: 0;
      white-space: pre-wrap;
      line-height: 1.9;
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.65rem;
      justify-content: flex-end;
      margin-top: 1.75rem;
      padding-top: 1.5rem;
      border-top: 1px solid var(--border);
    }

    .empty {
      color: var(--text-muted);
      font-size: 0.9rem;
      margin: 0;
    }

    .timeline {
      list-style: none;
      margin: 0;
      padding: 0 0 0 1.15rem;
      border-left: 2px solid var(--border);
    }

    .timeline li {
      position: relative;
      padding-bottom: 1.35rem;

      &:last-child {
        padding-bottom: 0;
      }

      &::before {
        content: '';
        position: absolute;
        left: -1.55rem;
        top: 0.5rem;
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: var(--bg-surface);
        border: 3px solid var(--primary);
      }
    }

    .line {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 0.65rem;
    }

    .action {
      font-weight: 700;
      color: var(--primary);
    }

    .actor {
      font-size: 0.9rem;
    }

    time {
      font-size: 0.8rem;
      color: var(--text-muted);
      font-variant-numeric: tabular-nums;
    }

    .comment {
      margin: 0.4rem 0 0;
      padding: 0.6rem 0.85rem;
      background: var(--bg-page);
      border-radius: 8px;
      font-size: 0.9rem;
      white-space: pre-wrap;
    }
  `,
})
export class RingiDetailComponent {
  private readonly ringi = inject(RingiService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly id = input.required<string>();

  readonly request = signal<RingiRequest | null>(null);
  readonly history = signal<AuditLog[]>([]);
  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);

  readonly pendingAction = signal<RingiAction | null>(null);
  readonly busy = signal(false);
  readonly actionError = signal<string | null>(null);

  /** 現在のステータスとロールから実行可能な操作を求める。 */
  readonly actions = computed(() => {
    const req = this.request();
    const user = this.auth.appUser();
    return req && user ? availableActions(req, user) : [];
  });

  constructor() {
    queueMicrotask(() => void this.load());
  }

  label(action: RingiAction | 'create'): string {
    return ACTION_LABELS[action];
  }

  buttonClass(action: RingiAction): string {
    switch (action) {
      case 'approve':
        return 'btn-success';
      case 'return':
        return 'btn-warning';
      case 'reject':
        return 'btn-danger';
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
