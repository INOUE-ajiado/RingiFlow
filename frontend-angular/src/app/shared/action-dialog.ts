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
      background: rgba(15, 23, 42, 0.45);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1rem;
      z-index: 50;
    }

    .dialog {
      width: 100%;
      max-width: 32rem;
      padding: 1.75rem;
    }

    h2 {
      margin: 0 0 1.25rem;
      font-size: 1.2rem;
    }

    .required,
    .optional {
      margin-left: 0.4rem;
      font-size: 0.75rem;
      padding: 0.1rem 0.4rem;
      border-radius: 4px;
      font-weight: 600;
    }

    .required {
      background: var(--danger-bg);
      color: var(--danger);
    }

    .optional {
      background: var(--bg-page);
      color: var(--text-muted);
    }

    .error-message {
      margin-top: 1rem;
    }

    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 0.65rem;
      margin-top: 1.5rem;
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
