"""Parse an ECEWS advert's "Minimum Recruitment Standard" into scoring criteria.

ECEWS vacancy adverts follow a fixed four-section shape::

    Job Title
    Level of Effort
    Job Description
    Minimum Recruitment Standard

The "Minimum Recruitment Standard" is a short list of bullets — typically a degree
line, an experience line ("At least N years …") and a handful of knowledge/skill
lines. This module turns that free text into the structured ``requirements`` dict
the scoring engine consumes, so a candidate's CV is matched against the actual
advert rather than against an empty requirement set.

The requirement strings emitted here are deliberately short and concrete (and,
where possible, keys the engine's synonym dictionary already understands) so the
evidence matcher in ``app.engine.aliases`` can find them in real CVs.
"""
from __future__ import annotations

import re
from typing import Any

# --------------------------------------------------------------- qualification

_WORD_NUMS: dict[str, int] = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
    "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13,
    "fourteen": 14, "fifteen": 15, "twenty": 20,
}

# Highest-first, word-bounded so abbreviations do not match inside other words.
_LEVEL_PATTERNS: list[tuple[re.Pattern[str], float]] = [
    (re.compile(r"\b(?:ph\.?d|doctorate|doctoral|md)\b"), 5),
    (re.compile(r"\bpost[- ]?graduate\s+diploma\b|\bpgd\b"), 3.5),
    (re.compile(r"\bmaster'?s?\b|\bm\.?sc\b|\bmba\b|\bm\.?eng\b|\bmasters\b"), 4),
    (
        re.compile(
            r"\bbachelor'?s?\b|\bb\.?sc\b|\bhnd\b|\bb\.?eng\b|\bb\.?tech\b"
            r"|\bfirst degree\b|\bdegree\b|\bb\.?a\b"
        ),
        3,
    ),
    (re.compile(r"\bdiploma\b|\bond\b|\bnational diploma\b|\bnd\b"), 2),
    (re.compile(r"\bsecondary\b|\bssce\b|\bwaec\b|\bo[- ]?level\b|\bhigh school\b|\bssc\b"), 1),
]


def _word_to_int(word: str) -> int | None:
    return _WORD_NUMS.get(word.strip().lower())


def _qualification_level(low: str) -> float | None:
    """Highest education level mentioned ('master' beats 'first degree', etc.)."""
    for pattern, level in _LEVEL_PATTERNS:
        if pattern.search(low):
            return level
    return None


def _min_years(low: str) -> int | None:
    """The minimum years of experience asked for.

    Captures "at least ten (10) years", "10 years", "a minimum of five (5) years"
    and takes the largest figure (the overall requirement, not the sub-clauses).
    """
    best: int | None = None
    for m in re.finditer(r"(\d+|[a-z]+)\s*(?:\((\d+)\))?\s*years?", low, re.I):
        word, digit = m.group(1), m.group(2)
        value: int | None
        if digit:
            value = int(digit)
        elif word.isdigit():
            value = int(word)
        else:
            value = _word_to_int(word)
        if value is not None and (best is None or value > best):
            best = value
    return best


# ------------------------------------------------------------------- fields

_DEGREE_FIELD_RE = re.compile(
    r"\b(?:degree|certificate|certification|hnd|ond|diploma)\b[^;.]{0,60}?\bin\s+"
    r"(.+?)(?:;|\bor\s+(?:a\s+)?related|\brelated\s+field|\brelated\b|\.\s*$|$)"
)


def _fields_of_study(low: str) -> list[str]:
    """Degree fields, e.g. "first degree in Medicine, Public Health, or a related field"."""
    # "MB.BS/MD/PHD …" names a medical/doctorate degree rather than a field list.
    if re.search(r"\bmb\.?bs\b|\bmd\b|\bphd\b", low):
        return ["medicine", "public health"]
    m = _DEGREE_FIELD_RE.search(low)
    if not m:
        return []
    segment = re.split(r"[;.]", m.group(1))[0]
    parts = re.split(r"\s*(?:,|\bor\b|\band\b)\s*", segment, flags=re.I)
    fields: list[str] = []
    for p in parts:
        p = p.strip().lower().strip(".")
        p = re.sub(r"^(a|an|the)\s+", "", p)
        p = re.sub(r"\s+(is required|required|or equivalent|degree)$", "", p)
        p = p.strip().rstrip("-/")
        if len(p) > 2 and "related" not in p and p not in fields:
            fields.append(p)
    return fields


# ------------------------------------------------------------- certifications

_CERT_PATTERNS: list[tuple[str, str]] = [
    (r"\bican\b", "ICAN"),
    (r"\bacca\b", "ACCA"),
    (r"\bcpa\b", "CPA"),
    (r"\bdriver'?s?\s+licen[cs]e\b|\bdriving\s+licen[cs]e\b", "Driver's license"),
]


def _certifications(low: str) -> list[str]:
    certs: list[str] = []
    for pattern, label in _CERT_PATTERNS:
        if re.search(pattern, low, re.I) and label not in certs:
            certs.append(label)
    if re.search(r"\bprofessional\s+accounting\s+qualification\b", low) and not any(
        c in ("ICAN", "ACCA", "CPA") for c in certs
    ):
        certs.append("Professional accounting qualification")
    return certs


# --------------------------------------------------------------- skill scans

def _scan(patterns: list[tuple[str, str]], low: str) -> list[str]:
    """Return canonical skills whose patterns match, in declared order, de-duplicated."""
    out: list[str] = []
    for pattern, canonical in patterns:
        if canonical not in out and re.search(pattern, low, re.I):
            out.append(canonical)
    return out


TECH_KEYWORDS: list[tuple[str, str]] = [
    # public-health / clinical domain
    (r"\bhiv\b", "HIV"),
    (r"\btb\b|\btuberculosis\b", "TB / Tuberculosis"),
    (r"\bmalaria\b", "Malaria"),
    (r"\bmnch\b|\bmaternal|\bnewborn", "MNCH / Maternal health"),
    (r"\bepidemiolog", "Epidemiology"),
    (r"\bpublic health\b", "Public health"),
    (r"\bsurveillance\b", "Surveillance"),
    (r"\bclinical\b", "Clinical services"),
    (r"\bpharmac", "Pharmacy"),
    (r"\blaborator", "Laboratory services"),
    (r"\bcommodit|\bsupply chain\b|\blogistics\b", "Supply chain / logistics"),
    (r"\bnursing\b|\bnurse\b", "Nursing"),
    (r"\bmidwifery\b", "Midwifery"),
    (r"\bcommunity health\b", "Community health"),
    (r"\bhealth informatics\b|\bemr\b|\belectronic medical record", "Health informatics / EMR"),
    # data / M&E
    (r"\bdata quality\b|\bdqa\b", "Data quality assessment"),
    (r"\bmonitoring and evaluation\b|\bm&e\b|\bmonitoring & evaluation\b", "Monitoring / Evaluation / M&E"),
    (r"\bstrategic information\b", "Strategic information"),
    (r"\bstatistic", "Statistics"),
    (r"\bdata analysis\b|\banalytics\b", "Data analysis"),
    (r"\bdhis2\b|\bdhis 2\b", "DHIS2"),
    (r"\bpower bi\b|\bpowerbi\b", "Power BI"),
    (r"\bexcel\b|\bspreadsheet\b", "Excel"),
    (r"\bkobocollect\b|\bkobotoolbox\b|\bkobo\b", "KoboToolbox"),
    # finance
    (r"\baccounting\b", "Accounting"),
    (r"\bfinanc", "Financial management"),
    (r"\bbudget", "Budgeting"),
    (r"\bpayroll\b", "Payroll"),
    (r"\bprocurement\b", "Procurement"),
    (r"\bifrs\b", "IFRS"),
    (r"\bquickbooks\b", "QuickBooks"),
    (r"\bsage\b", "Sage"),
    (r"\breconciliation|\baudit\b", "Reconciliation"),
    # IT
    (r"\bnetwork", "Networking"),
    (r"\bhardware\b", "Hardware support"),
    (r"\bsoftware\b", "Software support"),
    (r"\bit support\b|\bit services\b", "IT support"),
    (r"\btroubleshoot", "Troubleshooting"),
    (r"\bbackup\b", "Backup"),
    (r"\binformation technology\b", "Information Technology"),
    # admin / generic
    (r"\badministr", "Administration"),
    (r"\brecord[\s-]?keeping|\brecords management\b", "Records management"),
    (r"\breport writing\b|\breporting\b", "Report writing"),
    (r"\bdata management\b", "Data management"),
]

SOFT_KEYWORDS: list[tuple[str, str]] = [
    (r"\bcommunicat", "Communication"),
    (r"\bfacilitat", "Facilitation"),
    (r"\bleadership\b|\bsupervis|\bmentor|\bmanaged a team|\bteam lead\b|\bhead of\b", "Leadership"),
    (r"\bteamwork\b|\bcollaborat", "Teamwork"),
    (r"\bproblem[- ]?solving\b", "Problem solving"),
    (r"\battention to detail\b|\bdetail-oriented", "Attention to detail"),
    (r"\banalytical\b", "Analytical"),
    (r"\bcoordinat", "Coordination"),
    (r"\bstakeholder", "Stakeholder engagement"),
    (r"\borgani[sz]ational\b|\borgani[sz]ation\b", "Organizational"),
    (r"\bdocumentation\b", "Documentation"),
    (r"\btraining\b", "Training"),
    (r"\bintegrity\b", "Integrity"),
    (r"\bprofessional maturity\b|\bmaturity\b", "Professional maturity"),
    (r"\bstrategic thinking\b", "Strategic thinking"),
    (r"\bcrisis management\b", "Crisis management"),
    (r"\bjudgment\b|\bjudgement\b", "Judgment"),
    (r"\btime management\b|\bdeadline", "Time management"),
    (r"\binterpersonal\b", "Interpersonal"),
]

INDUSTRY_KEYWORDS: list[tuple[str, str]] = [
    (
        r"\bdonor[- ]funded\b|\busg[- ]funded\b|\busaid\b|\bpepfar\b|\bglobal fund\b|\bcdc\b|\bimplementing partner\b",
        "NGO",
    ),
]


def _nice_to_have(lines: list[str]) -> list[str]:
    out: list[str] = []
    for ln in lines:
        low = ln.lower()
        if "year" in low:  # experience lines are captured as minYears, not nice-to-have
            continue
        if re.search(r"\bpreferred\b|\ban advantage\b|\bdesirable\b|\badded advantage\b", low):
            clean = re.sub(r"(?i),?\s*(is an advantage|an advantage|desirable|preferred)\.?$", "", ln)
            clean = clean.strip().strip(".,; ").strip()
            if clean and len(clean) > 3:
                out.append(clean[:200])
    return out


# ---------------------------------------------------------------- entry point

def parse_minimum_recruitment_standard(text: str) -> dict[str, Any]:
    """Turn the "Minimum Recruitment Standard" text into scoring requirement fragments."""
    if not text or not text.strip():
        return {}
    low = text.lower()
    lines = [ln.strip() for ln in text.split("\n") if ln.strip()]

    out: dict[str, Any] = {}
    level = _qualification_level(low)
    if level is not None:
        out["minQualificationLevel"] = level
    fields = _fields_of_study(low)
    if fields:
        out["fieldsOfStudy"] = fields
    years = _min_years(low)
    if years is not None:
        out["minYears"] = years
    certs = _certifications(low)
    if certs:
        out["requiredCertifications"] = certs
    tech = _scan(TECH_KEYWORDS, low)
    if tech:
        out["technicalSkills"] = tech
    soft = _scan(SOFT_KEYWORDS, low)
    if soft:
        out["softSkills"] = soft
    industry = _scan(INDUSTRY_KEYWORDS, low)
    if industry:
        out["industryExperience"] = industry
    nice = _nice_to_have(lines)
    if nice:
        out["niceToHave"] = nice
    return out


def normalise_level_of_effort(text: str) -> str:
    """'Full Time' → 'Full-time', matching the employment types the app uses."""
    t = re.sub(r"\s+", " ", (text or "").strip().lower())
    if t in ("full time", "full-time"):
        return "Full-time"
    if t in ("part time", "part-time"):
        return "Part-time"
    if "consult" in t:
        return "Consultancy"
    if "contract" in t or "short term" in t:
        return "Contract"
    if "intern" in t:
        return "Internship"
    if "temporary" in t or "temp" in t:
        return "Temporary"
    return (text or "").strip() or "Full-time"
