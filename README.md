# 画像サイズ変換

Mac の Finder にある「クイックアクション → 画像を変換」と同じように、画像をまとめて縮小・形式変換できるウェブページです。Windows でもブラウザだけで使えます。

**使う:** https://yuki-hata.github.io/image-resize/

## できること

- 画像をドラッグ＆ドロップでまとめて変換（フォルダごとでも可。クリックして選ぶ・貼り付けも可）
- 形式: JPEG（初期設定）／PNG／WebP
- サイズ: 長い辺を 640・1280（初期設定）・1920・2560px、元のサイズ、または好きな数値に。元より大きくはしません
- 画質の調整（JPEG・WebP）
- iPhone の写真（HEIC）の読み込み
- 保存: 1枚ずつ、ZIP でまとめて、またはフォルダを選んで直接保存（Edge・Chrome）

## 画像は送信されません

変換はすべてブラウザの中で行います。ページには通信を禁止する設定（Content-Security-Policy の `connect-src 'none'`）を入れてあり、画像をどこかへ送ることはできない作りです。

位置情報などの撮影情報（Exif）は書き出した画像には残りません。

## 使っている部品

- [heic2any](https://github.com/alexcorvi/heic2any) 0.0.4（MIT ライセンス、`vendor/heic2any-LICENSE.md`）: HEIC を読み込めないブラウザ向け。HEIC を渡したときだけ読み込みます。
