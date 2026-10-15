"""Ported from test/engine.test.ts — every assertion and expected value is kept identical."""
from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path

import pytest

from app.engine.aliases import aliases_of, find_evidence
from app.engine.llm import redact
from app.engine.parser import merged_years, parse_cv
from app.engine.rag import chunk_cv, retrieve
from app.engine.scorer import score

ROOT = Path(__file__).resolve().parents[1]
NOW = datetime(2026, 10, 1)
JOBS = json.loads((ROOT / "seed" / "demo-jobs.json").read_text(encoding="utf-8"))
W = {"qualifications": 20, "technical": 30, "experience": 30, "certifications": 10, "preferred": 5, "progression": 5}
T = {"shortlist": 85, "consider": 65, "hold": 50}
R = {"enforceMinExperience": True, "enforceMandatory": True, "experienceBasis": "relevant"}


def cv(f: str) -> dict:
    return parse_cv((ROOT / "seed" / "demo-cvs" / f).read_text(encoding="utf-8"), NOW)


def run(file: str, job: dict | None = None) -> dict:
    if job is None:
        job = JOBS[0]
    return score({"cv": cv(file), "jobTitle": job["title"], "req": job["requirements"], "weights": W, "thresholds": T, "rules": R})


class TestParser:
    def test_reads_name_contacts_roles_and_education(self):
        p = cv("chidinma-okafor.txt")
        assert p["name"] == "Chidinma Okafor"
        assert p["email"] == "chidinma.okafor@example.com"
        assert len(p["roles"]) == 3
        assert p["roles"][2]["current"] is True
        assert p["highestLevel"] == 4

    def test_merges_overlapping_employment_periods(self):
        assert merged_years([{"start": 2018, "end": 2020}, {"start": 2019, "end": 2021}, {"start": 2022, "end": 2023}]) == 4

    def test_understands_numeric_month_ranges(self):
        p = parse_cv("Jane Doe\nEXPERIENCE\nAnalyst — Org | 03/2019 - 08/2021\nEDUCATION\nBSc Statistics 2018", NOW)
        assert p["roles"][0]["start"] == pytest.approx(2019 + 2 / 12)
        assert p["totalYears"] == pytest.approx(2.5, abs=0.05)


class TestAliases:
    def test_expands_certification_codes_and_alternatives(self):
        assert {"az-104", "azure administrator"}.issubset(set(aliases_of("Azure Administrator (AZ-104)")))
        assert {"stata", "spss"}.issubset(set(aliases_of("Stata / SPSS")))

    def test_does_not_match_short_terms_inside_words(self):
        assert find_evidence("language skills", ["language skills"], "LAN")["hit"] is False
        assert find_evidence("configured vlan trunks", ["configured vlan trunks"], "Networking")["hit"] is True


class TestScorer:
    def test_shortlists_a_strong_evidenced_candidate(self):
        r = run("chidinma-okafor.txt")
        assert r["recommendation"] == "Shortlist"
        assert r["overall"] >= 85
        assert all(s.get("evidence") for s in r["strengths"] if s["text"].startswith("Evidence of"))

    def test_rejects_when_a_mandatory_requirement_is_missing_and_says_why(self):
        r = run("grace-udoh.txt")
        assert r["recommendation"] == "Reject"
        assert re.search(r"Mandatory requirement not evidenced: Azure", r["hardRuleFailures"][0])

    def test_gaps_carry_a_severity_for_prioritisation(self):
        r = run("grace-udoh.txt")
        assert r["gaps"], "expected at least one gap"
        assert all("severity" in g and g["severity"] in {"critical", "moderate", "minor"} for g in r["gaps"])
        # a missing mandatory requirement is the highest severity
        assert any(g["severity"] == "critical" and "Azure" in g["text"] for g in r["gaps"])

    def test_review_is_job_specific_not_generic(self):
        r = run("grace-udoh.txt")
        assert r.get("review"), "expected a rules-generated suitability review"
        # it must name the vacancy and the ranking, not just restate the score
        assert JOBS[0]["title"] in r["review"]
        assert r["recommendation"] in r["review"]
        # it must tie the CV to the job description by naming a specific requirement
        assert "Azure" in r["review"]

    def test_review_reports_evidence_when_requirements_are_met(self):
        r = run("chidinma-okafor.txt")
        assert "Microsoft 365" in r["review"] and "Azure" in r["review"]

    def test_match_summary_has_gaps_matches_and_recommendations(self):
        r = run("grace-udoh.txt")
        ms = r["matchSummary"]
        assert ms["industryBenchmark"] == 70
        assert ms["recommendations"], "expected actionable recommendations"
        assert "Azure" in ms["missingKeywords"]
        assert "Azure" in ms["skillGapAnalysis"]["critical"]
        assert all(m["matchType"] in {"exact", "synonym", "semantic"} for m in ms["keywordMatches"])
        assert {m["keyword"] for m in ms["keywordMatches"]} >= {"Microsoft 365"}

    def test_rejects_below_minimum_relevant_experience(self):
        r = run("blessing-akpan.txt", JOBS[1])
        assert r["recommendation"] == "Reject"
        assert any(re.search(r"below the 3-year minimum", h) for h in r["hardRuleFailures"])

    def test_can_be_configured_not_to_auto_reject(self):
        r = score(
            {
                "cv": cv("grace-udoh.txt"),
                "jobTitle": JOBS[0]["title"],
                "req": JOBS[0]["requirements"],
                "weights": W,
                "thresholds": T,
                "rules": {**R, "enforceMandatory": False},
            }
        )
        assert r["recommendation"] != "Reject"

    def test_ignores_protected_attributes(self):
        base = (ROOT / "seed" / "demo-cvs" / "amaka-eze.txt").read_text(encoding="utf-8")
        a = score({"cv": parse_cv(base, NOW), "jobTitle": JOBS[1]["title"], "req": JOBS[1]["requirements"], "weights": W, "thresholds": T, "rules": R})
        b = score(
            {
                "cv": parse_cv(
                    base.replace("Amaka Eze", "John Smith") + "\nPERSONAL DETAILS\nGender: Male\nReligion: Christian\nState of origin: Kano\nMarital status: Married",
                    NOW,
                ),
                "jobTitle": JOBS[1]["title"],
                "req": JOBS[1]["requirements"],
                "weights": W,
                "thresholds": T,
                "rules": R,
            }
        )
        assert b["overall"] == a["overall"]

    def test_accepts_model_verdicts_only_with_evidence(self):
        job = JOBS[0]
        model = {"technical::Intune": {"met": True, "evidence": "Deployed Intune to 300 devices"}, "technical::Microsoft Defender": {"met": True}}
        r = score({"cv": cv("grace-udoh.txt"), "jobTitle": job["title"], "req": job["requirements"], "weights": W, "thresholds": T, "rules": R, "model": model})
        assert next(c for c in r["checks"] if c["requirement"] == "Intune")["met"] is True
        assert next(c for c in r["checks"] if c["requirement"] == "Intune")["source"] == "llm"
        assert next(c for c in r["checks"] if c["requirement"] == "Microsoft Defender")["met"] is False


class TestRagAndRedaction:
    def test_retrieves_the_passage_that_mentions_the_requirement(self):
        p = cv("amaka-eze.txt")
        hits = retrieve(chunk_cv(p), "Data quality assessment", 2)
        assert "data quality" in hits[0]["text"].lower()

    def test_removes_contact_details_and_name_before_text_leaves_the_system(self):
        t = redact("Amaka Eze | amaka.eze@example.com | 0813 555 0129 | Amaka led DQAs", "Amaka Eze")
        assert not re.search(r"amaka|example\.com|0813", t, re.I)
