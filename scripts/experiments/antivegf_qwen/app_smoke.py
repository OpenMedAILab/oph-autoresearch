"""One real generator/judge pair started by the oph SSH tool; aggregate stdout only."""
from pathlib import Path
import argparse, collections, contextlib, datetime, fcntl, hashlib, importlib.util, json, os, re, shlex, socket, sys
ROOT = Path('/data1/20251113/AntiVEGF')
PRIOR = ROOT / 'oph-qwen-live-acceptance-20260907'
SOURCE = Path('/data1/20251113/AntiVEGF2025KaiJ/project/AntiVEGF_Prompt_Self_Evolving')
RUNNER_HASH = '478195369dcea00e8cf80ee78b954f45398e1c153f08a253a8e60d6800bc72b1'
def read(p): return json.loads(p.read_text())
def sha(b): return hashlib.sha256(b).hexdigest()
def dump(x): return json.dumps(x, ensure_ascii=False, sort_keys=True)
def now(): return datetime.datetime.now(datetime.timezone.utc).isoformat()
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-dir', required=True)
    parser.add_argument('--study-hash', required=True)
    args = parser.parse_args()
    directory = Path(args.run_dir).resolve()
    assert directory.parent == ROOT and directory.name.startswith('oph-app-'), 'invalid_output_scope'
    assert re.fullmatch(r'sha256:[a-f0-9]{64}', args.study_hash), 'invalid_study_hash'
    directory.mkdir(mode=0o700, exist_ok=True)
    with (directory/'runner.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if (directory/'aggregate.json').exists():
            existing = read(directory/'aggregate.json')
            assert existing['study_hash'] == args.study_hash, 'study_changed'
            print(dump(existing)); return 0 if existing['status'] == 'completed' else 2
        assert not list((directory/'calls').glob('*.meta.json')), 'incomplete_run_requires_state_reconciliation_no_retry'
        source = PRIOR/'qwen_engineering_runner.py'
        assert sha(source.read_bytes()) == RUNNER_HASH, 'runner_source_changed'
        spec = importlib.util.spec_from_file_location('bounded_runner', source)
        m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
        m.D = directory
        prior = read(PRIOR/'run_receipt.json')
        assert prior['status'] == 'completed_natural_stop' and prior['total_call_attempts'] == 47, 'prior_state_changed'
        m.PRIOR_CALLS = prior['total_call_attempts']; m.PRIOR_TOKENS = prior['total_tokens']
        m.PRIOR_RECEIPT = {'path': str(PRIOR/'run_receipt.json'), 'sha256': sha((PRIOR/'run_receipt.json').read_bytes())}
        assert m.PRIOR_CALLS + 2 <= 60, 'budget_exceeded'
        inputs = read(PRIOR/'deidentified_model_inputs.json')
        manifest = read(PRIOR/'dataset_manifest.json')
        assert [sha(dump(x).encode()) for x in inputs] == manifest['payload_sha256'], 'frozen_inputs_changed'
        item = inputs[0]
        refs = {k: m.S/v for k,v in m.read_refs().items()}
        assert all(sha(p.read_bytes()) == manifest['source_file_hashes'][k] for k,p in refs.items()), 'source_changed'
        parent = refs['parent_prompt'].read_text() + '\n\n' + refs['output_contract'].read_text()
        checklist_manifest = read(refs['checklist']); checklist = m.S/checklist_manifest['canonical_checklist_path']
        assert sha(checklist.read_bytes()) == checklist_manifest['canonical_checklist_sha256'], 'checklist_changed'
        addresses = sorted({x[4][0] for x in socket.getaddrinfo('dashscope.aliyuncs.com', 443, socket.AF_INET, socket.SOCK_STREAM)})
        m.write(directory/'dns_snapshot.json', {'host':'dashscope.aliyuncs.com','addresses':addresses,'resolved_at':now()})
        credential = None
        for line in (SOURCE/'aaa.env').read_text().splitlines():
            line = line.strip().removeprefix('export ')
            if '=' in line and line.split('=',1)[0].strip() == 'BAILIAN_API_KEY':
                values = shlex.split(line.split('=',1)[1].strip(), comments=True)
                if len(values) == 1: credential = values[0]
        assert credential and len(credential)>10, 'credential_missing'
        os.environ['BAILIAN_API_KEY'] = credential
        (directory/'calls').mkdir(exist_ok=True)
        m.opener = m.CurlTransport()
        r = m.Runner.__new__(m.Runner)
        r.inputs = [item]; r.refs = refs; r.jschema = read(refs['judge_schema'])
        r.state = {'run_id':directory.name,'status':'prepared','started_at':now(),'study_hash':args.study_hash,'execution_channel':'oph native ssh_run_command; real Bailian Qwen','formal_backend_claim':False,'clinical_validation_claim':False,'runner_sha256':RUNNER_HASH,'app_smoke_sha256':sha(Path(__file__).read_bytes()),'stages':{'prepare':'completed','generation':'not_executed','judging':'not_executed','aggregate':'not_executed'}}
        configuration = {'study_hash':args.study_hash,'selection':'first frozen task, repeated software execution smoke; not a new independent clinical sample','task_count':1,'prior_total_attempts':47,'max_new_attempts':2,'cumulative_limit':60,'max_tokens':4096,'concurrency':1,'auto_retries':0,'models':{'generator':m.ROLES['generator'],'judge':m.ROLES['judge']},'endpoint':m.BASE,'input_hash':sha(dump(item).encode()),'prior_receipt':m.PRIOR_RECEIPT,'runner_sha256':RUNNER_HASH,'authorization_source':'User requested using oph software through the full research workflow, preserving the existing 60-call budget','signature_status':'no_formal_signature'}
        m.write(directory/'experiment_spec.json', configuration)
        m.write(directory/'dataset_manifest.json', {'task_count':1,'payload_sha256':[configuration['input_hash']],'prior_manifest_sha256':sha((PRIOR/'dataset_manifest.json').read_bytes()),'deidentified':True,'original_data_unchanged':True})
        (directory/'study_protocol.md').write_text('# oph software-originated live smoke\n\nOne frozen task, one generator and one independent-context judge, Bailian Qwen only. At most two new attempts, no retries. Preserve all outcomes, including failure. This validates software execution, not clinical effectiveness. Study: '+args.study_hash+'\n')
        (directory/'frozen_runner.py').write_bytes(source.read_bytes())
        try:
            with (directory/'run.log').open('a') as log, contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
                r.stage('generation','running')
                report = r.call('app_gen_01','generator',parent,item,True)
                r.stage('generation','completed'); r.stage('judging','running')
                payload = {'judge_task_id':item['task_id'],'checklist_version':'clinical_checklist_v1.3_frozen','frozen_clinical_checklist':checklist.read_text(),'required_output_schema':r.jschema,'report':report,'deidentified_inputs':item}
                prompt = refs['judge_prompt'].read_text() + '\n为遵守输出预算，各 rationale、report_excerpt、evidence_reference 只写必要短句（各不超过30字），overall_evidence_summary不超过60字。'
                raw = r.call('app_judge_01','judge',prompt,payload,True,True)
                verdict = m.parse_json(raw); m.validate_judgment(verdict,item['task_id'],r.jschema)
                r.stage('judging','completed')
                r.state['summary'] = r.aggregate([report],[verdict]); r.stage('aggregate','completed')
                r.state['status'] = 'completed'
        except Exception as error:
            r.state.update(status='blocked', error_class=type(error).__name__)
        r.state['finished_at'] = now(); r.persist()
        metas = [read(p) for p in (directory/'calls').glob('*.meta.json')]
        output = {'schema_version':'oph_ssh_engineering_aggregate_v1','run_id':directory.name,'study_hash':args.study_hash,'execution_channel':r.state['execution_channel'],'status':r.state['status'],'new_call_attempts':len(metas),'new_call_successes':sum(x['status']=='completed' for x in metas),'total_call_attempts':r.state['total_call_attempts'],'new_known_tokens':sum(x.get('usage',{}).get('total_tokens',0) for x in metas),'cumulative_known_tokens':r.state['total_tokens'],'models':dict(collections.Counter(x.get('returned_model','unknown') for x in metas)),'summary':r.state.get('summary'),'source_input_sha256':configuration['input_hash'],'receipt_sha256':sha((directory/'run_receipt.json').read_bytes()),'runner_sha256':RUNNER_HASH,'app_smoke_sha256':r.state['app_smoke_sha256'],'formal_backend_claim':False,'clinical_validation_claim':False,'automatic_retries':0,'limitations':['Repeated first task, not an additional independent patient','Model judgment is not clinical validation','Prior unknown provider billing remains unknown']}
        m.write(directory/'aggregate.json',output)
        print(dump(output)); return 0 if output['status']=='completed' else 2
if __name__ == '__main__': sys.exit(main())
