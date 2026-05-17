---
title: Building a local RAG over my Notion notes
author: Mateusz Kiersnowski
pubDatetime: 2026-05-17T18:00:00Z
slug: personal-notion-rag
featured: true
draft: false
tags:
  - RAG
  - MCP
  - Notion
  - Claude
  - AI
description:
  A small weekend project — a local, private RAG over my Notion notes, exposed to Claude Code as an MCP server.
---

# Intro

I keep most of my personal notes in Notion. Project ideas, reading notes, snippets, half-finished thoughts.
The problem with growing notes is that finding the right one becomes harder than writing a new one. Notion's
built-in search is fine for exact words, but it doesn't help when I half-remember an idea and can't recall
the exact phrasing.

I had been wanting to play with RAG for a while, so this seemed like a good excuse. The idea was simple:
ask Claude things like *"what did I write about X?"* or *"summarise my notes on project Y"* and get answers
grounded in the actual content of my pages, not the model's guesses.

A few constraints I set for myself:

- **Everything local.** Notes shouldn't leave my machine during indexing. No third-party embedding API.
- **No custom UI.** Claude Code already gives me a great chat interface. Building another one made no sense.
- **MCP-first.** Expose the search as an MCP tool, let Claude Code do the talking.

# How it works

The pipeline is small and boring, which is exactly what I wanted.

```
Claude Code  ──stdio MCP──▶  notion-rag (Python)
                                  │
              ┌───────────────────┼───────────────────┐
              ▼                   ▼                   ▼
          Ollama              Qdrant              Notion API
       (nomic-embed)       (vector store)       (live pages)
```

Indexing (`scripts/ingest.py`) does this:

1. For each root page ID, fetch the page and all its blocks via the Notion API.
2. Recursively descend into `child_page` blocks — every subpage becomes its own document.
3. Skip `child_database` blocks (I deliberately don't index databases, only pages).
4. Convert blocks to markdown, chunk with `RecursiveCharacterTextSplitter` (1000 chars, 200 overlap).
5. Embed each chunk locally with `nomic-embed-text` through Ollama (768-dim).
6. Upsert into a Qdrant collection with metadata: `page_id`, `page_title`, `page_url`, `last_edited_time`.

The reindex is **idempotent**. Before inserting new chunks for a page, all old chunks for that `page_id`
are deleted. So I can re-run the script whenever I want without ending up with duplicates.

On the query side, the MCP server exposes two tools:

- `search_notion(query, k)` — embeds the query with the same model, runs `qdrant.query_points`, returns
  the top-k chunks as markdown with links back to Notion.
- `get_full_page(page_id)` — bypasses Qdrant and fetches the page fresh from the Notion API. Claude calls
  it when a chunk is too short to answer the question.

That's it. No reranking, no hybrid search, no auto-discovery, no cron job. Just enough to be useful.

# A few lessons

**Local embeddings are fine for personal use.** I was worried `nomic-embed-text` would be too weak,
but for my volume of notes the recall is good enough that I don't notice. If I needed better Polish
support I'd swap it for `bge-m3`, but I haven't felt the need yet.

**Idempotent reindex beats incremental.** I briefly considered tracking `last_edited_time` to only
reindex changed pages, but it's premature. A full reindex of all my notes takes under a minute and I
run it manually when I remember to. YAGNI until it isn't.

**Skipping databases was the right call.** My actual notes live in regular pages with subpages. Notion
databases in my workspace are mostly trackers and tables — structured data that doesn't make sense to
chunk and embed. Trying to index everything would have added complexity for no gain.

**MCP over a custom UI.** This is the part I'm happiest with. The whole "frontend" is one JSON entry
in `~/.claude.json` pointing at the Python module, and Claude Code handles the rest. No auth, no web
server, no React app I'd have to maintain. The boundary is small and the value is immediate.

**Claude knows when to drill down.** Watching Claude decide on its own to call `get_full_page` after
`search_notion` returned a short chunk was satisfying. The two-tool design fell out naturally — I
didn't have to engineer prompts for it.

# What I deliberately left out

This isn't a finished product, it's a tool I use. The things I considered and skipped:

- Incremental reindex by `last_edited_time`
- A reranker layer (`bge-reranker-v2-m3` would be the obvious pick)
- Hybrid search (BM25 + dense, Qdrant supports it)
- Metadata filters in the MCP tool (`search_recent`, `search_in_section`)
- Auto-discovery of pages instead of a hand-maintained list
- A cache for `get_full_page`
- Other sources — PDFs, markdown from disk, Git repos

All of these would be reasonable, none of them solve a problem I currently have.

# Is this better than Notion's official MCP?

Honestly, for most people, no. Notion has its own MCP connector that does semantic search over your
workspace, and it's a faster path to "ask Claude about my notes". I kept this project because:

- I have full control over the pipeline if I want to add reranking or hybrid search later.
- Queries don't leave the machine.
- I can extend it to non-Notion sources with the same code.
- I learned a lot building it.

The last point is probably the real reason. Reading about RAG is one thing, wiring up Ollama + Qdrant +
the Notion API + MCP yourself makes the trade-offs concrete in a way blog posts can't.

# Closing

The repo lives at `~/CodeWork/ai/personal-notion-rag` on my machine. It's about 400 lines of Python
across five files, and it does exactly one thing. That's the kind of project I enjoy most — small enough
to hold in my head, useful enough to keep using.

If I extend it next, it'll probably be to add markdown files from disk as a second source. But only when
I actually need it.
