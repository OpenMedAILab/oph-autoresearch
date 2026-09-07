"""Bounded, resumable AntiVEGF engineering test. All case content stays on the SSH host."""
import collections, datetime, fcntl, hashlib, json, os, pathlib, re, signal, socket, sys, time, urllib.request, urllib.error
import jsonschema, subprocess
S=pathlib.Path('/data1/20251113/AntiVEGF2025KaiJ/project/AntiVEGF_Prompt_Self_Evolving')
D=pathlib.Path('/data1/20251113/AntiVEGF/oph-qwenonly-devtest-20260907-repair-v2')
PREV=D.parent/'oph-qwenonly-devtest-20260907'
PRIOR_CALLS=5
PRIOR_TOKENS=493
PRIOR_RECEIPT=None
AUTHORIZATION_TEXT='那就解决存在的问题，让它可以推进实验'
TERMINAL_STATUSES=('completed_natural_stop','completed_gate_rejection','completed_single_round','completed_budget_stop')
BASE='https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
ROLES={'generator':'qwen3.7-plus','judge':'qwen3.7-max','optimizer':'qwen3.7-plus-2026-05-26','gate':'qwen-max','judge2':'qwen-plus'}
IDS=[f'{d}{n}' for d,k in [('A',7),('B',4),('C',6),('D',5)] for n in range(1,k+1)]
HEADINGS=[f'## {a}. {b}' for a,b in zip('ABCDEFG',['基本信息','当前检查','当前检查所见','与既往比较','临床判断','随访与治疗建议','证据不足或限制'])]
STAGES=['prepare','parent_generation','parent_judging','parent_aggregate','optimizer','semantic_gate','candidate_generation','candidate_judging','secondary_judging','final_aggregate']
def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def sha(b):return hashlib.sha256(b if isinstance(b,bytes) else b.encode()).hexdigest()
def dump(x):return json.dumps(x,ensure_ascii=False,sort_keys=True)
def write(path,obj):
    tmp=path.with_suffix(path.suffix+'.tmp');tmp.write_text(json.dumps(obj,ensure_ascii=False,indent=2));os.replace(tmp,path)
def read(path):return json.loads(path.read_text())
def log(**x):print(dump(dict(time=now(),**x)),flush=True)
def load_lines(p):return [json.loads(l) for l in p.read_text().splitlines() if l.strip()]
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*a,**k):return None
opener=urllib.request.build_opener(NoRedirect)
original_resolve=socket.getaddrinfo
socket.getaddrinfo=lambda host,port,family=0,type=0,proto=0,flags=0: original_resolve(host,port,socket.AF_INET,type,proto,flags)

class CurlReply:
    def __init__(self,data,status):self.data=data;self.status=status
    def __enter__(self):return self
    def __exit__(self,*args):pass
    def read(self):return self.data
class CurlTransport:
    def open(self,req,timeout):
        # Credentials enter curl through stdin; never command-line arguments or local output.
        config='url = "'+BASE+'"\nheader = "Content-Type: application/json"\nheader = "Authorization: '+req.get_header('Authorization')+'"\n'
        request_file=D/'active_http_request.json';response_file=D/'active_http_response.json'
        request_file.write_bytes(req.data);request_file.chmod(0o600)
        dns=read(D/'dns_snapshot.json');assert dns['host']=='dashscope.aliyuncs.com' and dns['addresses'],'dns_snapshot_invalid'
        resolved='dashscope.aliyuncs.com:443:'+','.join(dns['addresses'])
        result=subprocess.run(['curl','-4','--resolve',resolved,'--silent','--show-error','--config','-','--data-binary','@'+str(request_file),'--connect-timeout','10','--max-time','150','--retry','0','--output',str(response_file),'--write-out','%{http_code}'],input=config.encode(),capture_output=True,timeout=160)
        (D/'last_transport_diagnostic.json').write_text(dump({'curl_exit':result.returncode,'http':result.stdout.decode().strip(),'stderr':result.stderr.decode(),'at':now()}))
        if result.returncode:raise ConnectionError('curl_exit_'+str(result.returncode))
        status=int(result.stdout.decode().strip())
        if status!=200:raise urllib.error.HTTPError(BASE,status,'provider_http_error',None,None)
        return CurlReply(response_file.read_bytes(),status)

def validate_judgment(x,task_alias,schema):
    jsonschema.validate(x,schema)
    assert x['judge_task_id']==task_alias,'judge_task_identity_mismatch'
    assert [i['item_id'] for i in x['items']]==IDS,'judge_item_order_or_duplicates'
    assert all(i['critical_safety_failure']==(i['item_id'] in ['D1','D2','D3','D4'] and i['score']=='fail') for i in x['items']),'critical_flag_inconsistent'

def raw_json(text):
    t=text.strip()
    if t.startswith('```') and t.endswith('```'):t='\n'.join(t.splitlines()[1:-1])
    return json.loads(t)

def parse_json(text):
    parsed=raw_json(text)
    # One explicit spelling alias; never invent a missing rationale or alter scores.
    if isinstance(parsed,dict) and isinstance(parsed.get('items'),list):
        for item in parsed['items']:
            if isinstance(item,dict) and 'reasonale' in item and 'rationale' not in item:
                item['rationale']=item.pop('reasonale')
    return parsed

def check_report(text):
    return text.startswith('# 随访报告') and '```' not in text and all(text.count(h)==1 for h in HEADINGS) and [text.index(h) for h in HEADINGS]==sorted(text.index(h) for h in HEADINGS)

IDENTITY_LABEL=re.compile(r'姓名|住院号|病案号|联系电话|身份证号')
IDENTITY_CLAUSE=re.compile(r'(?:姓名|住院号|病案号|联系电话|身份证号)["\s]*[:：=]\s*[^,，\n;；。]*')
DIRECT_NUMBER=re.compile(r'(?<!\d)1[3-9]\d{9}(?!\d)|(?<!\d)\d{17}[\dXx](?!\d)')
def redact_identity(x,counts):
    if isinstance(x,dict):
        out={}
        for k,v in x.items():
            if IDENTITY_LABEL.fullmatch(k.strip()):counts['removed_identity_fields']+=1
            else:out[k]=redact_identity(v,counts)
        return out
    if isinstance(x,list):return [redact_identity(v,counts) for v in x]
    if isinstance(x,str):
        x,n=IDENTITY_CLAUSE.subn('[身份字段已移除]',x);counts['removed_identity_clauses']+=n
        x,n=DIRECT_NUMBER.subn('[身份号码已移除]',x);counts['removed_direct_numbers']+=n
    return x

def build_inputs(tasks,ev,led):
    outputs=[]
    for idx,t in enumerate(tasks,1):
        assert t['governance']['deidentified'] is True,'source_not_deidentified'
        assert t['governance']['future_information_audit_passed'] is True,'future_audit_not_passed'
        limit=t['index_relative_day']
        events=[t['current_event']]+t['prior_events']
        assert all(e['relative_day']<=limit for e in events),'future_event'
        evidence=[e for e in ev if e['task_id']==t['task_id']]
        ledger=[l for l in led if l['task_id']==t['task_id']]
        assert evidence and len(ledger)==1,'input_coverage'
        assert all(e['event_relative_day']<=limit for e in evidence),'future_evidence'
        rename={t['task_id']:f'T{idx:03d}',t['patient_uid']:'subject',t['timepoint_uid']:'current_timepoint'}
        for j,e in enumerate(events,1):
            rename[e['event_uid']]=f'E{j:03d}'
            for k,a in enumerate(e['assets'],1):rename[a['asset_id']]=f'E{j:03d}A{k:03d}'
        for j,e in enumerate(ledger[0]['evidence_entries'],1):rename[e['evidence_id']]=f'R{j:03d}'
        clinical={k:t[k] for k in ['clinical_context','diagnosis_context','index_relative_day','injection_reference','laterality_confidence','laterality_conflict_status','laterality_source','treatment_eye']}
        compact_events=[{k:e[k] for k in ['event_uid','relative_day','role','modalities']} for e in events]
        compact_evidence=[{k:e[k] for k in ['event_relative_day','event_role','event_uid','images']} for e in evidence]
        ledger_clean={k:ledger[0][k] for k in ['evidence_entries','laterality_reference','visible_history_context']}
        for entry in ledger_clean['evidence_entries']:entry['reader_id']='frozen_reader'
        counts=collections.Counter()
        raw=dump(redact_identity({'task_id':f'T{idx:03d}','clinical_context':clinical,'visible_events':compact_events,'cached_text_evidence':compact_evidence,'reference_ledger':ledger_clean},counts))
        log(input_index=idx,privacy_redaction_counts=dict(counts))
        for old,new in sorted(rename.items(),key=lambda p:-len(p[0])):
            if old:raw=raw.replace(old,new)
        assert all(not old or old not in raw for old in rename if len(old)>4),'identifier_remaining'
        assert not re.search(r'(?<!\d)1[3-9]\d{9}(?!\d)|(?<!\d)\d{17}[\dXx](?!\d)',raw),'direct_identifier_pattern'
        assert not re.search(r'(姓名|住院号|病案号|联系电话|身份证号)[\"\s]*[:：=]\s*[^,，\n]{2,}',raw),'direct_identifier_label'
        assert 'relative_path' not in raw and 'source_asset_sha256' not in raw and 'patient_uid' not in raw,'disallowed_payload_field'
        outputs.append(json.loads(raw))
    return outputs

class Runner:
    def __init__(self):
        D.mkdir(parents=True,exist_ok=True)
        self.lock=open(D/'runner.lock','w');fcntl.flock(self.lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        (D/'calls').mkdir(exist_ok=True)
        self.state=read(D/'run_receipt.json') if (D/'run_receipt.json').exists() else {'schema_version':'qwen_engineering_receipt_v2','run_id':D.name,'created_at':now(),'stages':{s:'not_executed' for s in STAGES},'prior_probe_calls':5,'prior_probe_tokens':493,'execution_channel':'test controller via SSH; application coordinates preparation and independent review','formal_backend_claim':False,'clinical_validation_claim':False}
        self.cfg=read(PREV/'experiment_config.json')
        self.refs={k:S/v for k,v in read_refs().items()}
        self.frozen=read(self.refs['checklist'])
        self.checklist=S/self.frozen['canonical_checklist_path']
        assert sha(self.checklist.read_bytes())==self.frozen['canonical_checklist_sha256'],'checklist_hash_mismatch'
        self.checktext=self.checklist.read_text()
        assert re.findall(r'^\| ([A-D]\d+)\.',self.checktext,re.M)==IDS,'canonical_checklist_not_22'
        self.parent_seed=self.refs['parent_prompt'].read_text()
        self.contract=self.refs['output_contract'].read_text()
        self.parent=self.parent_seed+'\n\n'+self.contract
        assert len(self.parent)<6000,'parent_system_budget'
        self.jschema=read(self.refs['judge_schema'])
    def persist(self):
        calls=[read(p) for p in (D/'calls').glob('*.meta.json')]
        self.state.update(updated_at=now(),prior_total_call_attempts=PRIOR_CALLS,prior_known_total_tokens=PRIOR_TOKENS,prior_receipt=PRIOR_RECEIPT,new_call_attempts=len(calls),total_call_attempts=PRIOR_CALLS+len(calls),new_call_successes=sum(x.get('status')=='completed' for x in calls),total_tokens=PRIOR_TOKENS+sum(x.get('usage',{}).get('total_tokens',0) for x in calls),patient_derived_call_attempts=sum(x.get('patient_derived',False) for x in calls),role_counts=dict(collections.Counter(x['role'] for x in calls)))
        write(D/'run_receipt.json',self.state)
    def stage(self,s,status):self.state['stages'][s]=status;self.persist();log(stage=s,status=status,calls=self.state['total_call_attempts'])
    def call(self,key,role,system,user,patient=False,structured=False):
        model=ROLES[role];meta=D/'calls'/f'{key}.meta.json';body=D/'calls'/f'{key}.response.json'
        payload={'model':model,'messages':[{'role':'system','content':system},{'role':'user','content':dump(user)}],'max_tokens':4096,'temperature':0,'stream':False}
        if model.startswith('qwen3.7'):payload['enable_thinking']=False
        if structured:payload['response_format']={'type':'json_object'}
        fingerprint=sha(dump(payload))
        if meta.exists():
            receipt=read(meta)
            assert receipt['request_sha256']==fingerprint,'resume_request_changed'
            assert receipt['status']=='completed' and body.exists(),'existing_call_state_unknown_or_failed_no_blind_retry'
            cached=read(body)
            assert sha(dump(cached))==receipt.get('response_sha256'),'cached_response_hash_mismatch'
            if structured:
                parsed_file=D/'calls'/f'{key}.parsed.json'
                assert parsed_file.exists(),'cached_parsed_response_missing'
                assert sha(dump(read(parsed_file)))==receipt.get('parsed_sha256'),'cached_parsed_hash_mismatch'
                assert read(parsed_file)==parse_json(cached['choices'][0]['message']['content']),'cached_parse_mismatch'
            return cached['choices'][0]['message']['content']
        assert PRIOR_CALLS+len(list((D/'calls').glob('*.meta.json')))<60,'call_budget_exceeded'
        keyvalue=os.environ.get('BAILIAN_API_KEY');assert keyvalue,'credential_missing'
        receipt={'key':key,'role':role,'patient_derived':patient,'requested_model':model,'endpoint':BASE,'request_sha256':fingerprint,'status':'started','started_at':now(),'max_tokens':4096,'stage':key,'system_sha256':sha(system),'user_sha256':sha(dump(user)),'parse_validation':'pending','attempt_number':PRIOR_CALLS+1+len(list((D/'calls').glob('*.meta.json'))),'fallback':False}
        write(meta,receipt);self.persist();write(D/'calls'/f'{key}.request.json',payload)
        t=time.monotonic()
        try:
            req=urllib.request.Request(BASE,data=dump(payload).encode(),headers={'Authorization':'Bearer '+keyvalue,'Content-Type':'application/json'})
            def alarm(*args):raise TimeoutError('request_wall_deadline')
            previous=signal.signal(signal.SIGALRM,alarm);signal.alarm(150)
            try:
                with opener.open(req,timeout=90) as response:
                    result=json.loads(response.read());receipt['http']=response.status
            finally:signal.alarm(0);signal.signal(signal.SIGALRM,previous)
            write(body,result)
            receipt.update(returned_model=result.get('model'),usage=result.get('usage',{}),response_sha256=sha(dump(result)),finish_reason=result['choices'][0].get('finish_reason'))
            assert receipt['returned_model']==model,'returned_model_mismatch'
            assert receipt['finish_reason']=='stop','incomplete_generation'
            assert receipt['usage'].get('completion_tokens',0)<=4096,'provider_output_limit_exceeded'
            assert result['choices'][0]['message'].get('content'),'empty_content'
            receipt['status']='completed'
            content=result['choices'][0]['message']['content']
            if role=='generator':receipt['parse_validation']='valid_report_format' if check_report(content) else 'invalid_report_format'
            elif structured:
                parsed=parse_json(content)
                schema=self.jschema if role in ('judge','judge2') else read(self.refs['optimizer_schema' if role=='optimizer' else 'gate_schema'])
                jsonschema.validate(parsed,schema)
                if role in ('judge','judge2'):validate_judgment(parsed,user['judge_task_id'],schema)
                receipt['parse_validation']='valid_json_schema'
                write(D/'calls'/f'{key}.parsed.json',parsed);receipt['parsed_sha256']=sha(dump(parsed))
                if dump(parsed)!=dump(raw_json(content)):receipt['parse_normalization']='reasonale_to_rationale_v1'
        except Exception as e:
            receipt.update(status='failed_or_unknown',error_class=type(e).__name__,error_code=str(e) if isinstance(e,(AssertionError,ConnectionError)) else '',http=getattr(e,'code',receipt.get('http')))
            if (D/'last_transport_diagnostic.json').exists():receipt['transport_diagnostic']=read(D/'last_transport_diagnostic.json')
            raise
        finally:
            receipt.update(finished_at=now(),latency_s=round(time.monotonic()-t,3));write(meta,receipt);self.persist();log(call=key,role=role,status=receipt['status'],http=receipt.get('http'),total_calls=self.state['total_call_attempts'])
        return result['choices'][0]['message']['content']
    def prepare(self):
        tasks=load_lines(self.refs['hard92_tasks'])[:10]
        assert len(tasks)==10,'task_count'
        self.inputs=build_inputs(tasks,load_lines(self.refs['hard92_evidence']),load_lines(self.refs['hard92_ledgers']))
        hashes={k:sha(p.read_bytes()) for k,p in self.refs.items()}
        assert hashes==self.cfg['ref_files_sha256'],'source_snapshot_changed'
        manifest={'schema_version':'qwen_engineering_manifest_v2','task_count':10,'source_file_hashes':hashes,'canonical_checklist_sha256':sha(self.checklist.read_bytes()),'selection_rule':'first10 frozen hard92 package rows','payload_sha256':[sha(dump(t)) for t in self.inputs],'deidentified_count':10,'future_audit_passed_count':10,'source_task_governance_modified':False,'source_governance':[{'task_index':i+1,'external_upload_authorized':t['governance']['external_upload_authorized'],'deidentified':t['governance']['deidentified']} for i,t in enumerate(tasks)]}
        auth={'record_type':'internal_run_record','signature_status':'no_formal_signature','historical_c0_authorization_not_inherited':True,'authorization_id':D.name,'source':'Current user instruction, as continuation of the disclosed bounded experiment; not an independent signed formal approval','user_instruction':'那就解决存在的问题，让它可以推进实验','prior_model_instruction':'实验设计中需要调用的模型只要走百炼调用qwen就行','scope':{'deidentified_cached_text_only':True,'generated_deidentified_reports_to_qwen_judges':True,'report_and_judgment_fulltext_stays_on_server_not_local':True,'no_images_or_patient_identifiers':True,'task_count':10,'max_total_calls_including_prior_probes':60,'max_candidate_rounds':1,'allowed_endpoint':BASE,'models':ROLES},'dataset_manifest_sha256':sha(dump(manifest))}
        config={'schema_version':'qwen_engineering_spec_v2','roles':ROLES,'limits':{'total_calls_including_prior':60,'prior_calls':5,'max_tokens':4096,'concurrency':1,'per_request_wall_seconds':150},'network':'IPv4 per-process, redirects disabled','manifest_sha256':sha(dump(manifest)),'authorization_sha256':sha(dump(auth)),'acceptance':'engineering zero-fail; not the formal clinical acceptable endpoint','source_formal_clinical_threshold':0.85,'stopping':'failure reports<5 -> natural stop; at most one candidate; no synthetic failures','canonical_checklist_sha256':sha(self.checklist.read_bytes()),'parent_system_sha256':sha(self.parent),'parent_system_characters':len(self.parent),'append_only_reference':'full baseline system text (seed + fixed output contract), byte-for-byte','optimizer_input_character_cap':6000,'fallback_policy':'disabled; no automatic HTTP retry','fallback_max':0,'failure_classes':{'content':'valid judge with any fail','report_format':'generation format invalid','undetermined':'invalid judgment, stop without trigger','infra':'request failure or unknown, stop without trigger'},'prior_total_calls':5}
        auth['user_instruction']=AUTHORIZATION_TEXT
        auth['scope']['prior_call_attempts']=PRIOR_CALLS
        config['authorization_sha256']=sha(dump(auth))
        config['limits']['prior_calls']=PRIOR_CALLS
        config['prior_total_calls']=PRIOR_CALLS
        config['prior_receipt']=PRIOR_RECEIPT
        config['stopping']+='; do not begin a candidate round unless all 32 required calls fit the remaining cumulative budget'
        for name,obj in [('dataset_manifest.json',manifest),('runtime_authorization.json',auth),('experiment_spec.json',config)]:
            path=D/name
            if path.exists() and read(path)!=obj:
                assert not list((D/'calls').glob('*.meta.json')),'frozen_configuration_changed'
                archive=D/'pre_execution_revisions';archive.mkdir(exist_ok=True)
                snapshot=archive/(name+'.'+sha(path.read_bytes())[:12]+'.json')
                if not snapshot.exists():snapshot.write_bytes(path.read_bytes())
                write(path,obj)
            elif not path.exists():write(path,obj)
        # Runtime-only authorized copies; the source cache remains unchanged and all copies stay remote.
        runtime=[]
        for t in tasks:
            z=json.loads(dump(t));z['governance'].update(external_upload_authorized=True,authorization_id=D.name,authorized_generator_ids=list(ROLES.values()));runtime.append(z)
        if not (D/'runtime_authorized_tasks.jsonl').exists():(D/'runtime_authorized_tasks.jsonl').write_text(''.join(dump(t)+'\n' for t in runtime))
        write(D/'deidentified_model_inputs.json',self.inputs)
        (D/'study_protocol.md').write_text(f'# Qwen-only bounded engineering acceptance run\n\n10 frozen development tasks; parent plus at most one append-only candidate; cumulative 60 calls including {PRIOR_CALLS} prior attempts. Stop before a candidate round when its 32 calls cannot fit the remaining budget. Clinical source input and images remain remote. New runtime authorization reflects the current user instruction; original cache unchanged. Canonical checklist Markdown, verified by its freeze manifest SHA-256, supplies the 22 items. The endpoint here is engineering zero-fail, not formal clinical validation.\n')
        (D/'experiment_spec.yaml').write_text('# JSON is a YAML 1.2 subset\n'+json.dumps(config,ensure_ascii=False,indent=2)+'\n')
        self.state.update(status='prepared',config_sha256=sha(dump(config)),dataset_manifest_sha256=sha(dump(manifest)),authorization_id=D.name,source_file_hashes=hashes,canonical_checklist_sha256=sha(self.checklist.read_bytes()),task_count=10)
        self.stage('prepare','completed')
    def generate(self,prefix,prompt):
        stage='parent_generation' if prefix=='parent' else 'candidate_generation';self.stage(stage,'running');reports=[]
        for i,item in enumerate(self.inputs,1):reports.append(self.call(f'{prefix}_gen_{i:02}', 'generator',prompt,item,True))
        self.stage(stage,'completed');return reports
    def judge(self,prefix,reports,role='judge'):
        assert len(reports)==len(self.inputs),'judging_task_count_mismatch'
        stage='parent_judging' if prefix=='parent' else 'secondary_judging' if role=='judge2' else 'candidate_judging';self.stage(stage,'running');verdicts=[]
        prompt=self.refs['judge_prompt'].read_text()+'\n为遵守输出预算，各 rationale、report_excerpt、evidence_reference 只写必要短句（各不超过30字），overall_evidence_summary不超过60字。'
        for i,(item,report) in enumerate(zip(self.inputs,reports),1):
            payload={'judge_task_id':item['task_id'],'checklist_version':'clinical_checklist_v1.3_frozen','frozen_clinical_checklist':self.checktext,'required_output_schema':self.jschema,'report':report,'deidentified_inputs':item}
            text=self.call(f'{prefix}_{role}_{i:02}',role,prompt,payload,True,True)
            verdict=parse_json(text);validate_judgment(verdict,item['task_id'],self.jschema);verdicts.append(verdict)
        self.stage(stage,'completed');return verdicts
    def aggregate(self,reports,verdicts):
        assert len(reports)==len(verdicts)==len(self.inputs),'aggregate_task_count_mismatch'
        counts=collections.Counter();failure=0;critical=0;parsefails=0
        for report,v in zip(reports,verdicts):
            failed=[i['item_id'] for i in v['items'] if i['score']=='fail'];counts.update(failed)
            valid=check_report(report);parsefails+=not valid;failure+=bool(failed) or not valid;critical+=any(i['critical_safety_failure'] for i in v['items'])
        return {'tasks':len(reports),'engineering_zero_fail_reports':len(reports)-failure,'failure_reports':failure,'report_format_failures':parsefails,'critical_failure_reports':critical,'failed_item_counts':dict(counts)}
    def run(self):
        if self.state.get('status') in TERMINAL_STATUSES:
            return
        self.prepare();self.state.update(status='running',started_at=self.state.get('started_at',now()),runner_sha256=sha(pathlib.Path(__file__).read_bytes()),python_version=sys.version.split()[0]);self.state.pop('finished_at',None);self.state.pop('error_class',None);self.state.pop('error_code',None);self.persist()
        reports=self.generate('parent',self.parent);verdicts=self.judge('parent',reports)
        summary=self.aggregate(reports,verdicts);self.state['parent_summary']=summary;self.stage('parent_aggregate','completed')
        if summary['failure_reports']<5:self.state.update(status='completed_natural_stop',stop_reason='parent_failures_below_5');self.persist();return
        if self.state['total_call_attempts']+32>60:
            self.state.update(status='completed_budget_stop',stop_reason='insufficient_budget_for_complete_candidate_round');self.persist();return
        patterns=[{'item_id':k,'count':v,'checklist_row':next(line for line in self.checktext.splitlines() if line.startswith('| '+k+'.'))} for k,v in sorted(summary['failed_item_counts'].items(),key=lambda x:(-x[1],x[0]))[:2]]
        self.stage('optimizer','running');oschema=read(self.refs['optimizer_schema'])
        payload={'candidate_id':'candidate_v1','parent_prompt_id':'seed3_clinical_task_only_v1.1_cn','parent_prompt':self.parent,'error_patterns':patterns,'allowed_strategies':['evidence_binding','current_history_separation','treatment_eye_binding','uncertainty_handling','safe_management'],'required_output_schema':oschema,'limits':{'append_only':True,'max_added_chinese_characters':200,'max_nonempty_lines':6}}
        assert len(dump(payload))<=6000,'optimizer_payload_too_large'
        candidate=parse_json(self.call('optimizer_01','optimizer',self.refs['optimizer_prompt'].read_text(),payload,False,True));jsonschema.validate(candidate,oschema)
        assert candidate['candidate_id']=='candidate_v1' and candidate['parent_prompt_id']==payload['parent_prompt_id'],'candidate_identity'
        cp=candidate['full_prompt'];assert cp.startswith(self.parent),'candidate_not_append_only'
        addition=cp[len(self.parent):];assert len(re.findall(r'[\u4e00-\u9fff]',addition))<=200 and len([l for l in addition.splitlines() if l.strip()])<=6,'candidate_growth_limit'
        assert not re.search(r'白名单|逐行扫描|schema|JSON|字段|程序|代码|gate|checklist|核对表|缓存|离线|数据集|工程',addition,re.I),'candidate_gaming_language'
        self.stage('optimizer','completed');self.stage('semantic_gate','running')
        gate=parse_json(self.call('gate_01','gate',self.refs['gate_prompt'].read_text(),{'parent_prompt':self.parent,'candidate_prompt':cp,'addition':addition,'target_error_patterns':patterns,'hard_rule_audit':'pass','required_output_schema':read(self.refs['gate_schema'])},False,True));jsonschema.validate(gate,read(self.refs['gate_schema']))
        if gate['decision']=='pass':
            assert gate['recommended_action']=='accept_for_candidate_evaluation' and not gate['failure_reason'] and all(value=='pass' for name,value in gate['checks'].items() if name!='behavioral_drift_risk'),'inconsistent_gate_acceptance'
        self.stage('semantic_gate','completed');self.state['gate_decision']=gate['decision']
        if gate['decision']!='pass':self.state.update(status='completed_gate_rejection',stop_reason='semantic_gate_rejected');self.persist();return
        cr=self.generate('candidate',cp);cj=self.judge('candidate',cr);c2=self.judge('candidate',cr,'judge2')
        assert all(read(D/'calls'/f'parent_gen_{i:02}.meta.json')['user_sha256']==read(D/'calls'/f'candidate_gen_{i:02}.meta.json')['user_sha256'] for i in range(1,11)),'paired_input_mismatch'
        self.state.update(paired_input_hashes_identical=True,candidate_summary=self.aggregate(cr,cj),secondary_summary=self.aggregate(cr,c2),status='completed_single_round',stop_reason='one_candidate_round_limit')
        self.stage('final_aggregate','completed')

def read_refs():
    # Match the original preparation's immutable source inventory.
    import ast
    tree=ast.parse((PREV/'qwenonly_prep.py').read_text())
    return next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='refs' for t in n.targets))

if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-dir',required=True,help='Explicit remote output directory; never overwrite a completed experiment.')
    parser.add_argument('--prepare-only',action='store_true')
    parser.add_argument('--prior-receipt',help='Completed prior run receipt used to carry forward all attempts and known usage.')
    parser.add_argument('--authorization-text',help='Current user instruction authorizing this bounded run.')
    args=parser.parse_args()
    D=pathlib.Path(args.run_dir).resolve()
    if (D/'run_receipt.json').exists() and read(D/'run_receipt.json').get('status') in TERMINAL_STATUSES:
        log(status='already_completed',run_dir=str(D));sys.exit(0)
    if not args.prior_receipt or not args.authorization_text:parser.error('new or incomplete runs require --prior-receipt and --authorization-text')
    prior_path=pathlib.Path(args.prior_receipt).resolve();prior=read(prior_path)
    assert prior_path.parent!=D and prior.get('status') in TERMINAL_STATUSES,'prior_run_not_completed'
    PRIOR_CALLS=prior['total_call_attempts'];PRIOR_TOKENS=prior['total_tokens']
    assert type(PRIOR_CALLS) is int and 0<=PRIOR_CALLS<60,'invalid_prior_budget'
    PRIOR_RECEIPT={'path':str(prior_path),'sha256':sha(prior_path.read_bytes())}
    AUTHORIZATION_TEXT=args.authorization_text
    opener=CurlTransport()
    r=Runner()
    try:
        if args.prepare_only:r.prepare()
        else:r.run()
    except Exception as e:
        r.state.update(status='blocked',error_class=type(e).__name__,error_code=str(e) if isinstance(e,AssertionError) else 'see_remote_logs',finished_at=now());r.persist();log(status='blocked',error_class=type(e).__name__,error_code=r.state['error_code']);sys.exit(1)
    r.state['finished_at']=now();r.persist();log(status=r.state['status'],total_calls=r.state['total_call_attempts'],total_tokens=r.state['total_tokens'])
