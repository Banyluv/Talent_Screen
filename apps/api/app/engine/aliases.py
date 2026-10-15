"""Synonym dictionary used by the rules engine and by RAG retrieval.

Keys are lower-case canonical names; values are alternative spellings.
Matching is left-word-bounded and prefix-tolerant for terms longer than 4 characters
("network" matches "networking"); short terms must match as whole words.
Extend freely — no code changes elsewhere are needed.
"""
from __future__ import annotations

import re

SYNONYMS: dict[str, list[str]] = {
    # Microsoft / infrastructure
    "microsoft 365": ["microsoft 365", "office 365", "o365", "m365", "exchange online"],
    "azure": ["azure"],
    "active directory": ["active directory", "entra id", "azure ad", "aad", "ad ds"],
    "entra id": ["entra id", "azure ad", "azure active directory"],
    "intune": ["intune", "endpoint manager"],
    "powershell": ["powershell"],
    "windows server": ["windows server", "server 2012", "server 2016", "server 2019", "server 2022"],
    "networking": ["networking", "network", "lan", "wan", "vlan", "firewall", "routing", "switching"],
    "microsoft defender": ["defender", "mde"],
    "unifi": ["unifi", "ubiquiti"],
    "backup": ["backup", "veeam", "disaster recovery", "azure backup"],
    "sharepoint": ["sharepoint"],
    "itil": ["itil"],
    "linux": ["linux", "ubuntu", "centos", "red hat", "rhel"],
    "virtualization": ["virtualization", "virtualisation", "vmware", "hyper-v", "proxmox"],
    "docker": ["docker", "container"],
    "kubernetes": ["kubernetes", "k8s", "aks"],
    "sql": ["sql", "postgres", "mysql", "sql server", "t-sql"],
    "python": ["python", "pandas"],
    "cybersecurity": ["cybersecurity", "cyber security", "information security", "infosec", "siem", "sentinel", "soc"],
    # Data / M&E
    "dhis2": ["dhis2", "dhis 2", "dhis-2"],
    "datim": ["datim"],
    "power bi": ["power bi", "powerbi"],
    "excel": ["excel", "spreadsheet"],
    "kobotoolbox": ["kobotoolbox", "kobo toolbox", "kobocollect", "kobo collect", "kobo", "odk"],
    "data quality assessment": ["data quality assessment", "dqa", "data quality", "routine data quality"],
    "report writing": ["report writing", "reports", "reporting"],
    "stata": ["stata"],
    "spss": ["spss"],
    "r": ["r programming", "rstudio"],
    # Finance / HR
    "ifrs": ["ifrs", "international financial reporting"],
    "quickbooks": ["quickbooks"],
    "sage": ["sage"],
    "payroll": ["payroll"],
    "procurement": ["procurement", "sourcing", "purchasing"],
    # Soft skills
    "communication": ["communicat", "presented", "presentation", "stakeholder"],
    "leadership": ["leadership", "led ", "supervis", "managed a team", "mentor", "team lead", "head of"],
    "teamwork": ["team", "collaborat", "cross-functional"],
    "problem solving": ["problem solving", "problem-solving", "troubleshoot", "resolved", "root cause"],
    "attention to detail": ["attention to detail", "accuracy", "accurate", "detail-oriented"],
    "time management": ["time management", "deadline", "prioritis", "prioritiz"],
    # Sector
    "ngo": ["ngo", "non-governmental", "non-profit", "nonprofit", "development partner", "donor", "usaid", "pepfar", "cdc", "global fund", "implementing partner", "fcdo", "unicef", "world health organization"],
    "public health": ["public health", "hiv", "tb", "tuberculosis", "malaria", "maternal", "health programme", "health program", "epidemiolog"],
    "education": ["education", "school", "teaching", "curriculum", "learning"],
    # -------------------------------------------------- public health / clinical
    "hiv": ["hiv", "hiv/aids", "antiretroviral", "pmtct", "viral load"],
    "tb": ["tb", "tuberculosis", "dots", "mdr-tb", "mdr tb"],
    "tuberculosis": ["tuberculosis", "tb", "dots", "mdr-tb", "mdr tb"],
    "malaria": ["malaria", "antimalarial", "vector control", "chemoprevention", "iptp", "smc"],
    "mnch": ["mnch", "maternal", "newborn", "child health", "mch"],
    "maternal health": ["maternal health", "maternal", "mnch", "antenatal", "postnatal", "reproductive health", "family planning"],
    "epidemiology": ["epidemiology", "epidemiolog", "epidemic", "outbreak"],
    "surveillance": ["surveillance", "surveill", "case finding", "early warning"],
    "clinical services": ["clinical services", "clinical", "patient care", "case management"],
    "pharmacy": ["pharmacy", "pharmaceutical", "pharmacist", "pharmacovigilance", "dispensing"],
    "laboratory services": ["laboratory services", "laboratory", "lab", "lab services", "medical laboratory"],
    "supply chain": ["supply chain", "logistics", "commodity", "lmis", "stock management", "inventory"],
    "logistics": ["logistics", "supply chain", "commodity", "lmis", "stock management"],
    "nursing": ["nursing", "nurse", "midwifery", "midwife"],
    "midwifery": ["midwifery", "midwife", "nurse"],
    "community health": ["community health", "community health worker", "outreach"],
    "health informatics": ["health informatics", "emr", "electronic medical record", "health information"],
    "emr": ["emr", "electronic medical record", "health informatics"],
    # ------------------------------------------------------------- M&E / data
    "monitoring": ["monitoring", "m&e", "monitoring and evaluation", "monitoring & evaluation"],
    "evaluation": ["evaluation", "m&e", "monitoring and evaluation", "monitoring & evaluation"],
    "m&e": ["m&e", "m and e", "m & e", "monitoring and evaluation", "monitoring & evaluation"],
    "strategic information": ["strategic information", "si", "m&e", "data quality", "monitoring and evaluation"],
    "statistics": ["statistics", "statistical", "biostatistics", "data analysis"],
    "data analysis": ["data analysis", "analys", "analysis", "analytics", "statistics", "data analytics"],
    "analytics": ["analytics", "analys", "data analysis", "business intelligence"],
    "data management": ["data management", "database", "data entry", "data quality", "data systems"],
    # --------------------------------------------------------- finance / admin
    "accounting": ["accounting", "account", "accountancy", "bookkeeping"],
    "financial management": ["financial management", "finance", "budget", "financial reporting", "budgeting"],
    "budgeting": ["budgeting", "budget", "budget management", "budget monitoring"],
    "reconciliation": ["reconciliation", "reconcil", "audit", "bank reconciliation"],
    "administration": ["administration", "administrative", "office management", "admin support"],
    "records management": ["records management", "record keeping", "record-keeping", "document management", "filing"],
    # ------------------------------------------------------------------ IT ops
    "hardware support": ["hardware support", "hardware", "computer hardware", "hardware troubleshooting"],
    "software support": ["software support", "software", "application support", "software troubleshooting"],
    "it support": ["it support", "technical support", "helpdesk", "help desk", "desktop support"],
    "troubleshooting": ["troubleshooting", "troubleshoot", "resolved", "fixed", "root cause", "diagnos"],
    "information technology": ["information technology", "ict", "computing", "computer science"],
    # ------------------------------------------------------------- soft skills
    "facilitation": ["facilitation", "facilitat", "training", "workshop", "moderat"],
    "analytical": ["analytical", "analyt", "analysis", "data-driven"],
    "coordination": ["coordination", "coordinat", "coordinated", "liaised", "liaise"],
    "stakeholder engagement": ["stakeholder engagement", "stakeholder", "partner engagement", "stakeholders"],
    "organizational": ["organizational", "organisational", "organised", "organized", "planning"],
    "documentation": ["documentation", "document", "record", "reporting"],
    "training": ["training", "train", "mentored", "coached", "facilitated"],
    "integrity": ["integrity", "ethical", "confidentiality", "honest"],
    "professional maturity": ["professional maturity", "maturity", "professionalism"],
    "strategic thinking": ["strategic thinking", "strategic", "strategy", "strategic planning"],
    "crisis management": ["crisis management", "crisis", "emergency response", "emergency preparedness"],
    "judgment": ["judgment", "judgement", "decision making", "decision-making"],
    "interpersonal": ["interpersonal", "people skills", "relationship building"],
}

# The TypeScript escape set: s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
_RE_ESC = re.compile(r"[.*+?^${}()|\[\]\\]")


def _re_esc(s: str) -> str:
    return _RE_ESC.sub(lambda m: "\\" + m.group(0), s)


# Complete words that are dangerous as prefixes of unrelated longer words.
# These must match as whole words even though they exceed the 4-character strict
# limit ("excel" would otherwise match "excellent").
WHOLE_WORD: frozenset[str] = frozenset({"excel", "access"})


def term_regex(term: str) -> re.Pattern[str]:
    t = term.lower()
    strict = len(t.strip()) <= 4 or t in WHOLE_WORD
    return re.compile("(^|[^a-z0-9])" + _re_esc(t) + ("(?![a-z0-9])" if strict else ""), re.I)


def aliases_of(item: str) -> list[str]:
    """Expand a requirement into the strings that count as evidence for it.

    "Azure Administrator (AZ-104)" → ["azure administrator (az-104)", "azure administrator", "az-104"]
    "Stata / SPSS" → ["stata / spss", "stata", "spss"]
    Note: a requirement written with alternatives ("A / B") is met by either.
    """
    out: list[str] = []

    def add(p: str) -> None:
        k = p.strip().lower()
        if not k:
            return
        for v in [k, *(SYNONYMS.get(k) or [])]:
            if v not in out:
                out.append(v)

    add(item)
    for part in re.split(r"\s+/\s+|\s+or\s+|\(|\)", item, flags=re.I):
        add(part)
    # Certifications: "Microsoft Certified: Azure Administrator" → also "azure administrator"
    after_colon = item.split(":")[-1]
    if after_colon and after_colon != item:
        add(after_colon)
    return [a for a in out if len(a) >= 2]


def find_evidence(text: str, lines: list[str], item: str) -> dict:
    for a in aliases_of(item):
        re_ = term_regex(a)
        if re_.search(text):
            line = next((l for l in lines if re_.search(l)), "")
            return {"hit": True, "alias": a, "line": line[:177] + "…" if len(line) > 180 else line}
    return {"hit": False}
