import { InjectionToken, Provider } from '@angular/core';
import { initializeApp } from 'firebase/app';
import { Auth, getAuth } from 'firebase/auth';

import { environment } from '../../environments/environment';

/**
 * Firebase Authentication のインスタンス。
 *
 * 基本設計書 4.2節の方針により、クライアントから Firestore へ直接アクセスすることはない。
 * そのため Firebase SDK の利用は Authentication に限定する。
 */
export const FIREBASE_AUTH = new InjectionToken<Auth>('FIREBASE_AUTH');

export function provideFirebase(): Provider[] {
  return [
    {
      provide: FIREBASE_AUTH,
      useFactory: (): Auth => getAuth(initializeApp(environment.firebase)),
    },
  ];
}
