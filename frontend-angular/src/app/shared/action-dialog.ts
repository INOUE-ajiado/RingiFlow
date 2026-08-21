import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { ACTION_LABELS, COMMENT_REQUIRED, RingiAction } from '../core/models';

/**
 * 承認・差し戻し・却下の実行時に表示するコメント入力モーダル。
 * 差し戻しと却下では理由コメントが必須となる（基本設計書 5.1節）。
 */
@Component({
  selector: 'app-action-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <div class="overlay" (click)="cancelled.emit()">
      <div class="dialog card" (click)="$event.stopPropagation()">
        <h2>{{ title() }}</h2>

        <label for="comment">
          コメント
          @if (required()) {
            <span class="required">必須</span>
          } @else {
            <span class="optional">任意</span>
          }
        </label>
        <textarea
          id="comment"
          [(ngModel)]="comment"
          [class.invalid]="showError()"
          [placeholder]="placeholder()"
          rows="5"
        ></textarea>

        @if (showError()) {
          <p class="field-error">理由コメントの入力は必須です。</p>
        }

        @if (errorMessage()) {
          <p class="error-message">{{ errorMessage() }}</p>
        }

        <div class="actions">
          <button type="button" class="btn btn-secondary" (click)="cancelled.emit()" [disabled]="busy()">
            キャンセル
          </button>
          <button type="button" class="btn" [class]="confirmClass()" (click)="submit()" [disabled]="busy()">
            {{ busy() ? '処理中...' : label() + 'する' }}
          </button>
        </div>
      </div>
    </div>
  `,
  styles: `
    .overlay {
      position: fixed;
      inset: 0;
      background: rgba(19, 26, 34, 0.5);
      backdrop-filter: blur(2px);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: var(--space-4);
      z-index: 50;
      animation: fade-in 140ms var(--ease);
    }

    @keyframes fade-in {
      from {
        opacity: 0;
      }
    }

    .dialog {
      width: 100%;
      max-width: 30rem;
      padding: var(--space-5) var(--space-5) var(--space-4);
      box-shadow: var(--shadow-lg);
      animation: rise 180ms var(--ease);
    }

    @keyframes rise {
      from {
        opacity: 0;
        transform: translateY(8px) scale(0.98);
      }
    }

    h2 {
      margin: 0 0 var(--space-4);
      font-size: var(--text-lg);
    }

    .required,
    .optional {
      margin-left: var(--space-2);
      font-size: var(--text-xs);
      padding: 0.05rem 0.4rem;
      border-radius: var(--radius-sm);
      font-weight: 600;
    }

    .required {
      background: var(--danger-50);
      color: var(--danger-700);
    }

    .optional {
      background: var(--bg-inset);
      color: var(--text-muted);
    }

    .error-message {
      margin: var(--space-4) 0 0;
    }

    .actions {
      display: flex;
      justify-content: flex-end;
      gap: var(--space-2);
      margin-top: var(--space-5);
      padding-top: var(--space-4);
      border-top: 1px solid var(--border-subtle);
    }
  `,
})
export class ActionDialog {
  readonly action = input.required<RingiAction>();
  readonly busy = input(false);
  readonly errorMessage = input<string | null>(null);

  readonly confirmed = output<string>();
  readonly cancelled = output<void>();

  readonly comment = signal('');
  private readonly attempted = signal(false);

  readonly label = computed(() => ACTION_LABELS[this.action()]);
  readonly required = computed(() => COMMENT_REQUIRED[this.action()]);
  readonly title = computed(() => `${this.label()}の確認`);

  readonly placeholder = computed(() =>
    this.required()
      ? '差し戻し・却下の理由を具体的にご記入ください。'
      : 'コメントがあればご記入ください。',
  );

  readonly showError = computed(
    () => this.attempted() && this.required() && this.comment().trim() === '',
  );

  submit(): void {
    this.attempted.set(true);
    if (this.required() && this.comment().trim() === '') {
      return;
    }
    this.confirmed.emit(this.comment().trim());
  }

  confirmClass(): string {
    switch (this.action()) {
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
}
