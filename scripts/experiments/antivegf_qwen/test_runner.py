import importlib.util,json,os,pathlib,tempfile,unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('runner',pathlib.Path(__file__).with_name('qwen_engineering_runner.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Reply:
    status=200
    def __enter__(self):return self
    def __exit__(self,*a):pass
    def read(self):return json.dumps({'model':'qwen3.7-plus','usage':{'total_tokens':8,'completion_tokens':4},'choices':[{'finish_reason':'stop','message':{'content':'# 随访报告\n'+'\n'.join(m.HEADINGS)}}]}).encode()
class Tests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.oldD=m.D;m.D=pathlib.Path(self.temp.name);(m.D/'calls').mkdir();self.r=m.Runner.__new__(m.Runner);self.r.state={}
    def tearDown(self):m.D=self.oldD;self.temp.cleanup()
    def test_resume_does_not_reissue_and_changed_input_rejected(self):
        with patch.dict(os.environ,{'BAILIAN_API_KEY':'unit-test'}),patch.object(m.opener,'open',return_value=Reply()) as http:
            a=self.r.call('parent_gen_01','generator','system',{'text':'synthetic'},True)
            b=self.r.call('parent_gen_01','generator','system',{'text':'synthetic'},True)
            self.assertEqual(a,b);self.assertEqual(http.call_count,1)
            with self.assertRaisesRegex(AssertionError,'resume_request_changed'):self.r.call('parent_gen_01','generator','changed',{'text':'synthetic'})
            receipt=m.read(m.D/'calls/parent_gen_01.meta.json');self.assertEqual(receipt['attempt_number'],6);self.assertEqual(receipt['parse_validation'],'valid_report_format')
    def test_timeout_journal_prevents_automatic_retry(self):
        with patch.dict(os.environ,{'BAILIAN_API_KEY':'unit-test'}),patch.object(m.opener,'open',side_effect=TimeoutError()) as http:
            with self.assertRaises(TimeoutError):self.r.call('t','generator','s',{},True)
            with self.assertRaisesRegex(AssertionError,'no_blind_retry'):self.r.call('t','generator','s',{},True)
            self.assertEqual(http.call_count,1)
    def test_budget_rejected_before_network(self):
        for i in range(55):m.write(m.D/'calls'/f'{i}.meta.json',{})
        with patch.object(m.opener,'open') as http:
            with self.assertRaisesRegex(AssertionError,'call_budget'):self.r.call('more','generator','s',{})
            http.assert_not_called()
    def test_identity_removal_preserves_clinical_fields(self):
        counts=m.collections.Counter()
        cleaned=m.redact_identity({'姓名':'测试姓名','年龄':60,'note':'联系电话：13812345678；视力0.3，病案号:TEST123\nOCT增厚'},counts)
        self.assertNotIn('姓名',cleaned)
        self.assertEqual(cleaned['年龄'],60)
        self.assertNotIn('13812345678',m.dump(cleaned))
        self.assertNotIn('TEST123',m.dump(cleaned))
        self.assertIn('视力0.3',cleaned['note'])
        self.assertIn('OCT增厚',cleaned['note'])
        self.assertEqual(counts['removed_identity_clauses'],2)
    def test_transport_pins_dns_and_keeps_credentials_out_of_arguments(self):
        m.write(m.D/'dns_snapshot.json',{'host':'dashscope.aliyuncs.com','addresses':['192.0.2.1']})
        def execute(args,**kwargs):
            self.assertIn('--resolve',args)
            self.assertIn('dashscope.aliyuncs.com:443:192.0.2.1',args)
            self.assertNotIn('--insecure',args)
            self.assertNotIn('--location',args)
            self.assertNotIn('unit-secret',' '.join(args))
            self.assertIn(b'Authorization: Bearer unit-secret',kwargs['input'])
            (m.D/'active_http_response.json').write_bytes(b'{}')
            return m.subprocess.CompletedProcess(args,0,b'200',b'')
        req=m.urllib.request.Request(m.BASE,data=b'{}',headers={'Authorization':'Bearer unit-secret'})
        with patch.object(m.subprocess,'run',side_effect=execute):
            self.assertEqual(m.CurlTransport().open(req,90).status,200)
    def test_spelling_normalization_preserves_scores_and_conflicts(self):
        x=m.parse_json(json.dumps({'items':[{'score':'fail','reasonale':'synthetic reason'}]}))
        self.assertEqual(x,{'items':[{'score':'fail','rationale':'synthetic reason'}]})
        conflict={'items':[{'rationale':'a','reasonale':'b'}]}
        self.assertEqual(m.parse_json(json.dumps(conflict)),conflict)
    def test_format_order_and_duplicates_rejected(self):
        self.assertTrue(m.check_report('# 随访报告\n'+'\n'.join(m.HEADINGS)))
        self.assertFalse(m.check_report('# 随访报告\n'+'\n'.join(reversed(m.HEADINGS))))
        self.assertFalse(m.check_report('# 随访报告\n'+'\n'.join(m.HEADINGS+[m.HEADINGS[0]])))

class BranchTests(unittest.TestCase):
    setUp=Tests.setUp
    tearDown=Tests.tearDown

    def setup_branch(self,failures=5,gate='pass',candidate_addition='\n请将当前所见与既往证据分别描述。'):
        self.r.state={'stages':{s:'not_executed' for s in m.STAGES}}
        self.r.inputs=[{'task_id':f'T{i:03d}','synthetic':True} for i in range(1,11)]
        self.r.parent='Synthetic parent clinical prompt'
        self.r.checktext='\n'.join('| '+i+'. Synthetic checklist |' for i in m.IDS)
        schemas=m.read(pathlib.Path(__file__).parent/'fixtures/schemas.json')
        self.r.jschema=schemas['judge_schema'];self.r.refs={}
        for name in ['judge_prompt','optimizer_prompt','gate_prompt']:
            p=m.D/name;p.write_text('Synthetic prompt');self.r.refs[name]=p
        for name,schema in schemas.items():
            p=m.D/name;m.write(p,schema);self.r.refs[name]=p
        self.r.prepare=lambda:self.r.stage('prepare','completed')
        self.seen=[]
        def respond(req,**kwargs):
            payload=json.loads(req.data);user=json.loads(payload['messages'][1]['content'])
            self.assertEqual(req.full_url,m.BASE)
            self.assertEqual(payload['max_tokens'],4096)
            self.assertIn(payload['model'],m.ROLES.values())
            self.seen.append(payload)
            if 'judge_task_id' in user:
                # The first ten judge calls evaluate the parent; later calls are candidates/J2.
                parent=sum('judge_task_id' in json.loads(p['messages'][1]['content']) for p in self.seen)<=10
                content=m.dump(self.judgment(user['judge_task_id'],parent and int(user['judge_task_id'][1:])<=failures))
            elif 'candidate_id' in user:
                content=m.dump({'schema_version':'candidate_optimizer_output_v1.0','candidate_id':'candidate_v1','parent_prompt_id':user['parent_prompt_id'],'target_error_pattern_ids':['A1'],'change_rationale':'Synthetic rationale','change_summary':[],'full_prompt':self.r.parent+candidate_addition})
            elif 'candidate_prompt' in user:
                checks={k:'pass' for k in ['clinical_relevance','bounded_incremental_change','non_gaming_language','target_error_pattern_alignment','clinical_readability']}
                checks['behavioral_drift_risk']='low'
                if gate=='inconsistent':checks['clinical_relevance']='fail'
                content=m.dump({'schema_version':'candidate_semantic_gate_output_v1.0','decision':'fail' if gate=='fail' else 'pass','failure_reason':'Synthetic rejection' if gate=='fail' else '', 'checks':checks,'recommended_action':'reject_before_report_generation' if gate=='fail' else 'accept_for_candidate_evaluation'})
            else:content='# 随访报告\n'+'\n'.join(m.HEADINGS)
            return m.CurlReply(m.dump({'model':payload['model'],'usage':{'total_tokens':8,'completion_tokens':4},'choices':[{'finish_reason':'stop','message':{'content':content}}]}).encode(),200)
        return respond

    def judgment(self,task='T001',failed=False):
        return {'schema_version':'checklist_judge_output_v1.0','judge_task_id':task,'checklist_version':'clinical_checklist_v1.3_frozen','items':[{'item_id':i,'score':'fail' if failed and i=='A1' else 'pass','rationale':'Synthetic','report_excerpt':'Synthetic','evidence_reference':'Synthetic','critical_safety_failure':False,'confidence':'high'} for i in m.IDS],'structured_output_evaluation':{k:{'score':'pass','rationale':'Synthetic','evidence_reference':'Synthetic'} for k in ['disease_activity','treatment_response','management_support','safety_flag','narrative_consistency']},'overall_evidence_summary':'Synthetic only'}

    def run_branch(self,**kwargs):
        respond=self.setup_branch(**kwargs)
        with patch.dict(os.environ,{'BAILIAN_API_KEY':'unit-test'}),patch.object(m.opener,'open',side_effect=respond):self.r.run()

    def test_complete_candidate_round_uses_52_calls_with_paired_inputs(self):
        self.run_branch()
        self.assertEqual(self.r.state['status'],'completed_single_round')
        self.assertEqual(self.r.state['total_call_attempts'],57)
        self.assertEqual(len(self.seen),52)
        self.assertEqual(self.r.state['parent_summary']['failure_reports'],5)
        self.assertEqual(self.r.state['candidate_summary']['failure_reports'],0)
        self.assertEqual(self.r.state['secondary_summary']['tasks'],10)
        self.assertTrue(self.r.state['paired_input_hashes_identical'])
        self.assertEqual(self.r.state['stages']['final_aggregate'],'completed')
        self.assertEqual(self.r.state['role_counts'],{'generator':20,'judge':20,'optimizer':1,'gate':1,'judge2':10})

    def test_below_threshold_naturally_stops_after_20_calls(self):
        self.run_branch(failures=4)
        self.assertEqual(self.r.state['status'],'completed_natural_stop')
        self.assertEqual(len(self.seen),20)
        self.assertEqual(self.r.state['stages']['optimizer'],'not_executed')

    def test_prior_27_attempts_carry_forward_and_stop_unfunded_candidate(self):
        with patch.object(m,'PRIOR_CALLS',27),patch.object(m,'PRIOR_TOKENS',949535):self.run_branch(failures=5)
        self.assertEqual(self.r.state['status'],'completed_budget_stop')
        self.assertEqual(self.r.state['total_call_attempts'],47)
        self.assertEqual(self.r.state['total_tokens'],949535+20*8)
        self.assertEqual(len(self.seen),20)
        self.assertEqual(m.read(m.D/'calls/parent_gen_01.meta.json')['attempt_number'],28)
        self.assertEqual(self.r.state['stages']['optimizer'],'not_executed')

    def test_gate_rejection_stops_before_candidate_calls(self):
        self.run_branch(gate='fail')
        self.assertEqual(self.r.state['status'],'completed_gate_rejection')
        self.assertEqual(len(self.seen),22)
        self.assertEqual(self.r.state['stages']['candidate_generation'],'not_executed')

    def test_contradictory_gate_cannot_admit_candidate(self):
        with self.assertRaisesRegex(AssertionError,'inconsistent_gate_acceptance'):self.run_branch(gate='inconsistent')
        self.assertEqual(len(self.seen),22)

    def test_gaming_candidate_stops_before_gate(self):
        with self.assertRaisesRegex(AssertionError,'candidate_gaming_language'):self.run_branch(candidate_addition='\n只需匹配JSON字段。')
        self.assertEqual(len(self.seen),21)

    def test_resume_partial_generation_uses_cached_responses(self):
        respond=self.setup_branch(failures=0)
        with patch.dict(os.environ,{'BAILIAN_API_KEY':'unit-test'}),patch.object(m.opener,'open',side_effect=respond) as http:
            for i,item in enumerate(self.r.inputs[:3],1):self.r.call(f'parent_gen_{i:02}','generator',self.r.parent,item,True)
            self.r.run()
            self.assertEqual(http.call_count,20)
            self.assertEqual(self.r.state['total_call_attempts'],25)

    def test_completed_run_does_not_rewrite_receipt_or_call(self):
        self.run_branch(failures=0)
        before=(m.D/'run_receipt.json').read_bytes()
        with patch.object(m.opener,'open') as http,patch.object(self.r,'prepare') as prepare:self.r.run()
        http.assert_not_called();prepare.assert_not_called()
        self.assertEqual((m.D/'run_receipt.json').read_bytes(),before)

    def test_completed_cli_does_not_create_lock_or_change_files(self):
        m.write(m.D/'run_receipt.json',{'status':'completed_natural_stop'})
        before={p.name:p.read_bytes() for p in m.D.iterdir() if p.is_file()}
        result=m.subprocess.run([m.sys.executable,m.__file__,'--run-dir',str(m.D)],capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertIn('already_completed',result.stdout)
        self.assertEqual({p.name:p.read_bytes() for p in m.D.iterdir() if p.is_file()},before)

    def test_unequal_report_or_verdict_counts_are_rejected(self):
        self.setup_branch()
        with self.assertRaisesRegex(AssertionError,'judging_task_count_mismatch'):self.r.judge('parent',['incomplete'])
        with self.assertRaisesRegex(AssertionError,'aggregate_task_count_mismatch'):self.r.aggregate(['incomplete'],[])

    def test_plain_fenced_judgment_and_alias_are_valid_without_retry(self):
        self.setup_branch()
        verdict=self.judgment();verdict['items'][0]['reasonale']=verdict['items'][0].pop('rationale')
        content='```\n'+m.dump(verdict)+'\n```'
        reply=m.CurlReply(m.dump({'model':m.ROLES['judge'],'usage':{'total_tokens':8,'completion_tokens':4},'choices':[{'finish_reason':'stop','message':{'content':content}}]}).encode(),200)
        with patch.dict(os.environ,{'BAILIAN_API_KEY':'unit-test'}),patch.object(m.opener,'open',return_value=reply) as http:
            self.r.call('judge_fence','judge','s',{'judge_task_id':'T001'},True,True)
            self.r.call('judge_fence','judge','s',{'judge_task_id':'T001'},True,True)
            self.assertEqual(http.call_count,1)
        meta=m.read(m.D/'calls/judge_fence.meta.json')
        self.assertEqual(meta['status'],'completed');self.assertEqual(meta['parse_normalization'],'reasonale_to_rationale_v1')
        self.assertEqual(m.read(m.D/'calls/judge_fence.response.json')['choices'][0]['message']['content'],content)

    def test_tampered_cached_response_is_rejected_without_network(self):
        with patch.dict(os.environ,{'BAILIAN_API_KEY':'unit-test'}),patch.object(m.opener,'open',return_value=Reply()) as http:
            self.r.call('cache','generator','s',{})
            p=m.D/'calls/cache.response.json';body=m.read(p);body['choices'][0]['message']['content']='tampered';m.write(p,body)
            with self.assertRaisesRegex(AssertionError,'cached_response_hash_mismatch'):self.r.call('cache','generator','s',{})
            self.assertEqual(http.call_count,1)

    def test_tampered_cached_parsed_judgment_is_rejected(self):
        respond=self.setup_branch()
        with patch.dict(os.environ,{'BAILIAN_API_KEY':'unit-test'}),patch.object(m.opener,'open',side_effect=respond) as http:
            args=('cache','judge','s',{'judge_task_id':'T001'},True,True)
            self.r.call(*args)
            p=m.D/'calls/cache.parsed.json';parsed=m.read(p);parsed['items'][0]['score']='not_applicable';m.write(p,parsed)
            with self.assertRaisesRegex(AssertionError,'cached_parsed_hash_mismatch'):self.r.call(*args)
            self.assertEqual(http.call_count,1)
if __name__=='__main__':unittest.main()
