# webapp

iPhone 向けの小さな WEB アプリ集です。GitHub Pages で公開すると、各アプリを Safari から開けます。

## アプリ一覧

| アプリ | 概要 |
| --- | --- |
| [app06 ランチャー](app06/index.html) | app06 のアプリをホーム画面風に並べたランチャー |
| [そら模様](app06/weather/weather.html) | 現在地の天気・気温・湿度・降水確率・気圧・花粉・黄砂・PM2.5 を表示 |
| [ピンボール](app06/pinball.html) / [コップの水](app06/cup.html) / [Gメーター](app06/gmeter.html) / [現在地](app06/location.html) / [マップ](app06/map.html) / [サウンド](app06/visualizer.html) | app06 のその他のアプリ |

### そら模様（app06/weather）

- 天気・気温・湿度・降水確率・気圧: [Open-Meteo](https://open-meteo.com/)（APIキー不要）
- PM2.5・黄砂（大気中ダスト濃度）: Open-Meteo Air Quality（CAMS 予測モデル）
- 花粉: 日本の花粉はキー不要の無料データが無いため、標準では季節の目安を表示。⚙︎ から Google Pollen API キーを入れると実測レベルを表示します（キーは端末内にのみ保存）。
- 地名: 国土地理院 逆ジオコーダー

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
