import { describe, expect, it } from "vitest";

// Plain browser JS, required directly (not compiled by tsc). paid-spend.js is
// loaded first because recategorize.js reads its price/model wording from it.
require("./paid-spend.js");
const R = require("./recategorize.js");

type Node = { id: number; name: string; sourceId?: number | null; edited?: boolean; locked?: boolean; change?: Record<string, unknown>; children: Node[] };

const tree = (): Node[] => [
  {
    id: 1,
    name: "AI",
    sourceId: 10,
    change: {},
    children: [{ id: 2, name: "Agents", sourceId: 11, change: {}, children: [] }],
  },
  { id: 3, name: "Cooking", change: { added: true }, children: [] },
];
const names = (nodes: Node[]): unknown[] => nodes.map((n) => (n.children.length ? [n.name, names(n.children)] : n.name));

const subscription = { providerId: "claude-cli", modelLabel: "Claude Opus 5.5", billing: "subscription" };
const jev = { providerId: "typesafe", modelLabel: "Jev (jev-latest)", billing: "per-token" };
const priced = { providerId: "pi-ai", modelLabel: "GPT-6", billing: "per-token", price: { input: 3, output: 15 } };

describe("draft edits", () => {
  it("renames, adds, removes and moves without touching the tree it was given", () => {
    const before = tree();
    const snapshot = JSON.stringify(before);
    const renamed = R.rename(before, 2, "Agentic AI");
    expect(R.locate(renamed, 2).node).toMatchObject({ name: "Agentic AI", edited: true });
    const added = R.add(renamed, 1, "Evals");
    expect(added.id).toBe(4);
    expect(names(added.tree)).toEqual([["AI", ["Agentic AI", "Evals"]], "Cooking"]);
    expect(R.locate(added.tree, 4).node).toMatchObject({ edited: true, sourceId: null, change: { added: true } });
    const moved = R.move(added.tree, 3, { parentId: 1, index: 0 });
    expect(names(moved)).toEqual([["AI", ["Cooking", "Agentic AI", "Evals"]]]);
    expect(names(R.remove(moved, 1))).toEqual([]);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("checks names the way the server does: present, short, unique among siblings", () => {
    expect(R.nameProblem(tree(), null, "  ")).toEqual({ ok: false, error: "A category needs a name." });
    expect(R.nameProblem(tree(), null, "ai")).toEqual({ ok: false, error: "There is already a “AI” here." });
    expect(R.nameProblem(tree(), null, "ai", 1)).toEqual({ ok: true, name: "ai" });
    expect(R.nameProblem(tree(), 1, "  Tool   Use ")).toEqual({ ok: true, name: "Tool Use" });
    expect(R.nameProblem(tree(), null, "x".repeat(121)).ok).toBe(false);
  });

  it("locks existing categories in 'only add' and nothing in a new tree", () => {
    const locked = { ...tree()[0], locked: true };
    expect(R.isEditable(locked, "extend")).toBe(false);
    expect(R.isEditable(locked, "redesign")).toBe(true);
    expect(R.isEditable(tree()[1], "extend")).toBe(true);
  });

  it("sends only what the server reads", () => {
    const payload = R.toPayload(R.rename(tree(), 3, "Food"));
    expect(payload).toEqual([
      { id: 1, name: "AI", sourceId: 10, children: [{ id: 2, name: "Agents", sourceId: 11, children: [] }] },
      { id: 3, name: "Food", edited: true, children: [] },
    ]);
  });

  it("indexes nodes with their path and parent", () => {
    const index = R.indexTree(tree());
    expect(index.get(2)).toMatchObject({ path: ["AI", "Agents"], parentId: 1 });
    expect(R.subtreeSize(tree()[0])).toBe(2);
  });

  it("labels a row's changes, and never claims renames or moves in 'only add'", () => {
    const node = { change: { added: true, renamedFrom: "Old", movedFrom: ["A", "B"] } };
    expect(R.changeBadges(node, "redesign").map((b: { label: string }) => b.label)).toEqual(["New", "Renamed", "Moved"]);
    expect(R.changeBadges(node, "redesign")[2].title).toBe("Was in A › B");
    expect(R.changeBadges(node, "extend").map((b: { label: string }) => b.label)).toEqual(["New"]);
  });
});

describe("costs and wording", () => {
  const cost = (filing: unknown, taxonomy: unknown = subscription) => ({
    taxonomy: { available: true, spend: taxonomy },
    filing: { available: true, spend: filing },
  });

  it("states each phase's billing, never calling a per-token pass free", () => {
    expect(R.proposalCostLine(cost(subscription))).toBe(
      "Phase 1 (designing the proposal): Claude Opus 5.5 via claude-cli - runs on your subscription, no per-call charge.",
    );
    expect(R.refileCostLine(cost(jev), 92)).toBe(
      "Phase 2 (re-filing all 92 posts once you accept): Jev (jev-latest) via typesafe - billed per token for each post.",
    );
    expect(R.refileCostLine(cost(priced), 1)).toContain("$3 in / $15 out per 1M tokens");
    expect(R.proposalCostLine({ taxonomy: { available: false, reason: "No CLI." } })).toBe("No CLI.");
  });

  it("confirms an accept with the price first when phase 2 is paid", () => {
    const paid = R.acceptConfirm(cost(jev), 92, "redesign", false);
    expect(paid).toMatchObject({ paid: true, label: "Accept and re-file, paid" });
    expect(paid.lead).toBe("Re-filing 92 posts is billed per token to your own account, for each post.");
    expect(paid.scope).toMatch(/replaced by the one you reviewed/);
    const free = R.acceptConfirm(cost(subscription), 5, "extend", false);
    expect(free).toMatchObject({ paid: false, label: "Accept and re-file" });
    expect(free.scope).toMatch(/nothing you have is renamed, moved or removed/);
    expect(R.acceptConfirm(cost(subscription), 3, "redesign", true).label).toBe("Re-file the rest");
    expect(R.refileDetail(cost(jev), 2)).toBe("Jev (jev-latest) via typesafe - billed per token for each of the 2 posts.");
  });

  it("summarizes the diff in words for both options", () => {
    const diff = { added: 1, removed: 2, renamed: 0, moved: 3, removedPaths: [] };
    expect(R.diffItems(diff, "redesign").map((i: { key: string }) => i.key)).toEqual(["added", "removed", "renamed", "moved"]);
    expect(R.diffItems(diff, "extend")).toEqual([{ key: "added", count: 1, label: "category added" }]);
    expect(R.diffSentence(diff, "redesign")).toBe("1 category added, 2 removed, 0 renamed, 3 moved.");
    expect(R.diffSentence({ added: 0 }, "extend")).toBe("Nothing to add: your tree already covers your posts.");
  });

  it("writes the shared strip's line for each step", () => {
    expect(R.progressLine({ state: "running", step: "proposal", messages: ["Designing..."] })).toBe("Preparing a proposal… Designing...");
    expect(R.progressLine({ state: "running", step: "accept", messages: [] })).toBe("Recategorizing…");
    expect(R.progressLine({ state: "done", summary: { kind: "proposal" } })).toBe("Your proposal is ready to review.");
    expect(R.progressLine({ state: "done", summary: { kind: "apply", mode: "extend", total: 4 } })).toBe(
      "Recategorized: 4 posts filed into your tree.",
    );
    expect(R.progressLine({ state: "error", error: "Re-filed 2 of 4 posts…" })).toBe("Re-filed 2 of 4 posts…");
  });

  it("gives the two options their own words", () => {
    expect(R.optionCopy("redesign").title).toBe("Propose a new tree");
    expect(R.optionCopy("extend").title).toBe("Keep the tree, only add");
  });
});
