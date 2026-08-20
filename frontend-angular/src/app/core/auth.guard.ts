import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';

import { AuthService } from './auth.service';

// inject() は injection context 内でしか呼べず、await をまたぐと context が失われる。
// そのため依存はすべて最初の await より前に解決しておく必要がある。

/** 未ログインの場合はログイン画面へリダイレクトする。 */
export const authGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  await auth.whenReady();
  return auth.appUser() ? true : router.createUrlTree(['/login']);
};

/** ログイン済みの場合はダッシュボードへリダイレクトする（ログイン画面用）。 */
export const guestGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  await auth.whenReady();
  return auth.appUser() ? router.createUrlTree(['/ringi']) : true;
};
