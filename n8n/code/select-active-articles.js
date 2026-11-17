// n8n Code node "Select active articles"  (mode: Run Once for All Items)
//
// Input:  every document the Firestore "Get many documents" node returned
//         from `knowledge_base` (one item per article; possibly none).
// Output: EXACTLY ONE item. That is what stops the rest of the workflow from
//         running once per article (and creating one ticket per article).
//
// - Inactive articles (active !== true) are dropped.
// - Each article keeps its metadata (id, title, category, keywords) so the
//   model can cite the right section and tell articles apart.
const isTrue = (v) => v === true || (typeof v === 'string' && v.trim().toLowerCase() === 'true');
const text = (v) => (typeof v === 'string' ? v.trim() : '');
const keywords = (a) =>
  Array.isArray(a.keywords)
    ? a.keywords.filter((k) => typeof k === 'string' && k.trim()).join(', ')
    : text(a.keywords);

const articles = $input
  .all()
  .map((item) => item.json)
  .filter((a) => a && isTrue(a.active) && text(a.content));

const knowledgeBase = articles.length
  ? articles
      .map((a, i) =>
        [
          `### ARTICLE ${i + 1} of ${articles.length}`,
          `ID: ${a._id ?? a.id ?? 'unknown'}`,
          `Title: ${text(a.title) || '(untitled)'}`,
          `Category: ${text(a.category) || '(none)'}`,
          `Keywords: ${keywords(a) || '(none)'}`,
          'Content:',
          text(a.content),
        ].join('\n'),
      )
      .join('\n\n---\n\n')
  : 'NO ACTIVE KNOWLEDGE-BASE ARTICLES ARE AVAILABLE.';

return [
  {
    json: {
      knowledgeBase,
      articleCount: articles.length,
      articleTitles: articles.map((a) => text(a.title) || a._id || 'unknown'),
    },
  },
];
