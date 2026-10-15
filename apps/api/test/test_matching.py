"""Accuracy of CV-to-job evidence matching: no false positives on common words,
recall of inflections and the ECEWS domain vocabulary."""
from __future__ import annotations

from app.engine.aliases import aliases_of, find_evidence, term_regex


def test_excel_does_not_match_excellent():
    assert term_regex("excel").search("Advanced Excel for reporting")
    assert not term_regex("excel").search("excellent communication skills")


def test_troubleshooting_matches_troubleshoot_inflection():
    # A CV saying "troubleshoot" must evidence the "Troubleshooting" requirement.
    assert find_evidence("diagnosed and troubleshoot network faults", ["network faults"], "Troubleshooting")["hit"] is True


def test_clinical_domain_synonyms_recall():
    # HIV/TB/Malaria/MNCH terms match their common written forms.
    assert find_evidence("managed HIV/AIDS prevention programmes", ["x"], "HIV")["hit"] is True
    assert find_evidence("supported TB and DOTS services", ["x"], "TB / Tuberculosis")["hit"] is True
    assert find_evidence("led malaria case management and vector control", ["x"], "Malaria")["hit"] is True
    assert find_evidence("reproductive health and family planning", ["x"], "MNCH / Maternal health")["hit"] is True


def test_finance_domain_synonyms_recall():
    assert find_evidence("prepared bank reconciliations and audit schedules", ["x"], "Reconciliation")["hit"] is True
    assert find_evidence("maintained the ledger and bookkeeping records", ["x"], "Accounting")["hit"] is True


def test_logistics_synonyms_recall():
    assert find_evidence("tracked stock levels and commodity inventory", ["x"], "Supply chain / logistics")["hit"] is True


def test_it_synonyms_recall():
    assert find_evidence("provided desktop support and helpdesk coverage", ["x"], "IT support")["hit"] is True
    assert find_evidence("repaired computer hardware", ["x"], "Hardware support")["hit"] is True


def test_monitoring_evaluation_synonyms_recall():
    assert find_evidence("routine monitoring and evaluation of the project", ["x"], "Monitoring / Evaluation / M&E")["hit"] is True
    assert find_evidence("led the M & E function", ["x"], "Monitoring / Evaluation / M&E")["hit"] is True


def test_short_terms_still_do_not_match_inside_words():
    # Regressions: short terms remain whole-word only.
    assert find_evidence("language skills", ["language skills"], "LAN")["hit"] is False
    assert find_evidence("configured vlan trunks", ["configured vlan trunks"], "Networking")["hit"] is True


def test_aliases_expand_new_terms():
    assert "antiretroviral" in aliases_of("HIV")
    assert "tuberculosis" in aliases_of("TB / Tuberculosis")
    assert "commodity" in aliases_of("Supply chain / logistics")
