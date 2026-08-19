import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';

import { RingiRequest } from '../core/models';
import { RingiService, apiErrorMessage } from '../core/ringi.service';

/**
 * 新規申請の入力フォーム。
 * 差し戻された稟議（returned）を申請者本人が修正・再申請する際の編集画面も兼ねる
 * （基本設計書 3.2 Step3 / 6.1節）。
 */
@Component({
  selector: 'app-ringi-create',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink],
  template: `
    <div class="head">
      <h1>{{ isResubmit() ? '稟議の修正・再申請' : '新規稟議申請' }}</h1>
      <a [routerLink]="backLink()" class="btn btn-secondary">キャンセル</a>
    </div>

    @if (isResubmit()) {
      <div class="notice">
        この稟議は差し戻されています。内容を修正して再申請すると、システム担当の承認待ちから再度審査されます。
      </div>
    }

    @if (loading()) {
      <div class="empty-state">読み込み中...</div>
    } @else {
      <form [formGroup]="form" (ngSubmit)="submit()" class="card panel">
        <div class="field">
          <label for="title">タイトル<span class="required">必須</span></label>
          <input
            id="title"
            type="text"
            formControlName="title"
            placeholder="例: 開発用ノートPCの購入について"
            [class.invalid]="isInvalid('title')"
          />
          @if (isInvalid('title')) {
            <p class="field-error">タイトルを入力してください（100文字以内）。</p>
          }
        </div>

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
        </div>

        <div class="field">
          <label for="content">申請内容・理由<span class="required">必須</span></label>
          <textarea
            id="content"
            formControlName="content"
            rows="10"
            placeholder="稟議の目的、必要性、想定される効果などをご記入ください。"
            [class.invalid]="isInvalid('content')"
          ></textarea>
          @if (isInvalid('content')) {
            <p class="field-error">申請内容を入力してください。</p>
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
    .head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      margin-bottom: 1.5rem;
    }

    h1 {
      margin: 0;
      font-size: 1.5rem;
    }

    .notice {
      background: var(--warning-bg);
      border-left: 3px solid var(--warning);
      color: #92400e;
      padding: 0.85rem 1rem;
      border-radius: 0 8px 8px 0;
      font-size: 0.9rem;
      margin-bottom: 1.25rem;
    }

    .panel {
      padding: 1.75rem;
    }

    .field {
      margin-bottom: 1.35rem;
    }

    .required {
      margin-left: 0.4rem;
      font-size: 0.72rem;
      padding: 0.1rem 0.4rem;
      border-radius: 4px;
      background: var(--danger-bg);
      color: var(--danger);
      font-weight: 600;
    }

    .error-message {
      margin-bottom: 1rem;
    }

    .actions {
      display: flex;
      justify-content: flex-end;
    }
  `,
})
export class RingiCreateComponent {
  private readonly fb = inject(FormBuilder);
  private readonly ringi = inject(RingiService);
  private readonly router = inject(Router);

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
    content: ['', Validators.required],
  });

  constructor() {
    // 再申請の場合のみ既存の内容を読み込んでフォームへ反映する。
    queueMicrotask(() => {
      const id = this.id();
      if (id) void this.loadExisting(id);
    });
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
      });
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
      const id = this.id();
      if (id) {
        await this.ringi.transition(id, 'resubmit', {
          title: value.title,
          content: value.content,
          amount: value.amount,
        });
        await this.router.navigate(['/ringi', id]);
      } else {
        const created = await this.ringi.create(value);
        await this.router.navigate(['/ringi', created.requestId]);
      }
    } catch (err) {
      this.error.set(apiErrorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }
}
