/**
 * 本番環境の設定。
 *
 * firebaseConfig の apiKey はクライアントに埋め込まれる前提の公開識別子であり、
 * 秘密情報ではない。アクセス制御は Firestore セキュリティルール（読み書き全面禁止）と
 * Go バックエンドAPI の JWT 検証によって担保する（基本設計書 4.2節）。
 */
export const environment = {
  production: true,

  /** Go バックエンドAPI のベースURL（Cloud Run のデプロイ後に差し替える） */
  apiBaseUrl: 'https://ringiflow-api-812083655988.asia-northeast1.run.app',

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
