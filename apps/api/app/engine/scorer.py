"""Weighted, explainable scoring. Every check quotes a line of the CV."""
from __future__ import annotations

import math
import re

from .aliases import find_evidence, term_regex
from .keywords import STOP_WORDS, gap_severity
from .parser import merged_years, seniority

RECOMMENDATIONS: list[str] = ["Shortlist", "Consider", "Hold", "Reject"]

WEIGHT_KEYS: list[str] = ["qualifications", "technical", "experience", "certifications", "preferred", "progression"]

# Education levels used for qualification matching.
LEVELS: dict[float, str] = {
    1: "Secondary (SSCE/WAEC)",
    2: "Diploma (OND/ND)",
    3: "Bachelor's / HND",
    3.5: "Postgraduate Diploma",
    4: "Master's",
    5: "Doctorate",
}

def _round(n: float) -> int:
    """JavaScript's Math.round (half-up)."""
    return int(math.floor(n + 0.5))


def _round1(n: float) -> float:
    """JavaScript's Math.round(n * 10) / 10."""
    v = math.floor(n * 10 + 0.5) / 10
    return int(v) if float(v).is_integer() else v


def _num(x: float) -> str:
    """Render a number the way a JavaScript template literal does."""
    if isinstance(x, float):
        if x.is_integer():
            return str(int(x))
        return repr(x)
    return str(x)


def _fixed1(x: float) -> str:
    """JavaScript's Number.prototype.toFixed(1)."""
    v = math.floor(abs(x) * 10 + 0.5) / 10
    return ("-" if x < 0 else "") + f"{v:.1f}"


def _clamp(n: float) -> int:
    return max(0, min(100, _round(n)))


def _pct(a: list[dict]) -> int:
    return _round((100 * len([x for x in a if x["met"]])) / len(a)) if a else 100


def _lvl_name(n: float) -> str:
    return LEVELS.get(n, "Unrecognised")


def _item(text: str, evidence: str | None = None, why: str | None = None) -> dict:
    out: dict = {"text": text}
    if why is not None:
        out["why"] = why
    if evidence is not None:
        out["evidence"] = evidence
    return out


def _gap(
    text: str,
    category: str | None = None,
    severity: str | None = None,
    evidence: str | None = None,
    why: str | None = None,
) -> dict:
    """A gap item carrying a severity so the UI can prioritise it."""
    out = _item(text, evidence, why)
    out["severity"] = severity or gap_severity(category, text)
    return out


def score(input: dict) -> dict:
    cv = input["cv"]
    req = input["req"]
    w = input["weights"]
    T = input["thresholds"]
    rules = input["rules"]
    sections = cv["sections"]

    roles = cv["roles"] if cv["roles"] else (input.get("modelRoles") or [])
    total_years = cv["totalYears"] if cv["roles"] else (merged_years(roles) if roles else cv["totalYears"])

    # Quote the most specific line: experience and certification lines before the summary.
    ev_lines = [
        *(sections.get("experience") or []),
        *(sections.get("certifications") or []),
        *(sections.get("skills") or []),
        *cv["lines"],
    ]

    def check(category: str, requirement: str) -> dict:
        r = find_evidence(cv["lower"], ev_lines, requirement)
        if r["hit"]:
            return {"category": category, "requirement": requirement, "met": True, "evidence": r["line"], "source": "rules"}
        model = input.get("model")
        m = model.get(f"{category}::{requirement}") if model else None
        if m and m.get("met") and m.get("evidence"):
            return {"category": category, "requirement": requirement, "met": True, "evidence": m["evidence"], "source": "llm"}
        return {"category": category, "requirement": requirement, "met": False, "source": "llm" if m else "rules"}

    tech = [check("technical", s) for s in req["technicalSkills"]]
    certs = [check("certification", s) for s in req["requiredCertifications"]]
    soft = [check("soft", s) for s in req["softSkills"]]
    pref_skills = [check("preferred", s) for s in req["preferredSkills"]]
    industry = [check("industry", s) for s in req["industryExperience"]]
    mandatory = [check("mandatory", s) for s in req["mandatory"]]
    nice = [check("niceToHave", s) for s in req["niceToHave"]]

    # ---- relevant experience: roles that mention ≥2 of the job's skills or share a title keyword
    skill_set = [*req["technicalSkills"], *req["preferredSkills"]]
    title_words = [x for x in re.split(r"[^a-z0-9&]+", input["jobTitle"].lower()) if len(x) > 2 and x not in STOP_WORDS]

    def is_relevant(role: dict) -> bool:
        t = (role["title"] + "\n" + role["text"]).lower()
        n = len([s for s in skill_set if find_evidence(t, [t], s)["hit"]])
        return n >= 2 or any(term_regex(x).search(role["title"]) for x in title_words)

    relevant = [role for role in roles if is_relevant(role)]
    relevant_years = merged_years(relevant) if roles else total_years
    exp_years = total_years if rules["experienceBasis"] == "total" else relevant_years

    # ---- qualifications
    edu_sec = sections.get("education")
    edu_text = "\n".join(edu_sec if edu_sec is not None else cv["lines"]).lower()
    field_hit = (not req["fieldsOfStudy"]) or any(term_regex(f).search(edu_text) for f in req["fieldsOfStudy"])
    level = cv["highestLevel"]
    qual: float
    if level >= req["minQualificationLevel"]:
        qual = 70 + (30 if field_hit else 0)
    else:
        qual = ((50 * level) / req["minQualificationLevel"] if level else 0) + (15 if field_hit and level else 0)
    pref_qual = [check("qualification", q) for q in req["preferredQualifications"]]
    if any(q["met"] for q in pref_qual):
        qual += 10
    qual = _clamp(qual)

    # ---- experience
    minimum = req["minYears"]
    pref = max(req["preferredYears"], minimum)
    if exp_years >= pref:
        exp_val = 100.0
    elif exp_years >= minimum:
        exp_val = 70 + (30 * (exp_years - minimum)) / ((pref - minimum) or 1)
    else:
        exp_val = (70 * exp_years) / (minimum or 1)
    exp_val = _clamp(exp_val)

    # ---- career progression & stability
    sorted_roles = sorted(roles, key=lambda r: r["start"])
    avg_tenure = total_years / len(sorted_roles) if sorted_roles else 0
    prog = 60
    if len(sorted_roles) >= 2:
        first = seniority(sorted_roles[0]["title"])
        last = seniority(sorted_roles[-1]["title"])
        prog = 50 + (30 if last > first else 15 if last == first else 0) + (20 if avg_tenure >= 1.5 else 10 if avg_tenure >= 1 else 0)
    prog = _clamp(prog)

    components: dict[str, int] = {
        "qualifications": qual,
        "technical": _pct(tech),
        "experience": exp_val,
        "certifications": _pct(certs),
        "preferred": _pct([*soft, *pref_skills, *industry, *nice]),
        "progression": prog,
    }
    wsum = sum((w.get(k) or 0) for k in WEIGHT_KEYS) or 100
    overall = _round(sum(components[k] * (w.get(k) or 0) for k in WEIGHT_KEYS) / wsum)

    # ---- hard rules, then thresholds
    hard: list[str] = []
    missing_mandatory = [m for m in mandatory if not m["met"]]
    if rules["enforceMandatory"] and missing_mandatory:
        hard.append("Mandatory requirement not evidenced: " + ", ".join(m["requirement"] for m in missing_mandatory))
    if rules["enforceMinExperience"] and exp_years < minimum:
        hard.append(
            f"{'Total' if rules['experienceBasis'] == 'total' else 'Relevant'} experience of {_num(exp_years)} years is below the {_num(minimum)}-year minimum"
        )
    if hard:
        recommendation = "Reject"
    elif overall >= T["shortlist"]:
        recommendation = "Shortlist"
    elif overall >= T["consider"]:
        recommendation = "Consider"
    elif overall >= T["hold"]:
        recommendation = "Hold"
    else:
        recommendation = "Reject"

    # ---- strengths and gaps (each strength carries CV evidence)
    strengths: list[dict] = []
    gaps: list[dict] = []
    if level >= req["minQualificationLevel"]:
        best = next((e for e in cv["education"] if e["level"] == level), None)
        strengths.append(
            _item(
                f"{_lvl_name(level)}{' in a relevant field' if field_hit and req['fieldsOfStudy'] else ''} (minimum: {_lvl_name(req['minQualificationLevel'])})",
                best.get("line") if best is not None else None,
            )
        )
        if not field_hit:
            gaps.append(_gap(f"Field of study does not match: {', '.join(req['fieldsOfStudy'])}", severity="moderate"))
    else:
        gaps.append(
            _gap(f"Highest qualification ({_lvl_name(level)}) is below the required {_lvl_name(req['minQualificationLevel'])}" if level else "No recognisable academic qualification found",
                 category="qualification")
        )
    if exp_years >= minimum:
        strengths.append(_item(f"{_num(exp_years)} years {rules['experienceBasis']} experience (minimum {_num(minimum)}, preferred {_num(pref)})"))
    else:
        gaps.append(_gap(f"{_num(exp_years)} years {rules['experienceBasis']} experience against a {_num(minimum)}-year minimum", severity="critical"))
    for c in [c for c in tech if c["met"]]:
        strengths.append(_item(f"Evidence of {c['requirement']}", c.get("evidence")))
    for c in [c for c in certs if c["met"]]:
        strengths.append(_item(f"Holds {c['requirement']}", c.get("evidence")))
    for c in [c for c in industry if c["met"]][:2]:
        strengths.append(_item(f"Sector experience: {c['requirement']}", c.get("evidence")))
    if len(sorted_roles) >= 2 and seniority(sorted_roles[-1]["title"]) > seniority(sorted_roles[0]["title"]):
        strengths.append(_item("Clear upward career progression", f"{sorted_roles[0]['title']} → {sorted_roles[-1]['title']}"))
    for c in [c for c in mandatory if not c["met"]]:
        gaps.append(_gap(f"Mandatory: no evidence of {c['requirement']}", category="mandatory"))
    for c in [c for c in tech if not c["met"] and c["requirement"] not in req["mandatory"]]:
        gaps.append(_gap(f"No evidence of {c['requirement']}", category="technical"))
    for c in [c for c in certs if not c["met"]]:
        gaps.append(_gap(f"Certification not listed: {c['requirement']}", category="certification"))
    if len(sorted_roles) >= 3 and avg_tenure < 1.2:
        gaps.append(_gap(f"Short average tenure ({_fixed1(avg_tenure)} years per role)", severity="minor"))
    if not roles:
        gaps.append(_gap("Employment dates could not be read; experience was estimated", severity="moderate"))

    ai_matched = [c for c in [*mandatory, *tech, *certs] if c["met"] and c["source"] == "llm"]
    if ai_matched:
        gaps.append(
            _gap(
                f"Confirm AI-matched evidence for: {', '.join(c['requirement'] for c in ai_matched)}",
                severity="moderate",
                why="Matched by the language model, not by an exact keyword. The quoted line is real but its relevance needs a human check.",
            )
        )

    if hard:
        just = f"{'. '.join(hard)}. Weighted score was {_num(overall)}/100 before the rule was applied."
    else:
        just = (
            f"{_num(overall)}/100 weighted score: {components['technical']}% of required technical skills evidenced, "
            f"{_num(exp_years)} years {rules['experienceBasis']} experience against a {_num(minimum)}-year minimum, "
            f"{components['certifications']}% of required certifications. "
        ) + {
            "Shortlist": "Strong fit; recommend for interview.",
            "Consider": "Partial fit; review the gaps before deciding.",
            "Hold": "Below target; keep on file if the pool is thin.",
            "Reject": "Below the hold threshold.",
        }[recommendation]

    return {
        "overall": overall,
        "recommendation": recommendation,
        "components": components,
        "totalYears": total_years,
        "relevantYears": _round1(relevant_years),
        "qualificationMatch": qual,
        "skillsMatch": components["technical"],
        "checks": [*mandatory, *tech, *certs, *soft, *pref_skills, *industry, *nice, *pref_qual],
        "strengths": strengths,
        "gaps": gaps,
        "hardRuleFailures": hard,
        "justification": just,
        "roles": sorted_roles,
    }
