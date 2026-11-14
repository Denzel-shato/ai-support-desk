import type { Priority, TicketStatus } from "./types";

export const priorityMeta: Record<
  Priority,
  { label: string; color: string; soft: string; text: string }
> = {
  urgent: { label: "Urgent", color: "#C93A2E", soft: "#FBEAE8", text: "#9E2A20" },
  high: { label: "High", color: "#D9791A", soft: "#FCEFDF", text: "#9A560E" },
  medium: { label: "Medium", color: "#C9A227", soft: "#F8F1D8", text: "#7A6212" },
  low: { label: "Low", color: "#7C8A99", soft: "#EDF0F3", text: "#525F6D" },
  unspecified: {
    label: "Unspecified",
    color: "#B9BCC2",
    soft: "#F1F1EF",
    text: "#6B6E75",
  },
};

export const statusMeta: Record<
  TicketStatus,
  { label: string; color: string }
> = {
  new: { label: "New", color: "#3B6FD4" },
  open: { label: "Open", color: "#3B6FD4" },
  awaiting_review: { label: "Awaiting review", color: "#8A5AC8" },
  escalated: { label: "Escalated", color: "#C93A2E" },
  resolved: { label: "Resolved", color: "#2E8A5B" },
};
