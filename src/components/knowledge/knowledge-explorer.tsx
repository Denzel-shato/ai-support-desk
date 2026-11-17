"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Pencil, Plus, Power, RefreshCw, Search, SearchX, X } from "lucide-react";
import { RefreshFailedNotice } from "@/components/overview/overview-states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useKnowledgeBase } from "@/hooks/use-knowledge-base";
import {
  createKnowledgeArticle,
  setArticleActive,
  updateKnowledgeArticle,
} from "@/lib/api/knowledge-base";
import { TicketsApiError } from "@/lib/api/tickets";
import {
  articleTitle,
  searchArticles,
  searchTerms,
  type ArticleInput,
} from "@/lib/knowledge-base";
import { formatDateTime } from "@/lib/ticket-detail";
import type { KnowledgeArticle } from "@/lib/types";
import { TruncationNotice } from "@/components/ui/truncation-notice";
import { MAX_ARTICLES } from "@/lib/limits";
import { ArticleFormDialog } from "./article-form-dialog";
import { MarkdownContent } from "./markdown-content";
import { KnowledgeEmpty, KnowledgeError, KnowledgeSkeleton } from "./knowledge-states";

function StatusBadge({ active }: { active: boolean | null }) {
  if (active === null) {
    return <Badge style={{ backgroundColor: "#EEF0F2", color: "#4B5563" }}>Status not set</Badge>;
  }
  return active ? (
    <Badge style={{ backgroundColor: "#E5F2EB", color: "#1F6B45" }}>
      <span aria-hidden className="size-1.5 rounded-full bg-[#1F6B45]" />
      Active
    </Badge>
  ) : (
    <Badge style={{ backgroundColor: "#EEF0F2", color: "#4B5563" }}>
      <span aria-hidden className="size-1.5 rounded-full bg-[#9CA3AF]" />
      Inactive
    </Badge>
  );
}

function ArticleReader({
  article,
  terms,
  onEdit,
  onToggleActive,
  toggling,
}: {
  article: KnowledgeArticle;
  terms: string[];
  onEdit: () => void;
  /** Resolves when the change has been saved; throws are handled by the parent. */
  onToggleActive: (active: boolean) => void;
  toggling: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const isActive = article.active === true;
  const updated = formatDateTime(article.updatedAt);
  return (
    <Card>
      <CardHeader className="block space-y-3 pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h2 className="text-lg font-semibold leading-snug tracking-tight">
            {articleTitle(article)}
          </h2>
          <StatusBadge active={article.active} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={onEdit} disabled={toggling}>
            <Pencil />
            Edit article
          </Button>
          {isActive ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirming(true)}
              disabled={toggling || confirming}
            >
              <Power />
              Deactivate
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onToggleActive(true)}
              disabled={toggling}
            >
              {toggling ? <Loader2 className="animate-spin" aria-hidden /> : <Power />}
              {toggling ? "Activating…" : "Activate"}
            </Button>
          )}
        </div>
        {confirming && (
          <div
            role="alertdialog"
            aria-label="Confirm deactivation"
            className="flex flex-wrap items-center gap-2 rounded-md border border-border-strong bg-surface-muted px-3 py-2.5 text-[13px]"
          >
            <span className="mr-auto">
              Deactivate this article? It is kept, with everything in it, and can be
              reactivated at any time.
            </span>
            <Button
              size="sm"
              onClick={() => {
                setConfirming(false);
                onToggleActive(false);
              }}
              disabled={toggling}
            >
              Yes, deactivate
            </Button>
            <Button size="sm" variant="outline" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        )}
        {toggling && isActive && (
          <p role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            Deactivating…
          </p>
        )}
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-2">
          <div>
            <dt className="text-xs text-muted-foreground">Category</dt>
            <dd>{article.category ?? <span className="text-subtle-foreground">Not set</span>}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Article ID</dt>
            <dd className="break-all font-mono text-[12px]">{article.id}</dd>
          </div>
          {updated && (
            <div>
              <dt className="text-xs text-muted-foreground">Last updated</dt>
              <dd>{updated}</dd>
            </div>
          )}
          <div className="sm:col-span-2">
            <dt className="text-xs text-muted-foreground">Keywords</dt>
            <dd className="mt-1 flex flex-wrap gap-1.5">
              {article.keywords.length > 0 ? (
                article.keywords.map((k) => (
                  <span
                    key={k}
                    className="rounded-md border border-border bg-surface-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                  >
                    {k}
                  </span>
                ))
              ) : (
                <span className="text-subtle-foreground">None</span>
              )}
            </dd>
          </div>
        </dl>
        {article.active === false && (
          <p className="rounded-md bg-surface-muted px-3 py-2 text-xs text-muted-foreground">
            This article is inactive. It is kept here so you can read it and
            reactivate it.
          </p>
        )}
      </CardHeader>
      <CardContent className="border-t border-border pt-5">
        <MarkdownContent source={article.content} terms={terms} title={articleTitle(article)} />
      </CardContent>
    </Card>
  );
}

export function KnowledgeExplorer() {
  const { articles, error, loading, refreshing, truncated, refresh, addArticle, replaceArticle } =
    useKnowledgeBase();
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const reader = useRef<HTMLDivElement>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<KnowledgeArticle | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "success" | "error"; message: string } | null>(null);

  // The success notice clears itself after a few seconds.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 7000);
    return () => clearTimeout(timer);
  }, [notice]);

  /** Saves via the API; throws on failure so the form stays open with its data. */
  async function create(input: ArticleInput, requestId: string) {
    const article = await createKnowledgeArticle(input, requestId);
    addArticle(article);
    setQuery(""); // make sure the new article isn't filtered out
    setSelectedId(article.id);
    setNotice({ kind: "success", message: `Article created: ${article.title ?? article.id}` });
    setAdding(false);
  }

  /** Saves edits to the same document; throws on failure so the form keeps the input. */
  async function saveEdit(input: ArticleInput) {
    if (!editing) return;
    const article = await updateKnowledgeArticle(editing.id, input, editing.version);
    replaceArticle(article);
    setNotice({ kind: "success", message: `Changes saved: ${article.title ?? article.id}` });
    setEditing(null);
  }

  async function toggleActive(article: KnowledgeArticle, active: boolean) {
    if (togglingId) return;
    setTogglingId(article.id);
    setNotice(null);
    try {
      const updated = await setArticleActive(article.id, active);
      replaceArticle(updated);
      setNotice({
        kind: "success",
        message: `${active ? "Activated" : "Deactivated"}: ${updated.title ?? updated.id}`,
      });
    } catch (error) {
      setNotice({
        kind: "error",
        message:
          error instanceof TicketsApiError
            ? error.message
            : `Couldn't ${active ? "activate" : "deactivate"} the article. Nothing was changed.`,
      });
    } finally {
      setTogglingId(null);
    }
  }

  const terms = useMemo(() => searchTerms(query), [query]);
  const hits = useMemo(
    () => (articles ? searchArticles(articles, query) : []),
    [articles, query],
  );
  const selected =
    hits.find((h) => h.article.id === selectedId)?.article ?? hits[0]?.article ?? null;

  const total = articles?.length ?? 0;

  function select(id: string) {
    setSelectedId(id);
    // On small screens the reader sits below the list: bring it into view.
    if (window.matchMedia("(max-width: 1023px)").matches) {
      reader.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  return (
    <div className="space-y-5">
      <section className="flex flex-wrap items-end justify-between gap-3">
        <p className="text-[13px] text-muted-foreground">
          The troubleshooting knowledge the AI checks before classifying tickets
          and drafting replies.
        </p>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={refresh} disabled={loading || refreshing}>
            <RefreshCw className={refreshing ? "animate-spin" : undefined} />
            Refresh
          </Button>
          <Button onClick={() => setAdding(true)} disabled={!articles}>
            <Plus />
            Add article
          </Button>
        </div>
      </section>

      {truncated && <TruncationNotice noun="articles" limit={MAX_ARTICLES} />}

      {notice && (
        <div
          role={notice.kind === "error" ? "alert" : "status"}
          className={`flex items-start gap-2 rounded-md border px-3 py-2 text-[13px] ${
            notice.kind === "error"
              ? "border-[#F0C9C5] bg-[#FBEAE8] text-[#9E2A20]"
              : "border-[#BFE0CE] bg-[#E5F2EB] text-[#1F6B45]"
          }`}
        >
          {notice.kind === "error" ? (
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          ) : (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
          )}
          <span className="mr-auto">{notice.message}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label="Dismiss"
            className="flex size-5 items-center justify-center rounded hover:bg-black/5"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      )}

      {editing && (
        <ArticleFormDialog
          key={editing.id}
          article={editing}
          existingCategories={[...new Set((articles ?? []).map((a) => a.category).filter((c): c is string => !!c))]}
          onSubmit={saveEdit}
          onClose={() => setEditing(null)}
        />
      )}

      {adding && (
        <ArticleFormDialog
          existingCategories={[...new Set((articles ?? []).map((a) => a.category).filter((c): c is string => !!c))]}
          onSubmit={create}
          onClose={() => setAdding(false)}
        />
      )}

      {loading && <KnowledgeSkeleton />}

      {!loading && !articles && error && (
        <KnowledgeError error={error} onRetry={refresh} retrying={refreshing} />
      )}

      {articles && total === 0 && (
        <KnowledgeEmpty onRefresh={refresh} refreshing={refreshing} />
      )}

      {articles && total > 0 && (
        <>
          {error && <RefreshFailedNotice error={error} updatedAt={null} />}

          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
            <Card className="lg:sticky lg:top-4">
              <div className="space-y-3 p-4">
                <div className="relative">
                  <Search
                    className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-subtle-foreground"
                    aria-hidden
                  />
                  <Input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search articles"
                    aria-label="Search articles by title, category, keywords or content"
                    className="pl-8 pr-8"
                  />
                  {query && (
                    <button
                      type="button"
                      onClick={() => setQuery("")}
                      aria-label="Clear search"
                      className="absolute right-1.5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-black/5 hover:text-foreground"
                    >
                      <X className="size-3.5" aria-hidden />
                    </button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground" aria-live="polite">
                  {terms.length > 0
                    ? `${hits.length} of ${total} ${total === 1 ? "article" : "articles"}`
                    : `${total} ${total === 1 ? "article" : "articles"}`}
                </p>

                {hits.length > 0 ? (
                  <ul className="space-y-1.5">
                    {hits.map(({ article, snippet }) => {
                      const current = selected?.id === article.id;
                      return (
                        <li key={article.id}>
                          <button
                            type="button"
                            onClick={() => select(article.id)}
                            aria-current={current ? "true" : undefined}
                            className={`w-full rounded-md border px-3 py-2.5 text-left transition-colors ${
                              current
                                ? "border-accent bg-accent-soft"
                                : "border-border hover:bg-surface-muted"
                            } ${article.active === false ? "opacity-75" : ""}`}
                          >
                            <span className="block text-[13px] font-medium leading-snug">
                              {articleTitle(article)}
                            </span>
                            <span className="mt-1.5 flex flex-wrap items-center gap-2">
                              <StatusBadge active={article.active} />
                              {article.category && (
                                <span className="text-xs text-muted-foreground">
                                  {article.category}
                                </span>
                              )}
                            </span>
                            {snippet && (
                              <span className="mt-1.5 block text-xs leading-relaxed text-muted-foreground">
                                {snippet}
                              </span>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <div className="flex flex-col items-center py-8 text-center">
                    <span className="flex size-9 items-center justify-center rounded-md border border-border bg-surface-muted text-muted-foreground">
                      <SearchX className="size-4" aria-hidden />
                    </span>
                    <h3 className="mt-3 text-sm font-semibold">No articles match</h3>
                    <p className="mt-1 text-[13px] text-muted-foreground">
                      Nothing matches &ldquo;{query.trim()}&rdquo;.
                    </p>
                    <Button variant="outline" className="mt-3" onClick={() => setQuery("")}>
                      Clear search
                    </Button>
                  </div>
                )}
              </div>
            </Card>

            <div ref={reader} className="min-w-0 scroll-mt-4">
              {selected ? (
                <ArticleReader
                  key={selected.id}
                  article={selected}
                  terms={terms}
                  onEdit={() => setEditing(selected)}
                  onToggleActive={(active) => void toggleActive(selected, active)}
                  toggling={togglingId === selected.id}
                />
              ) : (
                <div className="rounded-lg border border-border bg-surface p-8 text-center text-[13px] text-muted-foreground">
                  Select an article to read it.
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
