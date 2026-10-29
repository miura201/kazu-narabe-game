# かずならべ（仮）

数字をお題に沿った「ひとこと」で表現し、みんなで小さい順に並べる協力型ブラウザゲーム。
仕様は [SPEC.md](SPEC.md) を参照。

## しくみ

- 部屋の状態は Firebase Realtime Database で全員の画面に同期する。
- 参加者は匿名ログイン（操作不要）。手札の数字は本人しか読めず、全カードの数字は答え合わせ中だけ読める。
- ホストは部屋を作る前に Google でログインすると、ゲーム履歴が自分のアカウントに保存される。
- セキュリティルールは [database.rules.json](database.rules.json)。変更したら Firebase コンソールの
  Realtime Database →「ルール」に貼り付けて公開する。

## ローカルで動かす

```
powershell -ExecutionPolicy Bypass -File serve.ps1
```

ブラウザで http://localhost:8000 を開く。

複数人の動きを試すときは、**新しいタブ** を開いて招待リンクを貼り付ける（タブごとに別の参加者になる）。
「タブを複製」で開くと同じ参加者として扱われるので注意。

## ファイル構成

| ファイル | 役割 |
|---|---|
| `index.html` | ページの土台 |
| `css/style.css` | 見た目 |
| `js/app.js` | 画面の表示と操作 |
| `js/logic.js` | ルールの計算（配る、赤くする判定、ずれていたカードの判定） |
| `js/drag.js` | カードのドラッグ操作（マウス・タッチ対応） |
| `js/store.js` | Firebase とのやりとり（部屋の状態・手札・履歴・ログイン） |
| `js/firebase-config.js` | Firebase の接続先 |
| `database.rules.json` | Firebase のセキュリティルール |
| `js/topics.js` | お題（仮） |
| `serve.ps1` | ローカル確認用の簡易サーバー |
