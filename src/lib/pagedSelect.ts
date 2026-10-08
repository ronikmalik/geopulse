// Keyset paging for queries that return embeddings (2026-10-08).
//
// Neon's HTTP driver refuses any single response over 64 MB (HTTP 507
// "response is too large (max is 67108864 bytes)"). A 768-dim halfvec
// travels as ~9 KB of text, so one unbounded select stops working at
// ~7,000 rows: the weekly text-classifier and narrative-cluster trainings
// failed this way from 2026-09-27 (116 MB and 101 MB responses) while
// every other job stayed green. 2,000 rows is ~18 MB a page.
export const EMBEDDING_PAGE_ROWS = 2_000;

// fetchPage must return rows with id > afterId, ordered by id ascending,
// at most `limit` of them.
export async function selectInIdPages<T extends { id: number }>(
  fetchPage: (afterId: number, limit: number) => Promise<T[]>,
  pageRows: number = EMBEDDING_PAGE_ROWS,
): Promise<T[]> {
  const rows: T[] = [];
  let afterId = 0;
  for (;;) {
    const page = await fetchPage(afterId, pageRows);
    for (const row of page) rows.push(row);
    if (page.length < pageRows) return rows;
    afterId = page[page.length - 1].id;
  }
}
