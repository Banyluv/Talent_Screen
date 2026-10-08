#!/usr/bin/env python3
"""
End-to-end smoke test for a running TalentScreen stack (with SEED_DEMO_DATA=true).

    pip install requests
    python3 scripts/smoke_test.py --base http://localhost:8080 --admin-email admin@ecews.local --admin-password '...'
    python3 scripts/smoke_test.py ... --cv-dir path/to/cvs   # optional: upload your own PDF/DOCX/TXT CVs

Exercises sign-in, RBAC, upload and parsing, queued evaluation, ranking, override, interviews,
exports and the audit chain. Exits non-zero on the first failure.
"""
import argparse, os, sys, time
import requests

p = argparse.ArgumentParser()
p.add_argument('--base', default='http://localhost:8080')
p.add_argument('--admin-email', default='admin@ecews.local')
p.add_argument('--admin-password', required=True)
p.add_argument('--demo-password', default='Demo-Password-2026')
p.add_argument('--cv-dir')
a = p.parse_args()
API = a.base.rstrip('/') + '/api'
ok_count = 0

def check(cond, msg):
    global ok_count
    if not cond:
        print(f'FAIL  {msg}'); sys.exit(1)
    ok_count += 1; print(f'ok    {msg}')

def login(email, pwd):
    s = requests.Session()
    r = s.post(f'{API}/auth/login', json={'email': email, 'password': pwd})
    check(r.status_code == 200, f'sign in as {email} ({r.status_code})')
    s.headers['Authorization'] = 'Bearer ' + r.json()['accessToken']
    return s

r = requests.get(f'{API}/health'); check(r.ok, 'health endpoint')
check(requests.get(f'{API}/jobs').status_code == 401, 'anonymous request is rejected')
check(requests.post(f'{API}/auth/login', json={'email': a.admin_email, 'password': 'wrong-password'}).status_code == 401, 'wrong password is rejected')

admin = login(a.admin_email, a.admin_password)
hr = login('hr.admin@demo.ecews.local', a.demo_password)
rec = login('recruiter@demo.ecews.local', a.demo_password)
panel = login('panel.it@demo.ecews.local', a.demo_password)
viewer = login('viewer@demo.ecews.local', a.demo_password)
hm = login('hiring.manager@demo.ecews.local', a.demo_password)

# ---- RBAC
check(viewer.get(f'{API}/candidates').status_code == 403, 'viewer cannot list candidates')
check(viewer.get(f'{API}/reports/summary').ok, 'viewer can read reports')
check(viewer.get(f'{API}/reports/export?format=csv').status_code == 403, 'viewer cannot export')
check(rec.get(f'{API}/users').status_code in (200,) and rec.post(f'{API}/users', json={}).status_code == 403, 'recruiter cannot create users')
check(panel.get(f'{API}/candidates').json() == [], 'panel member sees no candidates before assignment')
check(hr.get(f'{API}/audit').status_code == 403, 'HR cannot read the audit log')

jobs = rec.get(f'{API}/jobs').json()
it = next(j for j in jobs if 'Systems Administrator' in j['title'])
check(len(jobs) == 2, 'recruiter sees only assigned vacancies')

# ---- hiring request → approval
r = hm.post(f'{API}/jobs', json={'title': 'Data Engineer', 'requirements': {'technicalSkills': ['SQL', 'Python', 'DHIS2'], 'minYears': 3, 'preferredYears': 5}})
check(r.ok, 'hiring manager raises a hiring request')
req_id = r.json()['id']
check(hm.get(f'{API}/jobs/{req_id}').json()['status'] == 'requested', 'request is pending approval')
check(hr.post(f'{API}/jobs/{req_id}/decision', json={'decision': 'approve'}).json()['status'] == 'open', 'HR approves the request')

# ---- upload
files = []
if a.cv_dir:
    for f in sorted(os.listdir(a.cv_dir)):
        files.append(('files', (f, open(os.path.join(a.cv_dir, f), 'rb').read())))
else:
    cv = ("Test Candidate\nLagos | test.candidate@example.com | 0803 555 0000\nEXPERIENCE\n"
          "Systems Administrator — Example NGO | Jan 2018 – Present\nManaged Microsoft 365, Azure, Intune and Windows Server; PowerShell scripting.\n"
          "EDUCATION\nBSc Computer Science — University of Lagos, 2016\nCERTIFICATIONS\nAzure Administrator Associate (AZ-104)\n")
    files.append(('files', ('test-candidate.txt', cv.encode())))
    files.append(('files', ('not-a-cv.png', b'\x89PNG\r\n\x1a\nxx')))
r = rec.post(f'{API}/jobs/{it["id"]}/candidates', files=files)
check(r.ok, f'recruiter uploads {len(files)} file(s)')
up = r.json()
print('      created:', [c['name'] for c in up['created']], ' skipped:', [(s['file'], s['reason'][:50]) for s in up['skipped']])
check(len(up['created']) >= 1, 'at least one CV accepted')
r = rec.post(f'{API}/jobs/{it["id"]}/candidates', files=[files[0]] if a.cv_dir else [('files', ('test-candidate.txt', cv.encode()))])
check(r.ok and r.json()['skipped'] and 'Duplicate' in r.json()['skipped'][0]['reason'], 'duplicate CV is detected')

# ---- evaluation runs in the worker
new_id = up['created'][0]['id']
for _ in range(60):
    d = hr.get(f'{API}/candidates/{new_id}').json()
    if d['evaluation'] and d['evaluation']['status'] in ('completed', 'failed'): break
    time.sleep(1)
check(d['evaluation']['status'] == 'completed', f"queued evaluation completed by the worker ({d['evaluation']['status']})")
e = d['evaluation']
print(f"      {d['fullName']}: {e['overall_score']}/100 → {e['recommendation']} · {e['relevant_years']} rel. yrs · engine {e['engine']}")
check(all('evidence' in s or 'progression' in s['text'] or 'experience' in s['text'] or 'meets' in s['text'] for s in e['strengths']), 'strengths carry CV evidence')

rank = hr.get(f'{API}/jobs/{it["id"]}/ranking').json()
check(rank[0]['rank'] == 1 and rank[0]['overall_score'] >= rank[-1]['overall_score'], 'ranking is ordered by score')

# ---- override (HR) and the record of it
target = next(x for x in rank if x['recommendation'] == 'Reject')
check(rec.post(f'{API}/candidates/{target["id"]}/override', json={'recommendation': 'Hold', 'reason': 'x' * 12}).status_code == 403, 'recruiter cannot override')
r = hr.post(f'{API}/candidates/{target["id"]}/override', json={'recommendation': 'Hold', 'reason': 'Holds equivalent certification not detected by the parser'})
check(r.ok, 'HR overrides a recommendation with a reason')
check(hr.get(f'{API}/candidates/{target["id"]}').json()['override']['to_rec'] == 'Hold', 'override is applied')

# ---- interview: schedule, panel sees only assigned candidate, scores
users = hr.get(f'{API}/users').json()
emeka = next(u for u in users if u['full_name'] == 'Emeka Obi')
top = rank[0]
r = hr.post(f'{API}/interviews', json={'candidateId': top['id'], 'scheduledAt': '2026-12-01T10:00:00+01:00', 'panelistIds': [emeka['id']]})
check(r.ok, 'HR schedules an interview')
iv = r.json()['id']
mine = panel.get(f'{API}/candidates').json()
check(len(mine) == 1 and mine[0]['id'] == top['id'], 'panel member now sees exactly the assigned candidate')
check(panel.get(f'{API}/candidates/{target["id"]}').status_code == 404, 'panel member cannot open other candidates')
check('email' not in panel.get(f'{API}/candidates/{top["id"]}').json() or panel.get(f'{API}/candidates/{top["id"]}').json().get('email') is None, 'panel member does not see contact details')
r = panel.post(f'{API}/interviews/{iv}/scores', json={'technical': 5, 'problemSolving': 4, 'communication': 4, 'teamFit': 5, 'comments': 'Strong tenant hardening examples.'})
check(r.ok and r.json()['total'] == 18, 'panel member submits scores')
check(hm.post(f'{API}/candidates/{top["id"]}/recommendations', json={'decision': 'hire', 'justification': 'Best technical and panel scores.'}).ok, 'hiring manager records a recommendation')

# ---- reports and exports
s = hr.get(f'{API}/reports/summary').json()
check(s['totals']['evaluated'] >= 7, 'report summary returns totals')
for fmt, magic in (('csv', b'\xef\xbb\xbf'), ('xlsx', b'PK'), ('pdf', b'%PDF')):
    r = hr.get(f'{API}/reports/export?format={fmt}&jobId={it["id"]}')
    check(r.ok and r.content.startswith(magic), f'export {fmt.upper()} ({len(r.content)} bytes)')

# ---- audit trail
log = admin.get(f'{API}/audit?limit=500').json()
acts = {x['action'] for x in log}
for need in ('candidate.uploaded', 'evaluation.completed', 'evaluation.overridden', 'interview.scheduled', 'report.exported', 'auth.login_failed'):
    check(need in acts, f'audit has {need}')
v = admin.get(f'{API}/audit/verify').json()
check(v['ok'], f"audit hash chain verifies ({v['checked']} entries)")

print(f'\nAll {ok_count} checks passed.')
