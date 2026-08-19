import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { from, switchMap } from 'rxjs';

import { environment } from '../../environments/environment';
import { FIREBASE_AUTH } from './firebase';

/**
 * バックエンドAPI宛のリクエストに Firebase ID トークンを付与する。
 * Go 側はこのトークンを検証してユーザーの uid と role を確定させる（基本設計書 5.2節 Step1）。
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.url.startsWith(environment.apiBaseUrl)) {
    return next(req);
  }
  const user = inject(FIREBASE_AUTH).currentUser;
  if (!user) {
    return next(req);
  }
  return from(user.getIdToken()).pipe(
    switchMap((token) =>
      next(req.clone({ setHeaders: { Authorization: `Bearer ${token}` } })),
    ),
  );
};
