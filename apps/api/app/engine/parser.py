"""Deterministic CV parser. Produces a structured profile from plain CV text.

It is intentionally conservative: anything it cannot read with confidence is
left out rather than guessed. When an LLM provider is configured, the
evaluation service uses the model to fill gaps (e.g. role dates written in
unusual formats) — but every model claim is checked against this text.
"""
from __future__ import annotations

import math
import re
from datetime import datetime

MON: dict[str, int] = {"jan": 0, "feb": 1, "mar": 2, "apr": 3, "may": 4, "jun": 5, "jul": 6, "aug": 7, "sep": 8, "oct": 9, "nov": 10, "dec": 11}
_M = r"(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?"
# "Jan 2019 – Present", "01/2019 - 12/2021", "2016 to 2019", "March 2019 to date"
RANGE = re.compile(
    r"(?:\b" + _M + r"\s+|\b([0-9]{1,2})[/.-])?((?:19|20)[0-9]{2})\s*(?:-|–|—|to|until)\s*(?:\b" + _M + r"\s+|\b([0-9]{1,2})[/.-])?((?:19|20)[0-9]{2}|present|current|date|now|ongoing)",
    re.I,
)

DEGREES: list[tuple[float, re.Pattern[str]]] = [
    (5, re.compile(r"\b(ph\.?\s?d|doctorate|dphil|d\.phil)\b", re.I)),
    (4, re.compile(r"\b(m\.?\s?sc|m\.?\s?a\b|mba|mph|m\.?\s?eng|m\.?\s?tech|master'?s?|llm)\b", re.I)),
    (3.5, re.compile(r"\b(pgd|pgde|post\s?graduate diploma)\b", re.I)),
    (3, re.compile(r"\b(b\.?\s?sc|b\.?\s?eng|b\.?\s?tech|b\.?\s?a\b|b\.?\s?ed|llb|mbbs|bachelor'?s?|hnd|higher national diploma)\b", re.I)),
    (2, re.compile(r"\b(ond|national diploma|\bnd\b|diploma)\b", re.I)),
    (1, re.compile(r"\b(ssce|waec|neco|o'?\s?level|secondary school)\b", re.I)),
]

HEADINGS: list[tuple[str, re.Pattern[str]]] = [
    ("experience", re.compile(r"^(professional |work |employment |career |relevant )?(experience|employment history|work history|career history|employment)\b", re.I)),
    ("education", re.compile(r"^(education|academic (background|qualifications)|qualifications|education (and|&) training)\b", re.I)),
    ("certifications", re.compile(r"^(certifications?|professional certifications?|licen[cs]es|certificates)\b", re.I)),
    ("skills", re.compile(r"^(skills|technical skills|core (skills|competenc[A-Za-z0-9_]*)|key skills|competenc[A-Za-z0-9_]*|technical competenc[A-Za-z0-9_]*)\b", re.I)),
    ("summary", re.compile(r"^(profile|summary|professional summary|career objective|objective|about me|personal statement)\b", re.I)),
    ("projects", re.compile(r"^(projects|key projects|selected projects)\b", re.I)),
    ("awards", re.compile(r"^(awards|honou?rs|achievements)\b", re.I)),
    ("publications", re.compile(r"^(publications|research)\b", re.I)),
    ("memberships", re.compile(r"^(professional )?(memberships|affiliations|associations)\b", re.I)),
    ("languages", re.compile(r"^languages\b", re.I)),
    ("referees", re.compile(r"^(referees|references)\b", re.I)),
    ("personal", re.compile(r"^(personal (details|information|data))\b", re.I)),
]


def _js_number(v: float) -> float:
    """JavaScript has a single number type: an integral result prints without a decimal point."""
    return int(v) if isinstance(v, float) and v.is_integer() else v


def _round1(n: float) -> float:
    """JavaScript's Math.round(n * 10) / 10 (half-up, unlike Python's banker's rounding)."""
    return _js_number(math.floor(n * 10 + 0.5) / 10)


def seniority(title: str) -> int:
    t = title.lower()
    if re.search(r"\b(head|director|chief|vp|vice president)\b", t):
        return 5
    if re.search(r"\b(manager|lead|principal|coordinator)\b", t):
        return 4
    if re.search(r"\b(senior|sr\.?)\b", t):
        return 3
    if re.search(r"\b(intern|trainee|industrial|nysc|volunteer)\b", t):
        return 0
    if re.search(r"\b(assistant|associate|support|technician|help ?desk|clerk)\b", t):
        return 1
    return 2


def merged_years(ranges: list[dict]) -> float:
    iv = sorted(((r["start"], r["end"]) for r in ranges if r["end"] > r["start"]), key=lambda x: x[0])
    total = 0.0
    cs: float | None = None
    ce = 0.0
    for a, b in iv:
        if cs is None:
            cs, ce = a, b
        elif a <= ce:
            ce = max(ce, b)
        else:
            total += ce - cs
            cs, ce = a, b
    if cs is not None:
        total += ce - cs
    return _round1(total)


def _month(token: str) -> float:
    v = MON.get(token.lower()[:3])
    return math.nan if v is None else float(v)


def _parse_range(line: str, now: datetime) -> dict | None:
    m = RANGE.search(line)
    if not m:
        return None
    sy = int(m.group(3))
    if m.group(1) is not None:
        sm = _month(m.group(1))
    elif m.group(2) is not None:
        sm = max(0, min(11, int(m.group(2)) - 1))
    else:
        sm = 0
    end_tok = m.group(6).lower()
    if re.search(r"present|current|date|now|ongoing", end_tok):
        ey = now.year
        em = now.month - 1
        current = True
    else:
        ey = int(m.group(6))
        if m.group(4) is not None:
            em = _month(m.group(4))
        elif m.group(5) is not None:
            em = max(0, min(11, int(m.group(5)) - 1))
        else:
            em = 11
        current = False
    return {"start": _js_number(sy + sm / 12), "end": _js_number(ey + (em + 1) / 12), "current": current, "match": m.group(0)}


def _split_title_org(s: str) -> dict:
    parts = [x.strip() for x in re.split(r"\s+(?:—|–|-|\||@|,| at )\s+", s)]
    parts = [x for x in parts if x]
    return {"title": parts[0] if parts else s, "organisation": ", ".join(parts[1:])}


def _clean_line(l: str) -> str:
    return re.sub(r"^[•\-*·▪●]\s*", "", l).strip()


# Job titles and employers often sit on separate lines (the date may be on a line
# of its own or appended to the employer), so these help tell the two apart.
TITLE_WORDS = re.compile(
    r"\b(engineer|developer|programmer|architect|designer|manager|supervisor|director|head|"
    r"chief|president|officer|analyst|specialist|coordinator|consultant|assistant|associate|"
    r"intern|trainee|clerk|technician|advisor|adviser|scientist|statistician|epidemiologist|"
    r"accountant|auditor|recruiter|secretary|executive|representative|teacher|trainer|"
    r"nurse|doctor|pharmacist|attendant|administrator|lead|devops|tester|qa|ict|"
    r"data entry|m&e|monitoring|evaluation|support|technologist|volunteer)\b",
    re.I,
)

ORG_WORDS = re.compile(
    r"\b(ltd|limited|plc|inc|llc|corp|corporation|company|group|holdings|foundation|trust|"
    r"ngo|project|programme|program|scheme|agency|commission|council|ministry|department|"
    r"bureau|institute|university|college|hospital|clinic|centre|center|bank|insurance|"
    r"school|academy|association|society|network|partners|office|branch|division|unit|"
    r"cluster|state|nigeria)\b",
    re.I,
)

# Words that rule a line out as a person's name (section headings, salutations
# and employer names).
NAME_BLOCK = re.compile(
    r"\b(hiring|manager|dear|sir|madam|recruiter|application|curriculum|resume|vitae|profile|"
    r"summary|contact|address|email|phone|ltd|limited|plc|inc|llc|company|group|project|"
    r"programme|program|scheme|agency|commission|council|ministry|department|university|"
    r"college|hospital|clinic|centre|center|institute|bank|school|academy|association|"
    r"society|network|office|services|solutions|technologies|consulting|nigeria|state|road|"
    r"street|avenue)\b",
    re.I,
)


def _looks_like_name(line: str) -> bool:
    s = line.strip().rstrip(",")
    if not (2 <= len(s) <= 60) or re.search(r"[0-9@|/]", s):
        return False
    if any(rx.search(s) for _, rx in HEADINGS) or NAME_BLOCK.search(s):
        return False
    words = re.findall(r"[A-Za-z][A-Za-z.'-]*", s)
    if not (2 <= len(words) <= 5):
        return False
    return all(w[0].isupper() for w in words)


def _find_name(lines: list[str]) -> str:
    # The name is usually in the first few lines of the CV.
    for l in lines[:6]:
        if _looks_like_name(l):
            return l
    # A cover letter may come first: the name then repeats at the top of the CV,
    # or sits immediately above the contact line.
    seen: dict[str, int] = {}
    for l in lines[:60]:
        if _looks_like_name(l):
            key = re.sub(r"\s+", " ", l.strip().rstrip(",")).lower()
            seen[key] = seen.get(key, 0) + 1
    for l in lines[:60]:
        if _looks_like_name(l) and seen[re.sub(r"\s+", " ", l.strip().rstrip(",")).lower()] >= 2:
            return l
    for i, l in enumerate(lines[:60]):
        if "@" in l or re.search(r"\+?[0-9][0-9\s-]{7,}", l):
            for back in range(i - 1, max(-1, i - 4), -1):
                if _looks_like_name(lines[back]):
                    return lines[back]
    return "Unnamed candidate"


def _strip_range(line: str, match: str) -> str:
    """The text on a date line, with the date range removed."""
    s = line.replace(match, "", 1)
    s = re.sub(r"[|,–—(\-\s]+$", "", s)
    s = re.sub(r"^[|,–—)\-\s]+", "", s)
    return s.strip()


def _looks_like_header(line: str) -> bool:
    """A job-title / employer / location line that may precede a date line."""
    s = line.strip()
    if not (2 <= len(s) <= 80):
        return False
    if re.search(r"[.!?;]$", s) or s[0].islower():
        return False
    if re.match(r"^(roles?|responsibilities|duties|key responsibilities|achievements)\s*:?$", s, re.I):
        return False
    if any(rx.search(s) for _, rx in HEADINGS):
        return False
    return len(s) <= 55 or bool(TITLE_WORDS.search(s) or ORG_WORDS.search(s))


def _role_header(above: list[str], inline: str) -> dict:
    """Pick the job title out of the lines that make up a role header."""
    block = [*above, *([inline] if inline else [])]
    if not block:
        return {"title": "", "organisation": ""}

    def rank(i: int, s: str) -> int:
        title, org = bool(TITLE_WORDS.search(s)), bool(ORG_WORDS.search(s))
        v = 4 if title and not org else 2 if title else -4 if org else 0
        v += 1 if len(s) <= 60 else 0
        v += 1 if i == 0 or i == len(block) - 1 else 0
        return v

    idx = max(range(len(block)), key=lambda i: (rank(i, block[i]), -i))
    chosen = _split_title_org(block[idx])
    others = [s for j, s in enumerate(block) if j != idx]
    org = ", ".join(x for x in [chosen["organisation"], *others] if x)
    return {"title": chosen["title"].rstrip(":").strip(), "organisation": org}


def parse_cv(raw: str, now: datetime | None = None) -> dict:
    if now is None:
        now = datetime.now()
    text = raw.replace("\r", "")
    lines = [l for l in (_clean_line(x) for x in text.split("\n")) if l]
    email_match = re.search(r"[A-Za-z0-9_.+-]+@[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+", text)
    email = email_match.group(0) if email_match else ""
    head = "\n".join(lines[:60])
    phone_match = re.search(r"(\+?[0-9]{1,3}[\s-]?)?\(?[0-9]{3,4}\)?[\s-]?[0-9]{3}[\s-]?[0-9]{3,4}", head)
    phone = phone_match.group(0).strip() if phone_match else ""
    name = _find_name(lines)
    loc_line = next(
        (
            l
            for l in lines[:60]
            if "|" in l or re.search(r"\bnigeria\b|\blagos\b|\babuja\b|\bcalabar\b", l, re.I)
        ),
        "",
    )
    location = loc_line.split("|")[0].strip()

    sections: dict[str, list[str]] = {"header": []}
    cur = "header"
    for l in lines:
        h = next(((k, rx) for k, rx in HEADINGS if rx.search(re.sub(r"[:\s]+$", "", l))), None) if len(l) < 50 else None
        # "HEALTH TECHNOLOGY & SOFTWARE DEVELOPMENT EXPERIENCE" and similar
        # headings end with EXPERIENCE without starting with it.
        if not h and len(l) < 60 and re.search(r"\bexperience$", l, re.I) and not re.search(r"\d", l):
            h = ("experience", None)
        if h:
            cur = h[0]
            sections.setdefault(cur, [])
            continue
        sections[cur].append(l)

    # Employment history. A role header may be above the date line (or the date
    # may be appended to the employer), so gather the short header lines that sit
    # directly above a date instead of assuming the previous line is the title.
    exp_lines = sections["experience"] if sections.get("experience") else [
        l for l in lines if not any(rx.search(l) for _, rx in DEGREES)
    ]
    entries: list[dict] = []
    for i, l in enumerate(exp_lines):
        r = _parse_range(l, now)
        if not r:
            continue
        j = i - 1
        above: list[str] = []
        while j >= 0 and len(above) < 3 and _looks_like_header(exp_lines[j]):
            above.insert(0, exp_lines[j])
            j -= 1
        start = max(j + 1, entries[-1]["index"] + 1 if entries else 0)
        entries.append({
            "index": i,
            "start": start,
            "range": r,
            "header": _role_header(above, _strip_range(l, r["match"])),
        })

    roles: list[dict] = []
    for n, e in enumerate(entries):
        end = entries[n + 1]["start"] if n + 1 < len(entries) else len(exp_lines)
        text_block = "\n".join(exp_lines[e["start"]:end]).strip() or exp_lines[e["index"]]
        roles.append({
            "title": e["header"]["title"],
            "organisation": e["header"]["organisation"],
            "start": e["range"]["start"],
            "end": e["range"]["end"],
            "current": e["range"]["current"],
            "text": text_block,
        })

    total_years = merged_years(roles)
    if not roles:
        m = re.search(r"([0-9]{1,2})\+?\s*(?:years|yrs)(?:'|’)?\s*(?:of\s+)?(?:professional\s+|work\s+)?experience", text, re.I)
        if m:
            total_years = int(m.group(1))

    # Education
    edu_lines = sections["education"] if sections.get("education") else lines
    education: list[dict] = []
    for l in edu_lines:
        d = next(((lvl, rx) for lvl, rx in DEGREES if rx.search(l)), None)
        if d:
            year_match = re.search(r"(19|20)[0-9]{2}", l)
            year = (int(year_match.group(0)) if year_match else 0) or None
            item: dict = {"line": l, "level": d[0]}
            if year is not None:
                item["year"] = year
            education.append(item)
    highest_level: float = 0
    for e in education:
        highest_level = max(highest_level, e["level"])

    def list_of(k: str) -> list[str]:
        flat: list[str] = []
        for l in sections.get(k) or []:
            flat.extend(re.split(r"[,;|]", l) if k == "skills" else [l])
        out: list[str] = []
        for s in flat:
            s = re.sub(r"^[^:]{0,25}:\s*", (lambda m: "" if k == "skills" else m.group(0)), s).strip()
            if len(s) > 1:
                out.append(s)
        return out

    summary_sec = sections.get("summary")
    summary_text = " ".join(summary_sec if summary_sec is not None else [])[:600]
    if not summary_text:
        summary_text = next((l for l in lines if len(l) > 90), "")[:400]

    return {
        "name": name,
        "email": email,
        "phone": phone,
        "location": location,
        "summary": summary_text,
        "roles": sorted(roles, key=lambda r: r["start"]),
        "education": education,
        "highestLevel": highest_level,
        "certifications": list_of("certifications"),
        "skills": list_of("skills"),
        "languages": list_of("languages"),
        "memberships": list_of("memberships"),
        "awards": list_of("awards"),
        "publications": list_of("publications"),
        "projects": list_of("projects"),
        "totalYears": total_years,
        "sections": sections,
        "lines": lines,
        "lower": text.lower(),
    }


def public_profile(p: dict) -> dict:
    """Non-contact profile persisted on the candidate row (no email/phone)."""
    return {
        "summary": p["summary"],
        "location": p["location"],
        "totalYears": p["totalYears"],
        "highestLevel": p["highestLevel"],
        "roles": [{k: v for k, v in r.items() if k != "text"} for r in p["roles"]],
        "education": p["education"],
        "certifications": p["certifications"],
        "skills": p["skills"],
        "languages": p["languages"],
        "memberships": p["memberships"],
        "awards": p["awards"],
        "publications": p["publications"],
        "projects": p["projects"],
    }
