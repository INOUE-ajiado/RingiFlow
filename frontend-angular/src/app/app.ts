import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';

import { Icon } from './shared/icon';

import { AuthService } from './core/auth.service';
import { ROLE_LABELS } from './core/models';

/**
 * アプリケーションシェル。
 *
 * ログイン画面を設けていないため、起動時の自動ログインが完了するまでの待機表示と、
 * 失敗時のエラー表示をここで担当する。
 */
@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, Icon],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  private readonly auth = inject(AuthService);

  readonly user = this.auth.appUser;
  readonly ready = this.auth.ready;
  readonly error = this.auth.error;

  readonly roleLabel = computed(() => {
    const user = this.user();
    return user ? ROLE_LABELS[user.role] : '';
  });

  reload(): void {
    location.reload();
  }
}
