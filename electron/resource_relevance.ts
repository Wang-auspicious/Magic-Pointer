import type {CollectedResource} from './resource_collection_contract';

export type RankedResource = CollectedResource & {relevanceReason?: string};

export function chronologicalResources<T extends CollectedResource>(
  items: T[],
): T[] {
  return [...items].sort(
    (left, right) =>
      (right.collection?.bookmarkBatch || right.capturedAt) -
        (left.collection?.bookmarkBatch || left.capturedAt) ||
      (left.collection?.bookmarkPosition || 0) -
        (right.collection?.bookmarkPosition || 0),
  );
}

/** Explainable local relevance to current work; no remote model request on sorting. */
export function prioritizeResources(
  items: CollectedResource[],
  focus: string,
  projectIds: string[] = [],
): RankedResource[] {
  const terms = [
    ...new Set(
      [...new Intl.Segmenter('zh', {granularity: 'word'}).segment(focus)]
        .filter(part => part.isWordLike && part.segment.length >= 2)
        .map(part => part.segment)
        .filter(
          term =>
            !/^(这个|那个|一下|什么|如何|一个|然后|现在|可以|项目|继续|帮我|怎么|the|and|with)$/i.test(
              term,
            ),
        ),
    ),
  ];
  const ordered = chronologicalResources(items);
  const rows = ordered.map((item, index) => {
    const detail = item.collection;
    const text = [
      detail?.title,
      detail?.summary,
      detail?.sourceExcerpt,
      detail?.note,
      detail?.tags?.join(' '),
      detail?.nextStep,
      item.text,
    ]
      .join(' ')
      .toLocaleLowerCase();
    const matches = terms.filter(term =>
      text.includes(term.toLocaleLowerCase()),
    );
    const project = Boolean(
      detail?.projectId && projectIds.includes(detail.projectId),
    );
    const todo =
      detail?.intent === 'todo' || detail?.suggestedIntent === 'todo';
    const forgotten =
      !detail?.lastViewedAt && Date.now() - item.capturedAt > 86400000;
    const reason = matches.length
      ? `与你当前关注的「${matches.slice(0, 3).join('、')}」相关`
      : project
        ? '与你最近在做的项目相关'
        : todo
          ? '有待处理的下一步'
          : forgotten
            ? '以前保存，还没有回看'
            : '最近收录';
    return {
      item: {...item, relevanceReason: reason},
      matches: matches.length,
      project,
      todo,
      forgotten,
      index,
    };
  });
  rows.sort(
    (a, b) =>
      Number(b.matches > 0 || b.project) - Number(a.matches > 0 || a.project) ||
      b.matches - a.matches ||
      Number(b.project) - Number(a.project) ||
      Number(b.todo) - Number(a.todo) ||
      Number(b.forgotten) - Number(a.forgotten) ||
      a.index - b.index,
  );
  return rows.map(row => row.item);
}
