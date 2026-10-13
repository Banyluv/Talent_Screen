"""Shared domain vocabulary: recommendations, weights, education levels and job requirements."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

RECOMMENDATIONS: list[str] = ["Shortlist", "Consider", "Hold", "Reject"]

WEIGHT_KEYS: list[str] = [
    "qualifications",
    "technical",
    "experience",
    "certifications",
    "preferred",
    "progression",
]

# Education levels used for qualification matching.
LEVELS: dict[float, str] = {
    1: "Secondary (SSCE/WAEC)",
    2: "Diploma (OND/ND)",
    3: "Bachelor's / HND",
    3.5: "Postgraduate Diploma",
    4: "Master's",
    5: "Doctorate",
}

LEVEL_VALUES: list[float] = [1, 2, 3, 3.5, 4, 5]


@dataclass
class AuthUser:
    id: str
    email: str
    name: str
    role: str  # role key
    roleName: str
    permissions: list[str]

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "email": self.email,
            "name": self.name,
            "role": self.role,
            "roleName": self.roleName,
            "permissions": self.permissions,
        }

    def has(self, perm: str) -> bool:
        return perm in self.permissions


@dataclass
class AuditContext:
    user: AuthUser | None = None
    ip: str | None = None
    userAgent: str | None = None


@dataclass
class JobRequirements:
    minQualificationLevel: float = 3
    fieldsOfStudy: list[str] = field(default_factory=list)
    requiredQualifications: list[str] = field(default_factory=list)
    preferredQualifications: list[str] = field(default_factory=list)
    requiredCertifications: list[str] = field(default_factory=list)
    technicalSkills: list[str] = field(default_factory=list)
    softSkills: list[str] = field(default_factory=list)
    preferredSkills: list[str] = field(default_factory=list)
    minYears: float = 0
    preferredYears: float = 0
    industryExperience: list[str] = field(default_factory=list)
    locationRequirements: str = ""
    mandatory: list[str] = field(default_factory=list)
    niceToHave: list[str] = field(default_factory=list)
