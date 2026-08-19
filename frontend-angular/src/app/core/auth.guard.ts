import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';

import { AuthService } from './auth.service';

/** 未ログインの場合はログイン画面へリダイレクトする。 */
export const authGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  await auth.whenReady();
  return auth.appUser() ? true : inject(Router).createUrlTree(['/login']);
};

/** ログイン済みの場合はダッシュボードへリダイレクトする（ログイン画面用）。 */
export const guestGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  await auth.whenReady();
  return auth.appUser() ? inject(Router).createUrlTree(['/ringi']) : true;
};
