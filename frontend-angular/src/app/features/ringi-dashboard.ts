import { CurrencyPipe, DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { AuthService } from '../core/auth.service';
import { RingiRequest, hasApprovalRole } from '../core/models';
import { ListScope, RingiService, apiErrorMessage } from '../core/ringi.service';
import { StatusBadge } from '../shared/status-badge';

/**
 * 稟議一覧のホーム画面。
 * 「承認待ち（自分が処理すべきもの）」と「自分の申請」をタブで切り替える。
 */
@Component({
  selector: 'app-ringi-dashboard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, DatePipe, CurrencyPipe, StatusBadge],
  template: `
    <div class="head">
      <div>
        <h1>稟議一覧</h1>
        <p class="subtitle">{{ subtitle() }}</p>
      </div>
      <a routerLink="/ringi/new" class="btn btn-primary">新規申請</a>
    </div>

    <div class="tabs" role="tablist">
      @for (tab of tabs(); track tab.scope) {
        <button
          type="button"
          role="tab"
          class="tab"
          [class.active]="scope() === tab.scope"
          [attr.aria-selected]="scope() === tab.scope"
          (click)="switchTab(tab.scope)"
        >
          {{ tab.label }}
        </button>
      }
    </div>

    @if (error()) {
      <p class="error-message">{{ error() }}</p>
    }

    @if (truncated()) {
      <p class="truncated-warning">
        件数が上限（{{ limit }}件）に達したため、一部の稟議が表示されていません。絞り込んでご確認ください。
      </p>
    }

    @if (loading()) {
      <div class="empty-state">読み込み中...</div>
    } @else if (items().length === 0) {
      <div class="card empty-state">該当する稟議はありません。</div>
    } @else {
      <div class="card table-wrap">
        <table>
          <thead>
            <tr>
              <th class="col-no">稟議番号</th>
              <th class="col-status">ステータス</th>
              <th>タイトル</th>
              <th class="col-applicant">申請者</th>
              <th class="col-amount">金額</th>
              <th class="col-date">申請日時</th>
            </tr>
          </thead>
          <tbody>
            @for (item of items(); track item.id) {
              <tr>
                <td class="col-no">{{ item.requestNo }}</td>
                <td><app-status-badge [status]="item.status" /></td>
                <td>
                  <a [routerLink]="['/ringi', item.id]" class="title-link">{{ item.title }}</a>
                </td>
                <td class="col-applicant">
                  {{ item.applicantName }}
                  <span class="employee-id">{{ item.applicantEmployeeId }}</span>
                </td>
                <td class="col-amount">{{ item.amount | currency: 'JPY' : 'symbol' : '1.0-0' }}</td>
                <td class="col-date">{{ item.createdAt | date: 'yyyy/MM/dd HH:mm' }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    }
  `,
  styles: `
    .head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 1rem;
      flex-wrap: wrap;
      margin-bottom: 1.5rem;
    }

    h1 {
      margin: 0;
      font-size: 1.5rem;
    }

    .subtitle {
      margin: 0.25rem 0 0;
      color: var(--text-muted);
      font-size: 0.88rem;
    }

    .tabs {
      display: flex;
      gap: 0.35rem;
      border-bottom: 1px solid var(--border);
      margin-bottom: 1.25rem;
    }

    .tab {
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      padding: 0.6rem 1rem;
      font-family: inherit;
      font-size: 0.92rem;
      font-weight: 600;
      color: var(--text-muted);
      cursor: pointer;

      &.active {
        color: var(--primary);
        border-bottom-color: var(--primary);
      }
    }

    .error-message {
      margin-bottom: 1rem;
    }

    .table-wrap {
      overflow-x: auto;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.92rem;
    }

    th {
      text-align: left;
      font-weight: 600;
      font-size: 0.82rem;
      color: var(--text-muted);
      padding: 0.85rem 1rem;
      border-bottom: 1px solid var(--border);
      white-space: nowrap;
    }

    td {
      padding: 0.85rem 1rem;
      border-bottom: 1px solid var(--border);
      vertical-align: middle;
    }

    tr:last-child td {
      border-bottom: none;
    }

    .title-link {
      font-weight: 500;
      text-decoration: none;

      &:hover {
        text-decoration: underline;
      }
    }

    .employee-id {
      display: block;
      font-size: 0.78rem;
      color: var(--text-muted);
    }

    .col-amount {
      text-align: right;
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }

    .col-date {
      white-space: nowrap;
      color: var(--text-muted);
      font-variant-numeric: tabular-nums;
    }

    .col-status,
    .col-applicant {
      white-space: nowrap;
    }

    .col-no {
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
      color: var(--text-muted);
      font-size: 0.85rem;
    }

    .truncated-warning {
      background: var(--warning-bg);
      border-left: 3px solid var(--warning);
      color: #92400e;
      padding: 0.7rem 1rem;
      border-radius: 0 8px 8px 0;
      font-size: 0.88rem;
      margin: 0 0 1rem;
    }
  `,
})
export class RingiDashboardComponent {
  private readonly ringi = inject(RingiService);
  private readonly auth = inject(AuthService);

  readonly scope = signal<ListScope>('all');
  readonly items = signal<RingiRequest[]>([]);
  readonly truncated = signal(false);

  /** バックエンドの listLimit と揃えた表示用の上限値。 */
  readonly limit = 200;
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);

  /** 承認権限を持つロールのみ「承認待ち」タブを表示する。 */
  readonly tabs = computed(() => {
    const user = this.auth.appUser();
    const base: { scope: ListScope; label: string }[] = [{ scope: 'all', label: 'すべて' }];
    if (user && hasApprovalRole(user.role)) {
      base.push({ scope: 'inbox', label: '承認待ち' });
    }
    base.push({ scope: 'mine', label: '自分の申請' });
    return base;
  });

  readonly subtitle = computed(() => {
    const user = this.auth.appUser();
    return user ? `${user.name}（${user.employeeId}）としてログイン中` : '';
  });

  constructor() {
    void this.load();
  }

  switchTab(scope: ListScope): void {
    if (this.scope() === scope) return;
    this.scope.set(scope);
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const result = await this.ringi.list(this.scope());
      this.items.set(result.items);
      this.truncated.set(result.truncated);
    } catch (err) {
      this.error.set(apiErrorMessage(err));
      this.items.set([]);
      this.truncated.set(false);
    } finally {
      this.loading.set(false);
    }
  }
}
