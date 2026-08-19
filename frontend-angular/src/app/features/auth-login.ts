import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';

import { AuthService, authErrorMessage } from '../core/auth.service';

/**
 * ログイン画面。
 * 入力するのは社員IDとパスワードのみで、認証用メールアドレスへの変換は
 * AuthService が行う（基本設計書 3.4節）。
 */
@Component({
  selector: 'app-auth-login',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule],
  template: `
    <div class="wrapper">
      <div class="card panel">
        <header>
          <h1>RingiFlow</h1>
          <p>稟議書承認システム</p>
        </header>

        <form [formGroup]="form" (ngSubmit)="submit()">
          <div class="field">
            <label for="employeeId">社員ID</label>
            <input
              id="employeeId"
              type="text"
              formControlName="employeeId"
              autocomplete="username"
              placeholder="E1234"
              [class.invalid]="isInvalid('employeeId')"
            />
            @if (isInvalid('employeeId')) {
              <p class="field-error">社員IDを入力してください。</p>
            }
          </div>

          <div class="field">
            <label for="password">パスワード</label>
            <input
              id="password"
              type="password"
              formControlName="password"
              autocomplete="current-password"
              [class.invalid]="isInvalid('password')"
            />
            @if (isInvalid('password')) {
              <p class="field-error">パスワードを入力してください。</p>
            }
          </div>

          @if (error()) {
            <p class="error-message">{{ error() }}</p>
          }

          <button type="submit" class="btn btn-primary submit" [disabled]="busy()">
            {{ busy() ? 'ログイン中...' : 'ログイン' }}
          </button>
        </form>

        <p class="note">
          アカウントは管理者が発行します。ログインできない場合はシステム担当にお問い合わせください。
        </p>
      </div>
    </div>
  `,
  styles: `
    .wrapper {
      min-height: 100dvh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
    }

    .panel {
      width: 100%;
      max-width: 24rem;
      padding: 2.25rem;
    }

    header {
      text-align: center;
      margin-bottom: 2rem;
    }

    h1 {
      margin: 0;
      font-size: 1.75rem;
      letter-spacing: -0.02em;
    }

    header p {
      margin: 0.35rem 0 0;
      color: var(--text-muted);
      font-size: 0.9rem;
    }

    .field {
      margin-bottom: 1.15rem;
    }

    .submit {
      width: 100%;
      margin-top: 0.5rem;
    }

    .error-message {
      margin: 0 0 1rem;
    }

    .note {
      margin: 1.75rem 0 0;
      font-size: 0.8rem;
      color: var(--text-muted);
      text-align: center;
      line-height: 1.6;
    }
  `,
})
export class AuthLoginComponent {
  private readonly fb = inject(FormBuilder);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  readonly form = this.fb.nonNullable.group({
    employeeId: ['', Validators.required],
    password: ['', Validators.required],
  });

  isInvalid(name: 'employeeId' | 'password'): boolean {
    const control = this.form.controls[name];
    return control.invalid && (control.dirty || control.touched);
  }

  async submit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      const { employeeId, password } = this.form.getRawValue();
      await this.auth.login(employeeId, password);
      await this.router.navigate(['/ringi']);
    } catch (err) {
      this.error.set(authErrorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }
}
