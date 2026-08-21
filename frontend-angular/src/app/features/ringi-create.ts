import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormArray, FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';

import { RingiRequest, SummaryItem, requiresCEOApproval } from '../core/models';
import { AuthService } from '../core/auth.service';
import { RingiService, apiErrorMessage } from '../core/ringi.service';
import { Icon } from '../shared/icon';

/**
 * 新規申請の入力フォーム。
 * 差し戻された稟議（returned）を申請者本人が修正・再申請する際の編集画面も兼ねる
 * （基本設計書 3.2 Step3 / 6.1節）。
 */
@Component({
  selector: 'app-ringi-create',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, Icon],
  template: `
    <div class="page-head">
      <h1>{{ isResubmit() ? '稟議の修正・再申請' : '新規稟議申請' }}</h1>
      <a [routerLink]="backLink()" class="btn btn-secondary">キャンセル</a>
    </div>

    @if (isResubmit()) {
      <p class="notice notice-warning resubmit-notice">
        この稟議は差し戻されています。内容を修正して再申請すると、システム担当の承認待ちから再度審査されます。
      </p>
    }

    @if (loading()) {
      <div class="empty-state loading">
        <app-icon name="spinner" [size]="24" />
        読み込んでいます...
      </div>
    } @else {
      <form [formGroup]="form" (ngSubmit)="submit()" class="card panel">
        <div class="field">
          <label for="title">件名<span class="required">必須</span></label>
          <input
            id="title"
            type="text"
            formControlName="title"
            placeholder="例: 開発用生成AIツールの見直しおよび「Google Antigravity」の導入に関する申請"
            [class.invalid]="isInvalid('title')"
          />
          @if (isInvalid('title')) {
            <p class="field-error">件名を入力してください（100文字以内）。</p>
          }
        </div>

        <div class="field-row">
          <div class="field">
            <label for="amount">金額（円）</label>
            <input
              id="amount"
              type="number"
              formControlName="amount"
              min="0"
              step="1"
              [class.invalid]="isInvalid('amount')"
            />
            @if (isInvalid('amount')) {
              <p class="field-error">0以上の数値を入力してください。</p>
            }
            @if (routeHint()) {
              <p class="route-hint">{{ routeHint() }}</p>
            }
          </div>

          <div class="field">
            <label for="dueDate">決裁希望日</label>
            <input id="dueDate" type="date" formControlName="dueDate" />
            <p class="route-hint">いつまでに決裁が必要かの目安です（任意）。</p>
          </div>
        </div>

        <div class="field">
          <div class="field-head">
            <label>概要</label>
            <button type="button" class="btn btn-secondary btn-sm" (click)="addSummaryRow()">
              <app-icon name="plus" [size]="14" />
              項目を追加
            </button>
          </div>
          <p class="route-hint hint-above">
            品名・予算・購入先など、稟議の要点を項目ごとに整理して記載します（任意）。
          </p>

          @if (summaryRows().length === 0) {
            <p class="summary-empty">項目はありません。「項目を追加」から入力できます。</p>
          } @else {
            <div class="summary-rows" formArrayName="summary">
              @for (row of summaryRows().controls; track $index; let i = $index) {
                <div class="summary-row" [formGroupName]="i">
                  <input
                    type="text"
                    formControlName="label"
                    class="summary-label"
                    placeholder="項目名（例: 品名）"
                    [attr.aria-label]="'概要 ' + (i + 1) + ' の項目名'"
                  />
                  <input
                    type="text"
                    formControlName="value"
                    placeholder="内容（例: iPad 13インチ）"
                    [attr.aria-label]="'概要 ' + (i + 1) + ' の内容'"
                  />
                  <button
                    type="button"
                    class="icon-btn icon-btn-danger"
                    aria-label="この項目を削除"
                    (click)="removeSummaryRow(i)"
                  >
                    <app-icon name="trash" [size]="16" />
                  </button>
                </div>
              }
            </div>
          }
        </div>

        <div class="field">
          <label for="content">申請理由・目的<span class="required">必須</span></label>
          <textarea
            id="content"
            formControlName="content"
            rows="10"
            placeholder="稟議の目的、必要性、想定される効果などをご記入ください。"
            [class.invalid]="isInvalid('content')"
          ></textarea>
          @if (isInvalid('content')) {
            <p class="field-error">申請理由・目的を入力してください。</p>
          }
        </div>
        @if (error()) {
          <p class="error-message">{{ error() }}</p>
        }

        <div class="actions">
          <button type="submit" class="btn btn-primary" [disabled]="busy()">
            {{ busy() ? '送信中...' : isResubmit() ? '再申請する' : '申請する' }}
          </button>
        </div>
      </form>
    }
  `,
  styles: `
    .page-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-4);
      margin-bottom: var(--space-5);
    }

    h1 {
      margin: 0;
      font-size: var(--text-2xl);
    }

    .resubmit-notice {
      margin-bottom: var(--space-4);
    }

    .loading {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--space-3);

      app-icon {
        color: var(--accent);
      }
    }

    .panel {
      padding: var(--space-6);
    }

    .field {
      margin-bottom: var(--space-5);

      &:last-of-type {
        margin-bottom: 0;
      }
    }

    .required {
      margin-left: var(--space-2);
      font-size: var(--text-xs);
      padding: 0.05rem 0.4rem;
      border-radius: var(--radius-sm);
      background: var(--danger-50);
      color: var(--danger-700);
      font-weight: 600;
    }

    .route-hint {
      margin: var(--space-2) 0 0;
      font-size: var(--text-xs);
      color: var(--text-muted);
    }

    .hint-above {
      margin: 0 0 var(--space-3);
    }

    /* 金額と決裁希望日を横並びに */
    .field-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
      gap: var(--space-4);
      margin-bottom: var(--space-5);

      .field {
        margin-bottom: 0;
      }
    }

    .field-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);

      label {
        margin-bottom: 0;
      }
    }

    /* 概要欄 */
    .summary-rows {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }

    .summary-row {
      display: grid;
      grid-template-columns: minmax(7rem, 12rem) 1fr auto;
      align-items: center;
      gap: var(--space-2);
    }

    .summary-label {
      font-weight: 600;
    }

    .summary-empty {
      margin: 0;
      padding: var(--space-4);
      border: 1px dashed var(--border);
      border-radius: var(--radius-sm);
      text-align: center;
      color: var(--text-muted);
      font-size: var(--text-sm);
    }

    @media (max-width: 34rem) {
      .summary-row {
        grid-template-columns: 1fr auto;
      }

      .summary-label {
        grid-column: 1 / -1;
      }
    }

    .error-message {
      margin: var(--space-5) 0 0;
    }

    .actions {
      display: flex;
      justify-content: flex-end;
      gap: var(--space-2);
      margin-top: var(--space-6);
      padding-top: var(--space-4);
      border-top: 1px solid var(--border-subtle);
    }

    @media (max-width: 40rem) {
      .panel {
        padding: var(--space-4);
      }

      .actions .btn {
        flex: 1 1 auto;
      }
    }
  `,
})
export class RingiCreateComponent {
  private readonly fb = inject(FormBuilder);
  private readonly ringi = inject(RingiService);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);

  /** ルートパラメータ。指定された場合は差し戻し稟議の再申請として扱う。 */
  readonly id = input<string | undefined>(undefined);

  readonly busy = signal(false);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  private readonly original = signal<RingiRequest | null>(null);

  readonly isResubmit = computed(() => !!this.id());
  readonly backLink = computed(() => (this.id() ? ['/ringi', this.id()!] : ['/ringi']));

  readonly form = this.fb.nonNullable.group({
    title: ['', [Validators.required, Validators.maxLength(100)]],
    amount: [0, [Validators.required, Validators.min(0)]],
    dueDate: [''],
    content: ['', Validators.required],
    summary: this.fb.array<ReturnType<RingiCreateComponent['summaryGroup']>>([]),
  });

  private readonly amountValue = toSignal(this.form.controls.amount.valueChanges, {
    initialValue: this.form.controls.amount.value,
  });

  /**
   * 入力中の金額に応じて代表決裁の要否を知らせる。
   * 閾値はサーバーから配られた設定値を用いる（クライアントに定数を持たない）。
   */
  readonly routeHint = computed(() => {
    const threshold = this.auth.config()?.ceoApprovalThreshold;
    if (threshold === undefined) return '';
    const amount = Number(this.amountValue() ?? 0);
    return requiresCEOApproval(amount, threshold)
      ? `${threshold.toLocaleString()}円以上のため、代表決裁まで進みます。`
      : `${threshold.toLocaleString()}円未満のため、プロデューサー承認で決裁完了となります。`;
  });

  constructor() {
    // 再申請の場合のみ既存の内容を読み込んでフォームへ反映する。
    queueMicrotask(() => {
      const id = this.id();
      if (id) void this.loadExisting(id);
    });
  }

  /**
   * 概要欄の行数の変化を追うためのカウンタ。
   *
   * FormArray は行を増減しても参照が変わらないため、そのままでは OnPush の
   * 変更検知が働かない。行数を signal で持ち、それに依存させることで再描画する。
   */
  private readonly summaryVersion = signal(0);

  /** 概要欄の行（FormArray）。テンプレートから参照する。 */
  readonly summaryRows = computed(() => {
    this.summaryVersion();
    return this.form.controls.summary;
  });

  private summaryGroup(item: SummaryItem = { label: '', value: '' }) {
    return this.fb.nonNullable.group({ label: [item.label], value: [item.value] });
  }

  addSummaryRow(): void {
    this.form.controls.summary.push(this.summaryGroup());
    this.summaryVersion.update((v) => v + 1);
  }

  removeSummaryRow(index: number): void {
    this.form.controls.summary.removeAt(index);
    this.summaryVersion.update((v) => v + 1);
  }

  /** 既存の概要をフォームへ読み込む（再申請時）。 */
  private setSummaryRows(items: SummaryItem[]): void {
    const array = this.form.controls.summary;
    array.clear();
    for (const item of items) {
      array.push(this.summaryGroup(item));
    }
    this.summaryVersion.update((v) => v + 1);
  }

  isInvalid(name: 'title' | 'amount' | 'content'): boolean {
    const control = this.form.controls[name];
    return control.invalid && (control.dirty || control.touched);
  }

  private async loadExisting(id: string): Promise<void> {
    this.loading.set(true);
    try {
      const detail = await this.ringi.get(id);
      this.original.set(detail.request);
      this.form.patchValue({
        title: detail.request.title,
        amount: detail.request.amount,
        content: detail.request.content,
        dueDate: detail.request.dueDate ? detail.request.dueDate.slice(0, 10) : '',
      });
      this.setSummaryRows(detail.request.summary ?? []);
    } catch (err) {
      this.error.set(apiErrorMessage(err));
    } finally {
      this.loading.set(false);
    }
  }

  async submit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    const value = this.form.getRawValue();
    try {
      const payload = {
        title: value.title,
        content: value.content,
        amount: value.amount,
        dueDate: value.dueDate,
        summary: value.summary,
      };
      const id = this.id();
      if (id) {
        await this.ringi.transition(id, 'resubmit', payload);
        await this.router.navigate(['/ringi', id]);
      } else {
        const created = await this.ringi.create(payload);
        await this.router.navigate(['/ringi', created.requestId]);
      }
    } catch (err) {
      this.error.set(apiErrorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }
}
