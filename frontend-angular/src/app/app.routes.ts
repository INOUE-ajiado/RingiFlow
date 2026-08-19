import { Routes } from '@angular/router';

import { authGuard, guestGuard } from './core/auth.guard';

export const routes: Routes = [
  {
    path: 'login',
    canActivate: [guestGuard],
    loadComponent: () => import('./features/auth-login').then((m) => m.AuthLoginComponent),
  },
  {
    path: 'ringi',
    canActivate: [authGuard],
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
