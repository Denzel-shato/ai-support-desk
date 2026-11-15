"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { TicketsApiError } from "@/lib/api/tickets";
import {
  CATEGORY_PRESETS,
  cleanKeywords,
  MAX_CATEGORY,
  MAX_CONTENT,
  MAX_KEYWORD,
  MAX_KEYWORDS,
  MAX_TITLE,
  validateArticleInput,
  type ArticleErrors,
  type ArticleInput,
} from "@/lib/knowledge-base";
import { MarkdownContent } from "./markdown-content";

const CUSTOM = "__custom__";

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? (
    <p id={id} className="mt-1 text-xs text-[#9E2A20]">
      {message}
    </p>
  ) : null;
}

function Label({ htmlFor, children, hint }: { htmlFor: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">
        {children}
      </label>
      {hint && <span className="text-[11px] text-subtle-foreground">{hint}</span>}
    </div>
  );
}

/**
 * "Add article" form in a native <dialog> (focus trap, Esc and backdrop for free).
 * `onSubmit` performs the save and resolves on success (the parent then closes
 * the dialog); if it throws, the dialog stays open with everything the user
 * typed and shows the error, so they can fix it and press Save again.
 */
export function ArticleFormDialog({
  existingCategories,
  onSubmit,
  onClose,
}: {
  existingCategories: string[];
  onSubmit: (input: ArticleInput) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState("");
  const [choice, setChoice] = useState("");
  const [custom, setCustom] = useState("");
  const [keywords, setKeywords] = useState<string[]>([]);
  const [keywordInput, setKeywordInput] = useState("");
  const [keywordNote, setKeywordNote] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [tab, setTab] = useState<"write" | "preview">("write");
  const [active, setActive] = useState(true);
  const [errors, setErrors] = useState<ArticleErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  // Presets first, then categories already used by articles; custom is always possible.
  const categories: string[] = [...CATEGORY_PRESETS];
  for (const c of existingCategories) {
    if (!categories.some((x) => x.toLowerCase() === c.toLowerCase())) categories.push(c);
  }
  const category = choice === CUSTOM ? custom : choice;

  const dirty =
    title.trim() !== "" || choice !== "" || keywords.length > 0 || keywordInput.trim() !== "" ||
    content.trim() !== "" || !active;

  function attemptClose() {
    if (saving) return;
    if (dirty && !window.confirm("Discard this article? What you've entered will be lost.")) return;
    onClose();
  }

  function addKeywords(raw: string) {
    const parts = raw.split(",").map((k) => k.trim()).filter(Boolean);
    if (parts.length === 0) {
      setKeywordInput("");
      return;
    }
    const next = cleanKeywords([...keywords, ...parts]);
    const added = next.length - keywords.length;
    if (next.some((k) => k.length > MAX_KEYWORD)) {
      setKeywordNote(`Keep each keyword under ${MAX_KEYWORD} characters.`);
      return;
    }
    if (next.length > MAX_KEYWORDS) {
      setKeywordNote(`Use at most ${MAX_KEYWORDS} keywords.`);
      return;
    }
    setKeywordNote(added < parts.length ? "Duplicate keywords were skipped." : null);
    setKeywords(next);
    setKeywordInput("");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    // A keyword typed but not yet added still counts.
    const pending = keywordInput.split(",").map((k) => k.trim()).filter(Boolean);
    const finalKeywords = cleanKeywords([...keywords, ...pending]);
    const parsed = validateArticleInput({ title, category, keywords: finalKeywords, content, active });
    if (!parsed.ok) {
      setErrors(parsed.errors);
      setFormError(null);
      return;
    }
    setErrors({});
    setFormError(null);
    setSaving(true);
    try {
      await onSubmit(parsed.value);
    } catch (error) {
      if (error instanceof TicketsApiError) {
        setErrors(error.fields as ArticleErrors);
        setFormError(error.message);
      } else {
        setFormError("Couldn't save the article. Nothing was saved; you can try again.");
      }
      setSaving(false);
    }
  }

  const busy = saving;

  return (
    <dialog
      ref={dialog}
      aria-labelledby="add-article-title"
      onCancel={(e) => {
        e.preventDefault();
        attemptClose();
      }}
      onClick={(e) => {
        if (e.target === dialog.current) attemptClose();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-2xl rounded-lg border border-border bg-surface p-0 text-foreground shadow-xl backdrop:bg-black/40"
    >
      <form onSubmit={submit} noValidate className="flex max-h-[90vh] flex-col">
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <h2 id="add-article-title" className="text-base font-semibold tracking-tight">
              Add article
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Saved to the knowledge base the AI checks before drafting replies.
            </p>
          </div>
          <Button type="button" variant="ghost" size="icon" onClick={attemptClose} disabled={busy} aria-label="Close">
            <X />
          </Button>
        </div>

        <div className="space-y-4 overflow-y-auto px-5 py-4">
          {formError && (
            <div role="alert" className="flex items-start gap-2 rounded-md border border-[#F0C9C5] bg-[#FBEAE8] px-3 py-2 text-[13px] text-[#9E2A20]">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
              <p>{formError}</p>
            </div>
          )}

          <div>
            <Label htmlFor="kb-title">Article title</Label>
            <Input
              id="kb-title"
              className="mt-1.5"
              value={title}
              maxLength={MAX_TITLE + 50}
              disabled={busy}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="How to Update Account Details"
              aria-invalid={errors.title ? true : undefined}
              aria-describedby={errors.title ? "kb-title-error" : undefined}
              required
            />
            <FieldError id="kb-title-error" message={errors.title} />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="kb-category">Category</Label>
              <Select
                className="mt-1.5"
                id="kb-category"
                value={choice}
                disabled={busy}
                onChange={(e) => setChoice(e.target.value)}
                aria-invalid={errors.category ? true : undefined}
                aria-describedby={errors.category ? "kb-category-error" : undefined}
              >
                <option value="">Select a category</option>
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
                <option value={CUSTOM}>Other (custom)…</option>
              </Select>
              {choice === CUSTOM && (
                <Input
                  className="mt-2"
                  value={custom}
                  maxLength={MAX_CATEGORY + 20}
                  disabled={busy}
                  onChange={(e) => setCustom(e.target.value)}
                  placeholder="Custom category name"
                  aria-label="Custom category name"
                  aria-invalid={errors.category ? true : undefined}
                  aria-describedby={errors.category ? "kb-category-error" : undefined}
                />
              )}
              <FieldError id="kb-category-error" message={errors.category} />
            </div>

            <div>
              <span className="text-xs font-medium text-muted-foreground" id="kb-active-label">
                Status
              </span>
              <div className="mt-1.5 flex h-8 items-center gap-2.5">
                <button
                  type="button"
                  role="switch"
                  aria-checked={active}
                  aria-labelledby="kb-active-label kb-active-text"
                  disabled={busy}
                  onClick={() => setActive((v) => !v)}
                  className={`relative h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/40 disabled:opacity-50 ${
                    active ? "bg-accent" : "bg-border-strong"
                  }`}
                >
                  <span
                    aria-hidden
                    className={`absolute left-0.5 top-0.5 size-4 rounded-full bg-white shadow transition-transform ${
                      active ? "translate-x-4" : ""
                    }`}
                  />
                </button>
                <span id="kb-active-text" className="text-[13px]">
                  {active ? "Active" : "Inactive"}
                </span>
              </div>
              <FieldError id="kb-active-error" message={errors.active} />
            </div>
          </div>

          <div>
            <Label htmlFor="kb-keyword" hint={`${keywords.length}/${MAX_KEYWORDS}`}>
              Keywords
            </Label>
            <div className="mt-1.5 flex gap-2">
              <Input
                id="kb-keyword"
                value={keywordInput}
                disabled={busy}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v.includes(",")) addKeywords(v);
                  else setKeywordInput(v);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault(); // Enter adds a keyword; it doesn't submit the form
                    addKeywords(keywordInput);
                  }
                }}
                onBlur={() => keywordInput.trim() && addKeywords(keywordInput)}
                placeholder="Type a keyword, press Enter"
                aria-describedby="kb-keyword-note"
              />
              <Button
                type="button"
                variant="outline"
                disabled={busy || keywordInput.trim() === ""}
                onClick={() => addKeywords(keywordInput)}
              >
                <Plus />
                Add
              </Button>
            </div>
            <p id="kb-keyword-note" className="mt-1 text-xs text-subtle-foreground" aria-live="polite">
              {keywordNote ?? "Words customers use for this problem. Separate several with commas."}
            </p>
            <FieldError id="kb-keywords-error" message={errors.keywords} />
            {keywords.length > 0 && (
              <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Added keywords">
                {keywords.map((k) => (
                  <li
                    key={k}
                    className="flex items-center gap-1 rounded-md border border-border bg-surface-muted py-0.5 pl-2 pr-0.5 text-xs text-muted-foreground"
                  >
                    {k}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setKeywords((list) => list.filter((x) => x !== k))}
                      aria-label={`Remove keyword ${k}`}
                      className="flex size-4 items-center justify-center rounded hover:bg-black/5 hover:text-foreground disabled:opacity-50"
                    >
                      <X className="size-3" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <div className="flex flex-wrap items-end justify-between gap-2">
              <label htmlFor="kb-content" className="text-xs font-medium text-muted-foreground">
                Article content
              </label>
              <div role="tablist" aria-label="Editor mode" className="flex rounded-md border border-border p-0.5 text-xs">
                {(["write", "preview"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    role="tab"
                    aria-selected={tab === t}
                    onClick={() => setTab(t)}
                    className={`rounded px-2.5 py-0.5 capitalize ${
                      tab === t ? "bg-accent-soft font-medium text-accent" : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
            {tab === "write" ? (
              <>
                <Textarea
                  id="kb-content"
                  className="mt-1.5 min-h-56 font-mono text-[12.5px]"
                  value={content}
                  disabled={busy}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder={"## Symptoms\n- What the customer sees\n\n## Steps\n1. First step\n2. Second step with **bold** text"}
                  aria-invalid={errors.content ? true : undefined}
                  aria-describedby={errors.content ? "kb-content-error" : "kb-content-hint"}
                  required
                />
                <p id="kb-content-hint" className="mt-1 flex flex-wrap justify-between gap-2 text-xs text-subtle-foreground">
                  <span>Markdown: # headings, **bold**, 1. numbered steps, - bullets.</span>
                  <span className={content.trim().length > MAX_CONTENT ? "text-[#9E2A20]" : undefined}>
                    {content.trim().length.toLocaleString("en-US")} / {MAX_CONTENT.toLocaleString("en-US")}
                  </span>
                </p>
              </>
            ) : (
              <div className="mt-1.5 min-h-56 rounded-md border border-border bg-surface-muted/40 p-4">
                {content.trim() ? (
                  <MarkdownContent source={content} title={title} />
                ) : (
                  <p className="text-[13px] text-subtle-foreground">Nothing to preview yet.</p>
                )}
              </div>
            )}
            <FieldError id="kb-content-error" message={errors.content} />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border bg-surface-muted/40 px-5 py-3">
          <Button type="button" variant="ghost" onClick={attemptClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {busy ? "Saving…" : "Save article"}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
