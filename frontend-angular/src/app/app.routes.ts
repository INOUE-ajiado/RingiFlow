import { Routes } from '@angular/router';

// ログイン画面は設けていない（起動時にマスターユーザーで自動ログインするため）。
// 認証の確立待ちと失敗表示はアプリシェル（App）が担当するので、ここにガードは置かない。
// 統合時に実際の認証を導入する際は、ここへ CanActivateFn を追加する。
export const routes: Routes = [
  {
    path: 'ringi',
    children: [
      {
        path: '',
        loadComponent: () =>
          import('./features/ringi-dashboard').then((m) => m.RingiDashboardComponent),
      },
      {
        // ':id' より前に定義する必要がある
        path: 'new',
        loadComponent: () => import('./features/ringi-create').then((m) => m.RingiCreateComponent),
      },
      {
        path: ':id',
        loadComponent: () => import('./features/ringi-detail').then((m) => m.RingiDetailComponent),
      },
      {
        // 差し戻された稟議の修正・再申請
        path: ':id/edit',
        loadComponent: () => import('./features/ringi-create').then((m) => m.RingiCreateComponent),
      },
    ],
  },
  { path: '', pathMatch: 'full', redirectTo: 'ringi' },
  { path: '**', redirectTo: 'ringi' },
];
