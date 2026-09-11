# Seen · X 閲覧履歴

**言語 / Languages:** [简体中文](README.md) · [English](README.en.md) · [Français](README.fr.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

Seen はデスクトップ向けの Chrome / Edge Manifest V3 拡張機能です。X（旧 Twitter）で実際に閲覧した投稿をブラウザ内に保存し、X の右側に固定されるパネルまたは独立した履歴ページから検索・絞り込みできます。

流れの速い X では、さっき読んだ投稿を見失いがちです。Seen は X API、追加アカウント、外部サーバーを必要とせず、閲覧データをアップロードしません。

## 主な機能

- 投稿の 50 % 以上が表示され、設定した滞在時間（0.8 / 1 / 1.5 / 2 秒）を満たした場合だけ記録。
- 通常の投稿、長文、引用、画像、動画/GIF、X 記事に対応。
- バックグラウンド、フォーカス喪失、DM・Grok・設定ページでは収集を停止。
- 本文、投稿者、ユーザー名、引用文、記事タイトル/概要を検索。
- すべて、テキスト、画像、動画/GIF、記事のフィルター。
- 閲覧日時の範囲指定と「今日」「過去 7 日」「過去 30 日」のプリセット。
- パネルは右カラムに収まり、閲覧中に自動更新。変更がない場合は不要な再描画を行いません。
- 投稿者名からプロフィール、リンクから元投稿へ移動。記事はカバー・タイトル・概要カード、画像は元の比率で表示。
- 独立ページで並べ替え、ページング、個別/一括削除、収集停止、JSON バックアップ、ライト/ダーク/システムテーマを利用可能。

## 技術と仕組み

TypeScript、Manifest V3、Dexie 4 / IndexedDB、esbuild、Node.js Test Runner、IntersectionObserver、MutationObserver、`requestIdleCallback`、Web Worker を使用しています。

コンテンツスクリプトが `article[data-testid="tweet"]` から投稿情報を抽出し、表示率と滞在時間を監視します。条件を満たしたイベントを Service Worker がまとめて IndexedDB に保存します。検索は正規化テキスト、作者インデックス、n-gram、安定したカーソルを使います。インラインパネルは 3 秒ごとに状態を確認し、`history-changed` 通知も受け取ります。

## プライバシー

データは現在のブラウザプロファイルの IndexedDB にのみ保存されます。外部 API、解析、アカウント、アップロード機能はありません。メディア URL は `https://pbs.twimg.com` に限定し、インポートデータは検証・エスケープして表示します。

## インストール

Node.js 18+、Chrome 116+（または同等の Edge）が必要です。

```bash
git clone https://github.com/DescLee/x-you-have-seen.git
cd x-you-have-seen
npm install
npm run build
```

`chrome://extensions`（Edge は `edge://extensions`）を開き、デベロッパーモードを有効にして **パッケージ化されていない拡張機能を読み込む** から `dist/` を選択します。`x.com` と `twitter.com` へのアクセスを許可し、X を再読み込みしてください。

```bash
npm run package
```

`release/seen-0.1.0.zip` と SHA-256 ファイルを生成します。

## 開発と検証

```bash
npm run typecheck
npm test
npm run check
npm run package
```

可視率、滞在時間、重複統合、多言語検索、メディア/記事カード、日時フィルター、ページング、入出力、クリーンアップ、安全境界をテストしています。ブラウザー用スクリプトは `scripts/qa-*.js` にあります。

## 既知の制限

- デスクトップ版 X 向けで、モバイル版は対象外です。
- X の DOM 変更時は `src/extract.ts` のセレクター更新が必要になる場合があります。
- 画像と記事カバーはアクセス可能な `pbs.twimg.com` URL に依存します。
- 履歴はブラウザプロファイル単位で、端末間同期は行いません。

## ライセンス

本プロジェクトは [Apache License 2.0](LICENSE) の下で公開されています。Copyright 2026 DescLee.

ライセンスの条件に従い、商用利用を含む使用・変更・再配布が可能です。再配布時は適用される権利表示を保持し、ライセンスのコピーを添付し、変更したファイルにその旨を明記してください。詳細は [LICENSE](LICENSE) と [NOTICE](NOTICE) を参照してください。第三者の依存ライブラリには、それぞれのライセンスが適用されます。
