// ===============================================================
//  Firebase の設定
// ---------------------------------------------------------------
//  Firebase コンソール →「プロジェクトの設定」→「マイアプリ」
//  →「ウェブアプリ」の SDK の設定にある firebaseConfig の値を
//  下にそのまま貼り付けてください。
//
//  apiKey が空のままだと「デモモード」で動きます。
//  （予定はこの端末の中だけに保存され、家族とは共有されません）
//
//  ※ この値はパスワードではありません。公開リポジトリに置いても大丈夫です。
//    データを守るのは Firestore のセキュリティルール（firestore.rules）の役目です。
// ===============================================================
export const firebaseConfig = {
  apiKey: "AIzaSyDPJ1PjCxLXYii8eliInDrD8bZ3zNwiK7Y",
  authDomain: "terabe-family-shopping.firebaseapp.com",
  projectId: "terabe-family-shopping",
  storageBucket: "terabe-family-shopping.firebasestorage.app",
  messagingSenderId: "348087156148",
  appId: "1:348087156148:web:dddd7fb6f3e998b55506e1",
  measurementId: "G-3LQN1FGH9Z",
};
