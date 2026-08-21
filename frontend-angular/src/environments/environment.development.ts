/**
 * 開発環境の設定。ローカルで起動した Go バックエンドAPI を参照する。
 */
export const environment = {
  production: false,

  /** ローカル起動時の Go バックエンドAPI（既定ポート 8080） */
  apiBaseUrl: 'http://localhost:8080',

  /**
   * テスト運用専用のマスターユーザー。
   *
   * 本システムは当面スタンドアロンで運用し、認証・権限は統合先システムから
   * 受け取る想定のため、ログイン画面を設けず本ユーザーで自動ログインする。
   * このユーザーは role=master を持ち、全工程を単独で操作できる。
   *
   * 注意: パスワードはビルド成果物に含まれるため秘密にはできない。
   * 統合時には本設定ごと削除し、通常の認証に戻すこと。
   */
  masterUser: {
    employeeId: 'MASTER',
    password: 'RingiFlow-Master-2026',
  },

  /** 社員ID に付与して認証用メールアドレスを構成するドメイン（基本設計書 3.4節） */
  authEmailDomain: 'ringiflow.ajiado.co.jp',

  firebase: {
    apiKey: 'AIzaSyBROxJnBlWZeqUgAm8qpI-JUTLaeRDkSkM',
    authDomain: 'ringiflow-81f8d.firebaseapp.com',
    projectId: 'ringiflow-81f8d',
    storageBucket: 'ringiflow-81f8d.firebasestorage.app',
    messagingSenderId: '812083655988',
    appId: '1:812083655988:web:3d7fdbf33be9a8c264e161',
  },
};
