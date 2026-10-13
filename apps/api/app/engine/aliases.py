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
}

# The TypeScript escape set: s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
_RE_ESC = re.compile(r"[.*+?^${}()|\[\]\\]")


def _re_esc(s: str) -> str:
    return _RE_ESC.sub(lambda m: "\\" + m.group(0), s)


def term_regex(term: str) -> re.Pattern[str]:
    t = term.lower()
    strict = len(t.strip()) <= 4
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
