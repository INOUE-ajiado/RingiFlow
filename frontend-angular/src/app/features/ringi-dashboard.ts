import { CurrencyPipe, DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { AuthService } from '../core/auth.service';
import { RingiRequest, RingiStatus, STATUS_LABELS, hasApprovalRole } from '../core/models';
import { ListQuery, ListScope, RingiService, apiErrorMessage } from '../core/ringi.service';
import { StatusBadge } from '../shared/status-badge';

const PAGE_SIZE = 50;

/** 絞り込みに使えるステータスの並び順（フローの進行順）。 */
const FILTERABLE_STATUSES: RingiStatus[] = [
  'pending_system',
  'pending_producer',
  'pending_ceo',
  'approved',
  'returned',
  'rejected',
  'withdrawn',
];

/**
 * 稟議一覧のホーム画面。
 *
 * 閲覧範囲（タブ）に加え、ステータス・期間・キーワードで絞り込める。
 * 一覧はカーソル方式のページングで、続きは「もっと読み込む」で追加取得する。
 */
@Component({
  selector: 'app-ringi-dashboard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, FormsModule, DatePipe, CurrencyPipe, StatusBadge],
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

    <div class="card filters">
      <div class="filter-row">
        <div class="field grow">
          <label for="keyword">キーワード</label>
          <input
            id="keyword"
            type="search"
            [(ngModel)]="keyword"
            (keyup.enter)="search()"
            placeholder="稟議番号・タイトル・内容・申請者"
          />
        </div>
        <div class="field">
          <label for="from">申請日（開始）</label>
          <input id="from" type="date" [(ngModel)]="from" />
        </div>
        <div class="field">
          <label for="to">申請日（終了）</label>
          <input id="to" type="date" [(ngModel)]="to" />
        </div>
      </div>

      <div class="field">
        <label>ステータス</label>
        <div class="chips">
          @for (status of filterableStatuses; track status) {
            <button
              type="button"
              class="chip"
              [class.selected]="selectedStatuses().includes(status)"
              [attr.aria-pressed]="selectedStatuses().includes(status)"
              (click)="toggleStatus(status)"
            >
              {{ statusLabel(status) }}
            </button>
          }
        </div>
      </div>

      <div class="filter-actions">
        @if (hasActiveFilter()) {
          <button type="button" class="btn btn-secondary" (click)="clear()">条件をクリア</button>
        }
        <button type="button" class="btn btn-primary" (click)="search()" [disabled]="loading()">
          {{ loading() ? '検索中...' : '検索' }}
        </button>
      </div>
    </div>

    @if (error()) {
      <p class="error-message">{{ error() }}</p>
    }

    @if (truncated()) {
      <p class="notice-warning">
        キーワード検索の走査上限に達しました。すべての該当稟議を調べきれていない可能性があります。期間やステータスで絞り込むと確実です。
      </p>
    }

    @if (loading() && items().length === 0) {
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

      <div class="foot">
        <span class="count">{{ items().length }} 件表示{{ nextCursor() ? '（続きあり）' : '' }}</span>
        @if (nextCursor()) {
          <button type="button" class="btn btn-secondary" (click)="loadMore()" [disabled]="loading()">
            {{ loading() ? '読み込み中...' : 'もっと読み込む' }}
          </button>
        }
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

    .filters {
      padding: 1.15rem 1.25rem;
      margin-bottom: 1.25rem;
    }

    .filter-row {
      display: flex;
      flex-wrap: wrap;
      gap: 0.85rem;
      margin-bottom: 0.85rem;
    }

    .field {
      min-width: 10rem;

      &.grow {
        flex: 1 1 16rem;
      }
    }

    .field label {
      font-size: 0.8rem;
    }

    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem;
    }

    .chip {
      background: var(--bg-page);
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 0.3rem 0.8rem;
      font-family: inherit;
      font-size: 0.82rem;
      font-weight: 500;
      color: var(--text-muted);
      cursor: pointer;
      transition: background-color 0.15s, color 0.15s, border-color 0.15s;

      &.selected {
        background: var(--primary);
        border-color: var(--primary);
        color: #fff;
      }
    }

    .filter-actions {
      display: flex;
      justify-content: flex-end;
      gap: 0.6rem;
      margin-top: 1.1rem;
    }

    .error-message,
    .notice-warning {
      margin-bottom: 1rem;
    }

    .notice-warning {
      background: var(--warning-bg);
      border-left: 3px solid var(--warning);
      color: #92400e;
      padding: 0.7rem 1rem;
      border-radius: 0 8px 8px 0;
      font-size: 0.88rem;
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

    .col-date,
    .col-no {
      white-space: nowrap;
      color: var(--text-muted);
      font-variant-numeric: tabular-nums;
    }

    .col-no {
      font-size: 0.85rem;
    }

    .col-status,
    .col-applicant {
      white-space: nowrap;
    }

    .foot {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      margin-top: 1rem;
    }

    .count {
      font-size: 0.85rem;
      color: var(--text-muted);
    }
  `,
})
export class RingiDashboardComponent {
  private readonly ringi = inject(RingiService);
  private readonly auth = inject(AuthService);

  readonly filterableStatuses = FILTERABLE_STATUSES;

  readonly scope = signal<ListScope>('all');
  readonly items = signal<RingiRequest[]>([]);
  readonly nextCursor = signal('');
  readonly truncated = signal(false);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);

  // 入力中の絞り込み条件（「検索」を押すまで適用しない）
  readonly keyword = signal('');
  readonly from = signal('');
  readonly to = signal('');
  readonly selectedStatuses = signal<RingiStatus[]>([]);

  readonly hasActiveFilter = computed(
    () =>
      this.keyword().trim() !== '' ||
      this.from() !== '' ||
      this.to() !== '' ||
      this.selectedStatuses().length > 0,
  );

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

  statusLabel(status: RingiStatus): string {
    return STATUS_LABELS[status];
  }

  toggleStatus(status: RingiStatus): void {
    this.selectedStatuses.update((current) =>
      current.includes(status) ? current.filter((s) => s !== status) : [...current, status],
    );
  }

  switchTab(scope: ListScope): void {
    if (this.scope() === scope) return;
    this.scope.set(scope);
    void this.load();
  }

  search(): void {
    void this.load();
  }

  clear(): void {
    this.keyword.set('');
    this.from.set('');
    this.to.set('');
    this.selectedStatuses.set([]);
    void this.load();
  }

  /** 続きを読み込んで既存の一覧に追記する。 */
  loadMore(): void {
    void this.load(true);
  }

  private buildQuery(cursor?: string): ListQuery {
    const query: ListQuery = { scope: this.scope(), limit: PAGE_SIZE };
    const keyword = this.keyword().trim();
    if (keyword) query.keyword = keyword;
    if (this.from()) query.from = this.from();
    if (this.to()) query.to = this.to();
    if (this.selectedStatuses().length) query.statuses = this.selectedStatuses();
    if (cursor) query.cursor = cursor;
    return query;
  }

  private async load(append = false): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const result = await this.ringi.list(this.buildQuery(append ? this.nextCursor() : undefined));
      this.items.set(append ? [...this.items(), ...result.items] : result.items);
      this.nextCursor.set(result.nextCursor);
      this.truncated.set(result.truncated);
    } catch (err) {
      this.error.set(apiErrorMessage(err));
      if (!append) {
        this.items.set([]);
        this.nextCursor.set('');
      }
      this.truncated.set(false);
    } finally {
      this.loading.set(false);
    }
  }
}
