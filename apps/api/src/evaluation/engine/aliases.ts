/**
 * Synonym dictionary used by the rules engine and by RAG retrieval.
 * Keys are lower-case canonical names; values are alternative spellings.
 * Matching is left-word-bounded and prefix-tolerant for terms longer than 4 characters
 * ("network" matches "networking"); short terms must match as whole words.
 * Extend freely — no code changes elsewhere are needed.
 */
export const SYNONYMS: Record<string, string[]> = {
  // Microsoft / infrastructure
  'microsoft 365': ['microsoft 365', 'office 365', 'o365', 'm365', 'exchange online'],
  'azure': ['azure'],
  'active directory': ['active directory', 'entra id', 'azure ad', 'aad', 'ad ds'],
  'entra id': ['entra id', 'azure ad', 'azure active directory'],
  'intune': ['intune', 'endpoint manager'],
  'powershell': ['powershell'],
  'windows server': ['windows server', 'server 2012', 'server 2016', 'server 2019', 'server 2022'],
  'networking': ['networking', 'network', 'lan', 'wan', 'vlan', 'firewall', 'routing', 'switching'],
  'microsoft defender': ['defender', 'mde'],
  'unifi': ['unifi', 'ubiquiti'],
  'backup': ['backup', 'veeam', 'disaster recovery', 'azure backup'],
  'sharepoint': ['sharepoint'],
  'itil': ['itil'],
  'linux': ['linux', 'ubuntu', 'centos', 'red hat', 'rhel'],
  'virtualization': ['virtualization', 'virtualisation', 'vmware', 'hyper-v', 'proxmox'],
  'docker': ['docker', 'container'],
  'kubernetes': ['kubernetes', 'k8s', 'aks'],
  'sql': ['sql', 'postgres', 'mysql', 'sql server', 't-sql'],
  'python': ['python', 'pandas'],
  'cybersecurity': ['cybersecurity', 'cyber security', 'information security', 'infosec', 'siem', 'sentinel', 'soc'],
  // Data / M&E
  'dhis2': ['dhis2', 'dhis 2', 'dhis-2'],
  'datim': ['datim'],
  'power bi': ['power bi', 'powerbi'],
  'excel': ['excel', 'spreadsheet'],
  'kobotoolbox': ['kobotoolbox', 'kobo toolbox', 'kobocollect', 'kobo collect', 'kobo', 'odk'],
  'data quality assessment': ['data quality assessment', 'dqa', 'data quality', 'routine data quality'],
  'report writing': ['report writing', 'reports', 'reporting'],
  'stata': ['stata'],
  'spss': ['spss'],
  'r': ['r programming', 'rstudio'],
  // Finance / HR
  'ifrs': ['ifrs', 'international financial reporting'],
  'quickbooks': ['quickbooks'],
  'sage': ['sage'],
  'payroll': ['payroll'],
  'procurement': ['procurement', 'sourcing', 'purchasing'],
  // Soft skills
  'communication': ['communicat', 'presented', 'presentation', 'stakeholder'],
  'leadership': ['leadership', 'led ', 'supervis', 'managed a team', 'mentor', 'team lead', 'head of'],
  'teamwork': ['team', 'collaborat', 'cross-functional'],
  'problem solving': ['problem solving', 'problem-solving', 'troubleshoot', 'resolved', 'root cause'],
  'attention to detail': ['attention to detail', 'accuracy', 'accurate', 'detail-oriented'],
  'time management': ['time management', 'deadline', 'prioritis', 'prioritiz'],
  // Sector
  'ngo': ['ngo', 'non-governmental', 'non-profit', 'nonprofit', 'development partner', 'donor', 'usaid', 'pepfar', 'cdc', 'global fund', 'implementing partner', 'fcdo', 'unicef', 'world health organization'],
  'public health': ['public health', 'hiv', 'tb', 'tuberculosis', 'malaria', 'maternal', 'health programme', 'health program', 'epidemiolog'],
  'education': ['education', 'school', 'teaching', 'curriculum', 'learning'],
};

const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function termRegex(term: string): RegExp {
  const t = term.toLowerCase();
  const strict = t.trim().length <= 4;
  return new RegExp('(^|[^a-z0-9])' + reEsc(t) + (strict ? '(?![a-z0-9])' : ''), 'i');
}

/**
 * Expand a requirement into the strings that count as evidence for it.
 * "Azure Administrator (AZ-104)" → ["azure administrator (az-104)", "azure administrator", "az-104"]
 * "Stata / SPSS" → ["stata / spss", "stata", "spss"]
 * Note: a requirement written with alternatives ("A / B") is met by either.
 */
export function aliasesOf(item: string): string[] {
  const out = new Set<string>();
  const add = (p: string) => {
    const k = p.trim().toLowerCase();
    if (!k) return;
    out.add(k);
    (SYNONYMS[k] ?? []).forEach((a) => out.add(a));
  };
  add(item);
  item.split(/\s+\/\s+|\s+or\s+|\(|\)/i).forEach(add);
  // Certifications: "Microsoft Certified: Azure Administrator" → also "azure administrator"
  const afterColon = item.split(':').pop();
  if (afterColon && afterColon !== item) add(afterColon);
  return [...out].filter((a) => a.length >= 2);
}

export interface Hit { hit: boolean; alias?: string; line?: string }

export function findEvidence(text: string, lines: string[], item: string): Hit {
  for (const a of aliasesOf(item)) {
    const re = termRegex(a);
    if (re.test(text)) {
      const line = lines.find((l) => re.test(l)) ?? '';
      return { hit: true, alias: a, line: line.length > 180 ? line.slice(0, 177) + '…' : line };
    }
  }
  return { hit: false };
}
