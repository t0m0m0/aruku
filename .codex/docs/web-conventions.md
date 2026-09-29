# Web Conventions

- `tsc --noEmit`（strict）と `npm test` を緑に保つ
- `await` を跨いだ画面操作は、再開した時点でまだその画面にいるかを確かめてから行う
  （Flutter の `mounted` 相当。離脱後に続きが走ると store と遷移を書き換える）
- レイアウトの分岐は幅（`src/layout/breakpoints.ts`）で行い、UA やプラットフォームで分けない
- コンポーネントは小さく、合成できる形に保つ
