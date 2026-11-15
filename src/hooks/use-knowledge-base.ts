"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchKnowledgeArticles } from "@/lib/api/knowledge-base";
import { TicketsApiError } from "@/lib/api/tickets";
import { compareArticles } from "@/lib/knowledge-base";
import type { KnowledgeArticle } from "@/lib/types";

/**
 * Loads articles from /api/knowledge-base. Mirrors `useTickets`: `articles`
 * stays null until a real load succeeds (never mock data), and a failed
 * refresh keeps the last real data.
 */
export interface UseKnowledgeBaseResult {
  articles: KnowledgeArticle[] | null;
  error: TicketsApiError | null;
  loading: boolean;
  refreshing: boolean;
  refresh: () => void;
  /** Shows a just-created article at once, then re-reads Firestore to confirm. */
  addArticle: (article: KnowledgeArticle) => void;
  /** Same, for an edited or (de)activated article: replaces it in place by ID. */
  replaceArticle: (article: KnowledgeArticle) => void;
}

function toApiError(error: unknown): TicketsApiError {
  return error instanceof TicketsApiError
    ? error
    : new TicketsApiError("Something went wrong while loading the knowledge base.", {
        code: "unknown_error",
      });
}

export function useKnowledgeBase(): UseKnowledgeBaseResult {
  const [articles, setArticles] = useState<KnowledgeArticle[] | null>(null);
  const [error, setError] = useState<TicketsApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const controller = useRef<AbortController | null>(null);

  const request = useCallback(() => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;

    fetchKnowledgeArticles(current.signal)
      .then((data) => {
        if (current.signal.aborted) return;
        setArticles(data);
        setError(null);
      })
      .catch((err: unknown) => {
        if (current.signal.aborted) return;
        setError(toApiError(err));
      })
      .finally(() => {
        if (current.signal.aborted) return;
        setLoading(false);
        setRefreshing(false);
      });
  }, []);

  useEffect(() => {
    request();
    return () => controller.current?.abort();
  }, [request]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    request();
  }, [request]);

  const addArticle = useCallback(
    (article: KnowledgeArticle) => {
      setArticles((prev) =>
        [...(prev ?? []).filter((a) => a.id !== article.id), article].sort(compareArticles),
      );
      setError(null);
      setLoading(false);
      request(); // the list stays Firestore-backed: re-read it
    },
    [request],
  );

  // Both add a new ID or replace an existing one; the ID is the identity.
  return { articles, error, loading, refreshing, refresh, addArticle, replaceArticle: addArticle };
}
