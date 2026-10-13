"""Permission catalogue and default role grants.

Super Administrators can change role grants at runtime (Users & Roles → Roles);
these defaults are applied only when the database is first seeded.
"""
from __future__ import annotations

from typing import TypedDict


class Permission(TypedDict):
    key: str
    category: str
    description: str


PERMISSIONS: list[Permission] = [
    # Administration
    {"key": "users.manage", "category": "Administration", "description": "Create, edit, suspend users"},
    {"key": "roles.manage", "category": "Administration", "description": "Assign roles and edit role permissions"},
    {"key": "org.manage", "category": "Administration", "description": "Create organisations and departments"},
    {"key": "scoring.configure", "category": "Administration", "description": "Configure scoring weights, thresholds and rules"},
    {"key": "ai.configure", "category": "Administration", "description": "Configure AI evaluation settings"},
    {"key": "audit.view", "category": "Administration", "description": "View and export audit logs"},
    {"key": "data.erase", "category": "Administration", "description": "Erase a candidate's personal data (data-protection request)"},
    # Vacancies
    {"key": "jobs.create", "category": "Vacancies", "description": "Create and publish job postings"},
    {"key": "jobs.edit", "category": "Vacancies", "description": "Edit job descriptions and requirements"},
    {"key": "jobs.approve", "category": "Vacancies", "description": "Approve or reject hiring requests"},
    {"key": "jobs.view_all", "category": "Vacancies", "description": "See every vacancy"},
    {"key": "jobs.view_assigned", "category": "Vacancies", "description": "See vacancies assigned to me"},
    {"key": "hiring_requests.create", "category": "Vacancies", "description": "Raise hiring requests"},
    # Candidates
    {"key": "candidates.upload", "category": "Candidates", "description": "Upload CVs (single and bulk)"},
    {"key": "candidates.view", "category": "Candidates", "description": "View candidates on visible vacancies"},
    {"key": "candidates.view_assigned", "category": "Candidates", "description": "View only candidates I interview"},
    {"key": "candidates.status", "category": "Candidates", "description": "Track and update applicant status"},
    {"key": "workflow.manage", "category": "Candidates", "description": "Manage recruitment workflow (all status moves)"},
    # Evaluation
    {"key": "evaluations.view", "category": "Evaluation", "description": "View AI evaluations and rankings"},
    {"key": "evaluations.run", "category": "Evaluation", "description": "Re-run evaluations"},
    {"key": "evaluations.override", "category": "Evaluation", "description": "Override AI recommendations"},
    {"key": "shortlist.review", "category": "Evaluation", "description": "Review shortlisted candidates"},
    # Interviews
    {"key": "interviews.schedule", "category": "Interviews", "description": "Schedule interviews and assign panels"},
    {"key": "interviews.view", "category": "Interviews", "description": "View interviews and panel feedback"},
    {"key": "interviews.score", "category": "Interviews", "description": "Record interview scores and feedback"},
    {"key": "recommendations.create", "category": "Interviews", "description": "Submit hiring recommendations"},
    # Reports
    {"key": "reports.view", "category": "Reports", "description": "View recruitment reports"},
    {"key": "reports.export", "category": "Reports", "description": "Export to PDF, Excel and CSV"},
]

ALL_PERMISSION_KEYS: list[str] = [p["key"] for p in PERMISSIONS]


class RoleDefault(TypedDict):
    key: str
    name: str
    description: str
    permissions: list[str]


DEFAULT_ROLES: list[RoleDefault] = [
    {
        "key": "super_admin",
        "name": "Super Administrator",
        "description": "Full system access",
        "permissions": ALL_PERMISSION_KEYS,
    },
    {
        "key": "hr_admin",
        "name": "HR Administrator",
        "description": "Runs recruitment campaigns end to end",
        "permissions": [
            "jobs.create", "jobs.edit", "jobs.approve", "jobs.view_all", "candidates.upload", "candidates.view",
            "candidates.status", "workflow.manage", "evaluations.view", "evaluations.run", "evaluations.override",
            "shortlist.review", "interviews.schedule", "interviews.view", "reports.view", "reports.export", "data.erase",
        ],
    },
    {
        "key": "hiring_manager",
        "name": "Hiring Manager",
        "description": "Requests hires and decides on shortlisted candidates",
        "permissions": [
            "hiring_requests.create", "jobs.view_assigned", "candidates.view", "evaluations.view", "shortlist.review",
            "interviews.view", "interviews.score", "recommendations.create", "reports.view",
        ],
    },
    {
        "key": "recruiter",
        "name": "Recruiter",
        "description": "Sources candidates on assigned vacancies",
        "permissions": [
            "jobs.view_assigned", "candidates.upload", "candidates.view", "candidates.status", "evaluations.view",
            "interviews.schedule", "interviews.view",
        ],
    },
    {
        "key": "interview_panel",
        "name": "Interview Panel",
        "description": "Scores assigned candidates only",
        "permissions": ["candidates.view_assigned", "interviews.score"],
    },
    {
        "key": "viewer",
        "name": "Viewer",
        "description": "Read-only access to recruitment reports",
        "permissions": ["reports.view"],
    },
]
