// ===============================================================
//  Firebase の設定（オセロ・かぞく予定と同じプロジェクト）
// ---------------------------------------------------------------
//  エアホッケーは対戦中の位置を速く同期するため、Firestore ではなく
//  「Realtime Database」を使います。
//
//  databaseURL は、Firebase コンソール → Realtime Database の画面上部に
//  表示される URL です。下の値は「シンガポール（asia-southeast1）」で
//  データベースを作った場合の URL なので、別の場所で作ったときは
//  表示された URL に書き換えてください。
//
//  ※ この値はパスワードではありません。公開リポジトリに置いても大丈夫です。
//    データを守るのは database.rules.json（セキュリティルール）の役目です。
// ===============================================================
export const firebaseConfig = {
  apiKey: "AIzaSyDPJ1PjCxLXYii8eliInDrD8bZ3zNwiK7Y",
  authDomain: "terabe-family-shopping.firebaseapp.com",
  projectId: "terabe-family-shopping",
  storageBucket: "terabe-family-shopping.firebasestorage.app",
  messagingSenderId: "348087156148",
  appId: "1:348087156148:web:dddd7fb6f3e998b55506e1",
  measurementId: "G-3LQN1FGH9Z",
  databaseURL: "https://terabe-family-shopping-default-rtdb.asia-southeast1.firebasedatabase.app",
};
