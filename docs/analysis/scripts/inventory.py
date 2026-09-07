#!/usr/bin/env python3
import argparse, json, re, subprocess
from pathlib import Path
p=argparse.ArgumentParser()
p.add_argument('--template',required=True)
p.add_argument('--effect',required=True)
p.add_argument('--output',required=True)
a=p.parse_args()
t=Path(a.template).resolve(); e=Path(a.effect).resolve()
files=subprocess.check_output(['git','-C',str(t),'ls-files'],text=True).splitlines()
read=lambda f:(t/f).read_text()
r={
 'template':{'root':str(t),'commit':subprocess.check_output(['git','-C',str(t),'rev-parse','HEAD'],text=True).strip()},
 'effect':{'root':str(e),'commit':subprocess.check_output(['git','-C',str(e),'rev-parse','HEAD'],text=True).strip(),'version':json.loads((e/'packages/effect/package.json').read_text())['version']},
 'trackedFiles':files,
 'packages':{f:json.loads(read(f)) for f in files if f.endswith('package.json')},
 'documents':{f:re.findall(r'^#{1,4} .+$',read(f),re.M) for f in files if f.endswith('.md')},
 'pages':[f for f in files if f.endswith('/page.tsx')],
 'routes':{f:re.findall(r'export\s+(?:async\s+)?function\s+(GET|POST|PATCH|PUT|DELETE|HEAD|OPTIONS)\b',read(f)) for f in files if f.endswith('/route.ts')},
 'apiContractEntries':re.findall(r'\{ method: "([A-Z]+)", path: "([^"]+)"',read('apps/web/scripts/api-contracts.mjs')),
 'tables':re.findall(r'pgTable\(\s*"([^"]+)"',read('apps/web/db/schema.ts')),
 'migrations':[f for f in files if '/migrations/' in f and f.endswith('.sql')],
 'tests':[f for f in files if re.search(r'(?:\.test\.mjs|\.spec\.ts|\.setup\.ts)$',f)],
 'environmentKeys':{f:re.findall(r'^([A-Z][A-Z0-9_]*)=',read(f),re.M) for f in files if '.env' in Path(f).name},
 'scripts':[f for f in files if '/scripts/' in f or f.startswith('scripts/')],
 'skills':[f for f in files if f.endswith('/SKILL.md')],
 'composeServices':re.findall(r'^  ([a-z][a-z0-9_-]+):\s*$',read('deploy/compose/docker-compose.yml').split('\nvolumes:')[0],re.M)
}
Path(a.output).write_text(json.dumps(r,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:len(r[k]) for k in ['trackedFiles','packages','documents','pages','routes','apiContractEntries','tables','migrations','tests','scripts','skills']},indent=2))
