"""Keyword utilities for the scoring engine.

Ported from the client-side keyword extractor and adapted to server-side scoring:

* ``extract_keywords`` — stop-word-filtered keyword extraction. It backs the
  fallback classification in :func:`gap_severity` (the rules engine already does
  synonym-aware matching for the actual scoring).
* ``STOP_WORDS`` — a fuller stop list than the small one scorer.py used to carry,
  so title words that indicate a relevant role are picked more accurately.
* ``gap_severity`` — ranks a missing requirement as *critical*, *moderate* or
  *minor* so the gap list (and the ranking view) can prioritise what matters.

The original only looked for generic technology keywords; the pattern sets here
cover this project's domain (public-health programmes, monitoring & evaluation,
finance/HR and the IT department) alongside the generic ones.
"""
from __future__ import annotations

import re

# Generic English stop words plus role-title filler that never identifies a
# specific vacancy ("senior", "officer", "state", …).
STOP_WORDS: frozenset[str] = frozenset({
    "the", "a", "an", "of", "and", "in", "for", "on", "at", "by", "to", "with",
    "is", "are", "was", "were", "be", "been", "being", "have", "has", "had",
    "will", "would", "should", "could", "can", "may", "might", "must", "shall",
    "from", "as", "that", "this", "these", "those", "then", "than", "so", "such",
    "too", "very", "just", "also", "only", "about", "above", "below", "under",
    "over", "between", "through", "during", "before", "after", "since", "until",
    "into", "onto", "upon", "off", "out", "up", "down", "any", "all", "each",
    "every", "both", "other", "some", "more", "most", "least", "less", "few",
    "its", "his", "her", "their", "our", "your", "who", "whom", "whose", "what",
    "which", "when", "where", "why", "how", "not", "no", "nor", "but", "or",
    "if", "else", "while", "whereas", "without", "within",
    # role-title filler
    "senior", "junior", "officer", "administrator", "assistant", "manager",
    "lead", "head", "associate", "specialist", "technical", "state",
})

_NONWORD = re.compile(r"[^a-z0-9& ]+")


def extract_keywords(text: str, limit: int = 50) -> list[str]:
    """Lower-case, stop-word-filtered words, without duplicates.

    Unlike the original, words containing digits are kept ("dhis2", "o365")
    because they are meaningful skills here.
    """
    if not text or not text.strip():
        return []
    cleaned = _NONWORD.sub(" ", text.lower())
    seen: set[str] = set()
    out: list[str] = []
    for word in cleaned.split():
        if len(word) > 3 and word not in STOP_WORDS and word not in seen:
            seen.add(word)
            out.append(word)
            if len(out) >= limit:
                break
    return out


# Requirement categories → default gap severity. Categories come from the scorer,
# which is more reliable than guessing from free text.
SEVERITY_BY_CATEGORY: dict[str, str] = {
    "mandatory": "critical",
    "technical": "critical",
    "qualification": "critical",
    "certification": "moderate",
    "soft": "minor",
    "preferred": "minor",
    "industry": "minor",
    "niceToHave": "minor",
}

# Fallback signals for uncategorised gap text, ported from the original's
# critical/moderate pattern lists and extended to this domain.
CRITICAL_PATTERNS: tuple[re.Pattern, ...] = tuple(re.compile(p, re.I) for p in (
    # core data / M&E
    r"\b(monitoring|evaluation|dhis2|data\s?quality|data\s?analysis|statistics?|m&e)\b",
    # core IT / infrastructure
    r"\b(sql|python|azure|aws|cloud|docker|kubernetes|networking|active\s?directory|cyber\s?security|windows\s?server)\b",
    # programme / clinical core
    r"\b(hiv|tb|tuberculosis|malaria|supply\s?chain|pharmac|clinical)\b",
    # leadership / governance
    r"\b(leadership|strategy|budget|compliance|audit|governance)\b",
    # hard exclusions the scorer itself flags
    r"\b(mandatory|below\s|no\srecognisable|not\sevidenced)\b",
    # software engineering & cloud (from the legacy keyword extractor)
    r"\b(javascript|typescript|java|golang|rust|ruby|swift|kotlin|php|scala)\b",
    r"\b(terraform|devops|jenkins|machine\s?learning|artificial\s?intelligence|data\s?science|deep\s?learning|tensorflow|pytorch)\b",
    r"\b(cryptography|penetration\s?testing|gdpr|iso\s?27001|database\s?design|data\s?model(?:l)?ing|data\s?warehouse|etl)\b",
))

MODERATE_PATTERNS: tuple[re.Pattern, ...] = tuple(re.compile(p, re.I) for p in (
    r"\b(excel|spss|stata|kobotoolbox|power\s?bi|tableau|report\s?writing)\b",
    r"\b(procurement|payroll|sage|quickbooks|ifrs|finance)\b",
    r"\b(stakeholder|project\s?management|proposal|grant)\b",
    r"\b(certification|estimated|field\s?of\s?study)\b",
    # frameworks, databases & delivery (from the legacy keyword extractor)
    r"\b(react|angular|vue|next\.?js|node\.?js|express|django|flask|spring\s?boot)\b",
    r"\b(mongodb|redis|elasticsearch|rabbitmq|kafka|graphql|rest\s?api|microservices)\b",
    r"\b(agile|scrum|kanban|jira|confluence|unit\s?test|integration\s?test)\b",
    r"\b(presentation|negotiation|mentoring|coaching|training)\b",
    r"\b(figma|sketch|ui\s?/?\s?ux|user\s?experience|accessibility)\b",
))


def gap_severity(category: str | None, text: str = "") -> str:
    """Severity of a missing requirement: 'critical', 'moderate' or 'minor'."""
    if category and category in SEVERITY_BY_CATEGORY:
        return SEVERITY_BY_CATEGORY[category]
    keywords = extract_keywords(text)
    blob = " ".join(keywords)
    if any(p.search(blob) for p in CRITICAL_PATTERNS):
        return "critical"
    if any(p.search(blob) for p in MODERATE_PATTERNS):
        return "moderate"
    return "minor"
