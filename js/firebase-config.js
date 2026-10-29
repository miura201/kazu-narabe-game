// Firebase の接続先。パスワードではなく「どのプロジェクトにつなぐか」を示す値なので、公開しても問題ない。
// データの安全は database.rules.json のセキュリティルールで守る。
export const firebaseConfig = {
  apiKey: 'AIzaSyB-uAgHqa8fA7FcsO7ml-HXFW60-efyFMg',
  authDomain: 'kazu-narabe-game.firebaseapp.com',
  databaseURL: 'https://kazu-narabe-game-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId: 'kazu-narabe-game',
  storageBucket: 'kazu-narabe-game.firebasestorage.app',
  messagingSenderId: '286960775420',
  appId: '1:286960775420:web:b9f48f2830382c51ac2779',
};
