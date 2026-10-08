export type Recommendation = 'Shortlist' | 'Consider' | 'Hold' | 'Reject';
export const RECOMMENDATIONS: Recommendation[] = ['Shortlist', 'Consider', 'Hold', 'Reject'];

export interface Weights {
  qualifications: number;
  technical: number;
  experience: number;
  certifications: number;
  preferred: number;
  progression: number;
}
export const WEIGHT_KEYS: (keyof Weights)[] = ['qualifications', 'technical', 'experience', 'certifications', 'preferred', 'progression'];

export interface Thresholds { shortlist: number; consider: number; hold: number }
export interface ScoringRules {
  enforceMinExperience: boolean;   // Reject when relevant experience < job minimum
  enforceMandatory: boolean;       // Reject when a mandatory requirement is not evidenced
  experienceBasis: 'relevant' | 'total';
}

/** Education levels used for qualification matching. */
export const LEVELS: Record<number, string> = {
  1: 'Secondary (SSCE/WAEC)', 2: 'Diploma (OND/ND)', 3: "Bachelor's / HND", 3.5: 'Postgraduate Diploma', 4: "Master's", 5: 'Doctorate',
};

export interface JobRequirements {
  minQualificationLevel: number;
  fieldsOfStudy: string[];
  requiredQualifications: string[];   // free text, e.g. "BSc Computer Science or related"
  preferredQualifications: string[];
  requiredCertifications: string[];
  technicalSkills: string[];
  softSkills: string[];
  preferredSkills: string[];
  minYears: number;
  preferredYears: number;
  industryExperience: string[];
  locationRequirements: string;
  mandatory: string[];
  niceToHave: string[];
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: string;        // role key
  roleName: string;
  permissions: string[];
}

export interface RequirementCheck {
  category: 'technical' | 'certification' | 'soft' | 'preferred' | 'industry' | 'mandatory' | 'niceToHave' | 'qualification';
  requirement: string;
  met: boolean;
  evidence?: string;           // verbatim line from the CV
  source: 'rules' | 'llm';
  note?: string;
}
