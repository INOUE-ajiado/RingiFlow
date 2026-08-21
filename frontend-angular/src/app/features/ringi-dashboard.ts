import { CurrencyPipe, DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { AuthService } from '../core/auth.service';
import { RingiRequest, RingiStatus, STATUS_LABELS, hasApprovalRole } from '../core/models';
import { ListQuery, ListScope, RingiService, apiErrorMessage } from '../core/ringi.service';
import { Icon } from '../shared/icon';
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
  imports: [RouterLink, FormsModule, DatePipe, CurrencyPipe, StatusBadge, Icon],
  template: `
    <div class="page-head">
      <div>
        <h1>稟議一覧</h1>
        <p class="subtitle">{{ subtitle() }}</p>
      </div>
      <a routerLink="/ringi/new" class="btn btn-primary">
        <app-icon name="plus" [size]="16" />
        新規申請
      </a>
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

    <section class="card filters">
      <div class="filter-grid">
        <div class="field keyword">
          <label for="keyword">キーワード</label>
          <div class="input-icon">
            <app-icon name="search" [size]="16" />
            <input
              id="keyword"
              type="search"
              [(ngModel)]="keyword"
              (keyup.enter)="search()"
              placeholder="稟議番号・タイトル・内容・申請者"
            />
          </div>
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

      <div class="field statuses">
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
          <button type="button" class="btn btn-ghost" (click)="clear()">条件をクリア</button>
        }
        <button type="button" class="btn btn-primary" (click)="search()" [disabled]="loading()">
          {{ loading() ? '検索中...' : '検索' }}
        </button>
      </div>
    </section>

    @if (error()) {
      <p class="error-message">{{ error() }}</p>
    }

    @if (truncated()) {
      <p class="notice notice-warning">
        キーワード検索の走査上限に達しました。すべての該当稟議を調べきれていない可能性があります。期間やステータスで絞り込むと確実です。
      </p>
    }

    @if (loading() && items().length === 0) {
      <div class="card table-wrap" aria-busy="true" aria-label="読み込み中">
        <div class="skeleton-list">
          @for (row of skeletonRows; track row) {
            <div class="skeleton-row">
              <div class="skeleton" style="width: 6rem; height: 0.9rem"></div>
              <div class="skeleton" style="width: 7rem; height: 1.3rem; border-radius: 999px"></div>
              <div class="skeleton" style="flex: 1; height: 0.9rem"></div>
              <div class="skeleton" style="width: 5rem; height: 0.9rem"></div>
            </div>
          }
        </div>
      </div>
    } @else if (items().length === 0) {
      <div class="card empty-state">
        <p class="empty-title">該当する稟議はありません</p>
        @if (hasActiveFilter()) {
          <p>絞り込み条件を変更するか、条件をクリアしてください。</p>
          <button type="button" class="btn btn-secondary" (click)="clear()">条件をクリア</button>
        } @else {
          <p>まだ稟議が登録されていません。</p>
          <a routerLink="/ringi/new" class="btn btn-primary">最初の稟議を申請する</a>
        }
      </div>
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
                <td class="col-no tnum" data-label="稟議番号">{{ item.requestNo }}</td>
                <td class="col-status" data-label="ステータス">
                  <app-status-badge [status]="item.status" />
                </td>
                <td data-label="タイトル">
                  <a [routerLink]="['/ringi', item.id]" class="title-link">{{ item.title }}</a>
                </td>
                <td class="col-applicant" data-label="申請者">
                  <span class="applicant-name">{{ item.applicantName }}</span>
                  <span class="employee-id">{{ item.applicantEmployeeId }}</span>
                </td>
                <td class="col-amount tnum" data-label="金額">
                  {{ item.amount | currency: 'JPY' : 'symbol' : '1.0-0' }}
                </td>
                <td class="col-date tnum" data-label="申請日時">
                  {{ item.createdAt | date: 'yyyy/MM/dd HH:mm' }}
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>

      <div class="foot">
        <span class="count">
          {{ items().length }} 件表示{{ nextCursor() ? '（続きあり）' : '' }}
        </span>
        @if (nextCursor()) {
          <button
            type="button"
            class="btn btn-secondary"
            (click)="loadMore()"
            [disabled]="loading()"
          >
            {{ loading() ? '読み込み中...' : 'もっと読み込む' }}
          </button>
        }
      </div>
    }
  `,
  styles: `
    .page-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: var(--space-4);
      flex-wrap: wrap;
      margin-bottom: var(--space-5);
    }

    h1 {
      margin: 0;
      font-size: var(--text-2xl);
    }

    .subtitle {
      margin: var(--space-1) 0 0;
      color: var(--text-muted);
      font-size: var(--text-sm);
    }

    /* 入力欄の内側に置くアイコン */
    .input-icon {
      position: relative;

      app-icon {
        position: absolute;
        left: 0.7rem;
        top: 50%;
        transform: translateY(-50%);
        color: var(--text-faint);
        pointer-events: none;
      }

      input {
        padding-left: 2.1rem;
      }

      &:focus-within app-icon {
        color: var(--accent);
      }
    }

    /* --- タブ --- */
    .tabs {
      display: flex;
      gap: var(--space-1);
      padding: 0.25rem;
      margin-bottom: var(--space-4);
      background: var(--bg-inset);
      border-radius: var(--radius-sm);
      width: fit-content;
      max-width: 100%;
      overflow-x: auto;
    }

    .tab {
      background: none;
      border: none;
      border-radius: calc(var(--radius-sm) - 2px);
      padding: 0.4rem 0.9rem;
      font-family: inherit;
      font-size: var(--text-sm);
      font-weight: 600;
      color: var(--text-muted);
      cursor: pointer;
      white-space: nowrap;
      transition:
        background-color var(--duration) var(--ease),
        color var(--duration) var(--ease);

      &:hover:not(.active) {
        color: var(--text-strong);
      }

      &.active {
        background: var(--bg-surface);
        color: var(--text-strong);
        box-shadow: var(--shadow-xs);
      }
    }

    /* --- 絞り込み --- */
    .filters {
      padding: var(--space-4) var(--space-5) var(--space-5);
      margin-bottom: var(--space-4);
    }

    .filter-grid {
      display: grid;
      grid-template-columns: minmax(14rem, 2fr) repeat(2, minmax(9rem, 1fr));
      gap: var(--space-3);
      margin-bottom: var(--space-4);
    }

    .statuses {
      margin-bottom: 0;
    }

    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
    }

    .chip {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-full);
      padding: 0.25rem 0.8rem;
      font-family: inherit;
      font-size: var(--text-xs);
      font-weight: 600;
      color: var(--text-muted);
      cursor: pointer;
      transition:
        background-color var(--duration) var(--ease),
        color var(--duration) var(--ease),
        border-color var(--duration) var(--ease);

      &:hover:not(.selected) {
        border-color: var(--gray-400);
        color: var(--text-strong);
      }

      &.selected {
        background: var(--accent);
        border-color: var(--accent);
        color: var(--text-on-accent);
      }
    }

    .filter-actions {
      display: flex;
      justify-content: flex-end;
      gap: var(--space-2);
      margin-top: var(--space-5);
      padding-top: var(--space-4);
      border-top: 1px solid var(--border-subtle);
    }

    .notice {
      margin: 0 0 var(--space-4);
    }

    /* --- 一覧 --- */
    .table-wrap {
      overflow-x: auto;
      overflow-y: hidden;
    }

    table {
      width: 100%;
      border-collapse: collapse;
    }

    th {
      text-align: left;
      font-weight: 600;
      font-size: var(--text-xs);
      letter-spacing: 0.03em;
      color: var(--text-muted);
      padding: var(--space-3) var(--space-4);
      background: var(--bg-subtle);
      border-bottom: 1px solid var(--border-subtle);
      white-space: nowrap;
    }

    td {
      padding: var(--space-3) var(--space-4);
      font-size: var(--text-sm);
      border-bottom: 1px solid var(--border-subtle);
      vertical-align: middle;
    }

    tbody tr {
      transition: background-color var(--duration) var(--ease);

      &:hover {
        background: var(--bg-subtle);
      }

      &:last-child td {
        border-bottom: none;
      }
    }

    .title-link {
      font-weight: 600;
      color: var(--text-strong);
      text-decoration: none;

      &:hover {
        color: var(--accent);
        text-decoration: underline;
      }
    }

    .applicant-name {
      display: block;
    }

    .employee-id {
      display: block;
      font-size: var(--text-xs);
      color: var(--text-muted);
    }

    .col-amount {
      text-align: right;
      white-space: nowrap;
      font-weight: 600;
      color: var(--text-strong);
    }

    .col-date,
    .col-no {
      white-space: nowrap;
      color: var(--text-muted);
    }

    .col-no {
      font-size: var(--text-xs);
      font-weight: 600;
    }

    .col-status,
    .col-applicant {
      white-space: nowrap;
    }

    /* --- 読み込み中 --- */
    .skeleton-list {
      padding: var(--space-2) 0;
    }

    .skeleton-row {
      display: flex;
      align-items: center;
      gap: var(--space-4);
      padding: var(--space-3) var(--space-4);
      border-bottom: 1px solid var(--border-subtle);

      &:last-child {
        border-bottom: none;
      }
    }

    /* --- 空状態 --- */
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--space-3);

      p {
        margin: 0;
      }
    }

    .empty-title {
      font-size: var(--text-base);
      font-weight: 600;
      color: var(--text-strong);
    }

    /* --- フッター --- */
    .foot {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-4);
      margin-top: var(--space-4);
    }

    .count {
      font-size: var(--text-sm);
      color: var(--text-muted);
    }

    /* --- 狭い画面: 表を積み重ねカードとして読ませる --- */
    @media (max-width: 52rem) {
      .filter-grid {
        grid-template-columns: 1fr;
      }

      .table-wrap {
        border: none;
        background: none;
        box-shadow: none;
        overflow: visible;
      }

      thead {
        display: none;
      }

      tbody tr {
        display: block;
        margin-bottom: var(--space-3);
        padding: var(--space-2) 0;
        background: var(--bg-surface);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius);
        box-shadow: var(--shadow-sm);

        &:hover {
          background: var(--bg-surface);
        }
      }

      td {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: var(--space-4);
        border-bottom: none;
        padding: var(--space-2) var(--space-4);
        text-align: right;

        &::before {
          content: attr(data-label);
          flex: none;
          font-size: var(--text-xs);
          font-weight: 600;
          color: var(--text-muted);
          text-align: left;
        }
      }

      .applicant-name,
      .employee-id {
        display: inline;
      }

      .employee-id::before {
        content: ' ';
      }
    }
  `,
})
export class RingiDashboardComponent {
  private readonly ringi = inject(RingiService);
  private readonly auth = inject(AuthService);

  readonly filterableStatuses = FILTERABLE_STATUSES;
  readonly skeletonRows = [0, 1, 2, 3, 4];

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
