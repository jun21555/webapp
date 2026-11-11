# webapp

iPhone 向けの小さな WEB アプリ集です。GitHub Pages で公開すると、各アプリを Safari から開けます。

## アプリ一覧

| アプリ | 概要 |
| --- | --- |
| [app06 ランチャー](app06/index.html) | app06 のアプリをホーム画面風に並べたランチャー |
| [そら模様](app06/weather/weather.html) | 現在地の天気・気温・湿度・降水確率・気圧・花粉・黄砂・PM2.5 を表示 |
| [ゲレンデ積雪](app06/snow/snow.html) | 地域からスキー場を選び、推定積雪・新雪・7日間の降雪予報と近くのアメダス積雪を表示。お気に入り3件まで登録 |
| [ピンボール](app06/pinball.html) / [コップの水](app06/cup.html) / [Gメーター](app06/gmeter.html) / [現在地](app06/location.html) / [マップ](app06/map.html) / [サウンド](app06/visualizer.html) | app06 のその他のアプリ |

### そら模様（app06/weather）

- 天気・気温・湿度・降水確率・気圧: [Open-Meteo](https://open-meteo.com/)（APIキー不要）
- PM2.5・黄砂（大気中ダスト濃度）: Open-Meteo Air Quality（CAMS 予測モデル）
- 花粉: 日本の花粉はキー不要の無料データが無いため、標準では季節の目安を表示。⚙︎ から Google Pollen API キーを入れると実測レベルを表示します（キーは端末内にのみ保存）。
- 地名: 国土地理院 逆ジオコーダー

### ゲレンデ積雪（app06/snow）

- 地域（北海道・東北・関東・長野・山梨・新潟・北陸・東海・西日本）のチップからスキー場を選択
- ☆ でお気に入り登録（3つまで、端末内に保存）。お気に入りは画面上部にカード表示
- スキー場をタップすると、山頂付近／山麓の推定値と7日間の降雪予報グラフ、近くのアメダス実測を表示
- 積雪・降雪の推定・予報: [Open-Meteo](https://open-meteo.com/)（気象モデル、APIキー不要）。スキー場の公式発表値とは異なることがあります
- 実測: 気象庁アメダス（40km 以内で積雪を観測している最寄り地点）。出典: 気象庁ホームページ
- スキー場の座標・標高は概略です。追加は `snow.html` の `RESORTS` に1行足すだけ

## ローカルで動かす

```sh
python3 -m http.server 8000
# → http://localhost:8000/app06/weather/weather.html
```

位置情報は https か localhost でのみ使えます。

## iPhone のホーム画面に追加

1. Safari でアプリのページを開く
2. 共有ボタン（□↑）をタップ
3. 「ホーム画面に追加」を選ぶ
