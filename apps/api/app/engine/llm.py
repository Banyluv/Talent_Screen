"""LLM verification step (Azure OpenAI or OpenAI).

The provider SDK is imported lazily so the rules engine stays import-cheap and
dependency-free.
"""
from __future__ import annotations

import json
import math
import re
from datetime import datetime

from .. import config
from .rag import retrieve

Provider = str

SYSTEM = """You are an evidence checker in a recruitment decision-support system for a Nigerian health and education NGO.
You verify whether CV passages show evidence for specific job requirements. You never make hiring decisions.
Rules:
- Use ONLY the passages provided. Do not assume, infer from job titles alone, or use outside knowledge.
- For every requirement return met=true only if a passage states it, and copy the supporting sentence VERBATIM (max 200 characters) into "evidence".
- Equivalent wording counts (e.g. "Entra ID" for "Azure AD", "led a team of 6" for "leadership").
- If unsure, met=false.
- Ignore names, gender, age, religion, ethnicity, marital status and state of origin. They are irrelevant.
Respond with JSON only."""

NARRATIVE_SYSTEM = (
    "Write a concise (max 4 sentence) assessment that compares the candidate's CV against the vacancy's "
    "requirements, using ONLY the JSON facts given. Name the vacancy, the key requirements met, the main gaps, "
    "and end with the suitability ranking. No new facts, no superlatives, no hiring decision. Plain British English."
)

# The TypeScript escape set: s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
_RE_ESC = re.compile(r"[.*+?^${}()|\[\]\\]")


def _re_esc(s: str) -> str:
    return _RE_ESC.sub(lambda m: "\\" + m.group(0), s)


def _dump(obj: object) -> str:
    """JSON.stringify equivalent (compact, non-ASCII left as-is)."""
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def _opt(opts: dict, key: str):
    """Accepts the TypeScript camelCase key, with a snake_case fallback for Python callers."""
    if key in opts:
        return opts[key]
    snake = re.sub(r"(?<!^)(?=[A-Z])", "_", key).lower()
    return opts.get(snake)


def provider_ready(p: Provider) -> dict:
    if p == "rules":
        return {"ok": True}
    if p == "azure-openai":
        ready = bool(config.azure_openai_endpoint and config.azure_openai_api_key and config.azure_openai_deployment)
        return {"ok": True} if ready else {"ok": False, "reason": "Set AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY and AZURE_OPENAI_DEPLOYMENT"}
    return {"ok": True} if config.openai_api_key else {"ok": False, "reason": "Set OPENAI_API_KEY"}


def _client(p: Provider):
    import openai

    if p == "azure-openai":
        c = openai.AsyncAzureOpenAI(
            azure_endpoint=config.azure_openai_endpoint,
            api_key=config.azure_openai_api_key,
            api_version=config.azure_openai_api_version,
            timeout=config.ai_timeout_ms / 1000,
        )
        return c, config.azure_openai_deployment
    kwargs: dict = {"api_key": config.openai_api_key, "timeout": config.ai_timeout_ms / 1000}
    if config.openai_base_url:
        kwargs["base_url"] = config.openai_base_url
    return openai.AsyncOpenAI(**kwargs), config.openai_model


def redact(text: str, name: str) -> str:
    """Redact contact details and the candidate's name before text leaves the system."""
    t = text
    t = re.sub(r"[A-Za-z0-9_.+-]+@[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+", "[EMAIL]", t)
    t = re.sub(r"(\+?[0-9]{1,3}[\s-]?)?\(?[0-9]{3,4}\)?[\s-]?[0-9]{3}[\s-]?[0-9]{3,4}", "[PHONE]", t)
    t = re.sub(r"linkedin\.com/[^\s]+", "[URL]", t, flags=re.I)
    for part in [p for p in re.split(r"\s+", name) if len(p) > 2]:
        t = re.sub(r"\b" + _re_esc(part) + r"\b", "[CANDIDATE]", t, flags=re.I)
    return t


def _norm(s: str) -> str:
    s = re.sub(r"\[candidate\]|\[email\]|\[phone\]|\[url\]", "", s.lower())
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def _js_num(v: float) -> float:
    """JavaScript has a single number type: an integral result prints without a decimal point."""
    return int(v) if isinstance(v, float) and v.is_integer() else v


def _truthy(v) -> bool:
    """JavaScript truthiness."""
    if v is None or v is False:
        return False
    if isinstance(v, (int, float)):
        return v == v and v != 0
    if isinstance(v, str):
        return len(v) > 0
    return True


async def run_llm(opts: dict) -> dict:
    """Asks the model to verify only the requirements the rules engine could NOT
    evidence, plus role dates if none were parsed. Every claimed evidence string
    must appear in the CV text; claims that don't are discarded and recorded.
    """
    c, model = _client(opts["provider"])
    candidate_name = _opt(opts, "candidateName") or ""
    chunks: list[dict] = _opt(opts, "chunks") or []
    need_roles = _opt(opts, "needRoles")

    def red(s: str) -> str:
        return redact(s, candidate_name) if _opt(opts, "redactPii") else s

    used: dict[str, dict] = {}
    reqs: list[dict] = []
    for i, r in enumerate(_opt(opts, "unresolved") or []):
        hits = retrieve(chunks, r["requirement"], 3)
        for h in hits:
            used[h["id"]] = h
        reqs.append({"id": f"R{i + 1}", "category": r["category"], "requirement": r["requirement"], "passages": [h["id"] for h in hits]})
    if need_roles:
        for ch in chunks:
            if ch["section"] == "experience" or ch["section"] == "header":
                used[ch["id"]] = ch

    passages = "\n\n".join(f"[{p['id']}] ({p['section']})\n{red(p['text'])}" for p in used.values())
    user = {
        "job_title": _opt(opts, "jobTitle"),
        "requirements": [{"id": r["id"], "category": r["category"], "requirement": r["requirement"], "check_passages": r["passages"]} for r in reqs],
        "extract_roles": need_roles,
        "output_schema": {
            "requirements": [{"id": "R1", "met": "boolean", "evidence": "verbatim sentence or empty"}],
            "roles": [{"title": "string", "organisation": "string", "start": "YYYY-MM", "end": "YYYY-MM or present"}] if need_roles else [],
        },
    }

    res = await c.chat.completions.create(
        model=model,
        temperature=opts["temperature"],
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": "PASSAGES\n" + passages + "\n\nTASK\n" + _dump(user)},
        ],
    )
    parsed = json.loads((res.choices[0].message.content if res.choices else None) or "{}")

    cv_norm = _norm(_opt(opts, "cvText") or "")
    verdicts: dict[str, dict] = {}
    discarded: list[dict] = []
    model_reqs = parsed.get("requirements") or []
    if not isinstance(model_reqs, list):
        model_reqs = []
    for r in model_reqs:
        if not isinstance(r, dict):
            continue
        rid = r.get("id")
        definition = next((x for x in reqs if x["id"] == rid), None)
        if not definition:
            continue
        raw_ev = r.get("evidence")
        ev = ("" if raw_ev is None else str(raw_ev)).strip()
        # The quote must exist verbatim in a passage retrieved FOR THIS requirement, not just anywhere in the CV.
        own = " ".join(_norm(used.get(i, {}).get("text") or "") for i in definition["passages"])
        ev_norm = _norm(ev)
        grounded = len(ev) >= 8 and ev_norm in cv_norm and ev_norm in own
        if _truthy(r.get("met")) and not grounded:
            discarded.append({"requirement": definition["requirement"], "claimed": ev[:200]})
        verdict: dict = {"met": _truthy(r.get("met")) and grounded}
        if grounded:
            verdict["evidence"] = ev[:200]
        verdicts[f"{definition['category']}::{definition['requirement']}"] = verdict

    now = datetime.now()

    def ym(s, end: bool = False) -> float:
        if not s:
            return math.nan
        s = s if isinstance(s, str) else str(s)
        if re.search(r"present|current|now", s, re.I):
            return _js_num(now.year + (now.month - 1 + (1 if end else 0)) / 12)
        m = re.search(r"((?:19|20)[0-9]{2})(?:-([0-9]{1,2}))?", s)
        if not m:
            return math.nan
        month = (int(m.group(2)) - 1 if m.group(2) else (11 if end else 0)) + (1 if end else 0)
        return _js_num(int(m.group(1)) + month / 12)

    roles: list[dict] = []
    model_roles = parsed.get("roles") or []
    if not isinstance(model_roles, list):
        model_roles = []
    for r in model_roles:
        if not isinstance(r, dict):
            continue
        title = "" if r.get("title") is None else str(r["title"])
        organisation = "" if r.get("organisation") is None else str(r["organisation"])
        start = ym(r.get("start"))
        end = ym(r.get("end"), True)
        if not (
            math.isfinite(start)
            and math.isfinite(end)
            and end > start
            and " ".join(_norm(title).split(" ")[:2]) in cv_norm  # title must appear in the CV
        ):
            continue
        roles.append(
            {
                "title": title,
                "organisation": organisation,
                "start": start,
                "end": end,
                "current": bool(re.search(r"present|current|now", str(r.get("end")), re.I)),
                "text": f"{title} — {organisation}",
            }
        )

    return {"verdicts": verdicts, "roles": roles, "discarded": discarded, "model": model}


async def run_narrative(provider: Provider, temperature: float, facts: dict) -> str:
    """A short narrative summary written strictly from the computed facts."""
    c, model = _client(provider)
    res = await c.chat.completions.create(
        model=model,
        temperature=temperature,
        messages=[
            {"role": "system", "content": NARRATIVE_SYSTEM},
            {"role": "user", "content": _dump(facts)},
        ],
    )
    content = res.choices[0].message.content if res.choices else None
    return (content or "").strip()[:1200]
