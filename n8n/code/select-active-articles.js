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
// - `articles` carries the active articles themselves (id, title, content). 'Build ticket' and
//   'Prepare email fields' check every automatic customer reply against these, never against the model.
const isTrue = (v) => v === true || (typeof v === 'string' && v.trim().toLowerCase() === 'true');
const text = (v) => (typeof v === 'string' ? v.trim() : '');
const keywords = (a) =>
  Array.isArray(a.keywords)
    ? a.keywords.filter((k) => typeof k === 'string' && k.trim()).join(', ')
    : text(a.keywords);

const items = $input.all();
// The Firestore node is set to "continue on error": a failed read arrives as an
// item carrying `error`. That must not be mistaken for "no articles exist".
const kbUnavailable = items.some((item) => item.json && item.json.error);

const articles = items
  .map((item) => item.json)
  .filter((a) => a && isTrue(a.active) && text(a.content));

const knowledgeBase = articles.length && !kbUnavailable
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
      articleCount: kbUnavailable ? 0 : articles.length,
      kbUnavailable,
      articleTitles: articles.map((a) => text(a.title) || a._id || 'unknown'),
      articles: kbUnavailable
        ? []
        : articles.map((a) => ({ id: String(a._id ?? a.id ?? ''), title: text(a.title), content: text(a.content) })),
    },
  },
];
