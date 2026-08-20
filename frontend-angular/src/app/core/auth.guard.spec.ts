import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, RouterStateSnapshot, UrlTree, provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import { authGuard, guestGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { AppUser } from './models';

/**
 * AuthService のスタブ。whenReady() が解決するまで待たせることで、
 * ガードが await をまたぐ経路を再現する。
 */
class AuthServiceStub {
  readonly appUser = signal<AppUser | null>(null);
  whenReady(): Promise<void> {
    // マイクロタスク境界を必ず1回はさむ
    return Promise.resolve();
  }
}

const route = {} as ActivatedRouteSnapshot;
const state = {} as RouterStateSnapshot;

function run(guard: typeof authGuard) {
  return TestBed.runInInjectionContext(() => guard(route, state));
}

describe('認証ガード', () => {
  let auth: AuthServiceStub;

  beforeEach(() => {
    auth = new AuthServiceStub();
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: AuthService, useValue: auth }],
    });
  });

  // await をまたいで inject() を呼ぶと NG0203 になる。
  // このテストはその退行を検出する。
  describe('authGuard', () => {
    it('未ログインならログイン画面へのUrlTreeを返す', async () => {
      const result = await run(authGuard);
      expect(result).toBeInstanceOf(UrlTree);
      expect(String(result)).toBe('/login');
    });

    it('ログイン済みなら通過させる', async () => {
      auth.appUser.set({ uid: 'u1', employeeId: 'E0001', name: 'テスト', role: 'applicant' });
      await expect(run(authGuard)).resolves.toBe(true);
    });
  });

  describe('guestGuard', () => {
    it('未ログインなら通過させる', async () => {
      await expect(run(guestGuard)).resolves.toBe(true);
    });

    it('ログイン済みなら一覧へのUrlTreeを返す', async () => {
      auth.appUser.set({ uid: 'u1', employeeId: 'E0001', name: 'テスト', role: 'ceo' });
      const result = await run(guestGuard);
      expect(result).toBeInstanceOf(UrlTree);
      expect(String(result)).toBe('/ringi');
    });
  });
});
