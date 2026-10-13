"""Retrieval for the LLM step. The CV is split into section-aware chunks; for
each requirement we retrieve the top-k chunks by BM25 over the requirement's
expanded vocabulary. Only retrieved chunks are sent to the model, which keeps
prompts small and forces answers to be grounded in specific passages.
"""
from __future__ import annotations

import math
import re

from .aliases import aliases_of


def chunk_cv(cv: dict, max_chars: int = 700) -> list[dict]:
    out: list[dict] = []
    n = 0
    for section, lines in cv["sections"].items():
        buf = ""
        for l in lines:
            if buf and len(buf) + len(l) > max_chars:
                n += 1
                out.append({"id": f"C{n}", "section": section, "text": buf.strip()})
                buf = ""
            buf += l + "\n"
        if buf.strip():
            n += 1
            out.append({"id": f"C{n}", "section": section, "text": buf.strip()})
    return out


def _tok(s: str) -> list[str]:
    return [t for t in re.split(r"[^a-z0-9+#.]+", s.lower()) if len(t) > 1]


def retrieve(chunks: list[dict], requirement: str, k: int = 3) -> list[dict]:
    q = {t for a in aliases_of(requirement) for t in _tok(a)}
    docs = [_tok(c["text"]) for c in chunks]
    avg = sum(len(d) for d in docs) / (len(docs) or 1)
    df: dict[str, int] = {}
    for d in docs:
        for t in set(d):
            df[t] = df.get(t, 0) + 1
    k1 = 1.4
    b = 0.75
    N = len(docs)
    scored: list[tuple[dict, float]] = []
    for c, d in zip(chunks, docs):
        s = 0.0
        for t in q:
            f = len([x for x in d if x == t or x.startswith(t)])
            if not f:
                continue
            idf = math.log(1 + (N - df.get(t, 0) + 0.5) / (df.get(t, 0) + 0.5))
            s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * len(d)) / avg)))
        # experience and skills sections are where evidence normally lives
        if s > 0 and re.search(r"experience|skills|certifications", c["section"]):
            s *= 1.15
        scored.append((c, s))
    hits = [c for c, _ in sorted((x for x in scored if x[1] > 0), key=lambda x: -x[1])[:k]]
    # Nothing lexical? give the model the experience and skills sections to reason over.
    if hits:
        return hits
    return [c for c in chunks if re.search(r"experience|skills|summary", c["section"])][:k]
