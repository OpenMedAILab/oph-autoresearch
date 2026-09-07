"""Offline tests: real wrapper orchestration, synthetic inputs and no provider I/O."""
import contextlib, io, json, os, pathlib, tempfile, types, unittest
from unittest.mock import patch
import app_smoke as w

class SmokeTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root=pathlib.Path(self.tmp.name).resolve(); self.prior=self.root/'prior';self.prior.mkdir()
        self.source=self.root/'source';self.source.mkdir();self.run=self.root/'oph-app-test'
        self.study='sha256:'+'a'*64; self.calls=[]; self.fail=False
        def write(p,x):p.write_text(json.dumps(x))
        write(self.prior/'run_receipt.json',{'status':'completed_natural_stop','total_call_attempts':47,'total_tokens':100})
        (self.prior/'qwen_engineering_runner.py').write_text('frozen fake module')
        (self.source/'aaa.env').write_text('BAILIAN_API_KEY=synthetic_test_only')
        inputs=[{'task_id':'synthetic'}];write(self.prior/'deidentified_model_inputs.json',inputs)
        refs={k:k+'.json' for k in ['parent_prompt','output_contract','judge_schema','judge_prompt','checklist']}
        for k,p in refs.items():write(self.source/p,{} if k=='judge_schema' else 'synthetic')
        (self.source/'check.md').write_text('synthetic checklist')
        write(self.source/refs['checklist'],{'canonical_checklist_path':'check.md','canonical_checklist_sha256':w.sha((self.source/'check.md').read_bytes())})
        write(self.prior/'dataset_manifest.json',{'payload_sha256':[w.sha(w.dump(x).encode()) for x in inputs],'source_file_hashes':{k:w.sha((self.source/p).read_bytes()) for k,p in refs.items()}})
        outer=self
        class Runner:
            def stage(s,k,v):s.state['stages'][k]=v
            def call(s,key,role,*a):
                outer.calls.append(role);write(m.D/'calls'/(key+'.meta.json'),{'status':'failed' if outer.fail else 'completed','returned_model':m.ROLES[role],'usage':{'total_tokens':3}})
                if outer.fail:raise TimeoutError('synthetic failure')
                return '{}'
            def aggregate(s,*a):return {'tasks':len(s.inputs),'failure_reports':0}
            def persist(s):
                s.state.update(total_call_attempts=m.PRIOR_CALLS+len(outer.calls),total_tokens=m.PRIOR_TOKENS+3*len(outer.calls));write(m.D/'run_receipt.json',s.state)
        m=types.SimpleNamespace(S=self.source,read_refs=lambda:refs,write=write,Runner=Runner,CurlTransport=lambda:object(),ROLES={'generator':'qwen-test-g','judge':'qwen-test-j'},BASE='synthetic',parse_json=json.loads,validate_judgment=lambda *a:None)
        loader=types.SimpleNamespace(exec_module=lambda x:None)
        for p in [patch.object(w,'ROOT',self.root),patch.object(w,'PRIOR',self.prior),patch.object(w,'SOURCE',self.source),patch.object(w,'RUNNER_HASH',w.sha((self.prior/'qwen_engineering_runner.py').read_bytes())),patch.object(w.importlib.util,'spec_from_file_location',return_value=types.SimpleNamespace(loader=loader)),patch.object(w.importlib.util,'module_from_spec',return_value=m),patch.object(w.socket,'getaddrinfo',return_value=[(None,None,None,None,('1.1.1.1',443))]),patch.dict(os.environ,{})]:p.start();self.addCleanup(p.stop)
    def invoke(self):
        out=io.StringIO()
        with patch('sys.argv',['app_smoke','--run-dir',str(self.run),'--study-hash',self.study]),contextlib.redirect_stdout(out):code=w.main()
        return code,json.loads(out.getvalue())
    def test_complete_and_repeat_has_no_new_calls(self):
        code,result=self.invoke();self.assertEqual(code,0);self.assertEqual(self.calls,['generator','judge']);self.assertEqual(result['total_call_attempts'],49)
        self.assertEqual(self.invoke(),(code,result));self.assertEqual(len(self.calls),2)
    def test_failure_stops_and_cannot_retry(self):
        self.fail=True;code,result=self.invoke();self.assertEqual(code,2);self.assertEqual(self.calls,['generator']);self.assertEqual(result['total_call_attempts'],48)
        self.assertEqual(self.invoke(),(code,result));self.assertEqual(len(self.calls),1)
    def test_changed_input_fails_before_calls(self):
        (self.prior/'deidentified_model_inputs.json').write_text('[{"task_id":"changed"}]')
        with self.assertRaisesRegex(AssertionError,'frozen_inputs_changed'):self.invoke()
        self.assertEqual(self.calls,[])
    def test_unreconciled_attempt_fails_before_calls(self):
        (self.run/'calls').mkdir(parents=True);(self.run/'calls'/'old.meta.json').write_text('{}')
        with self.assertRaisesRegex(AssertionError,'incomplete_run'):self.invoke()
        self.assertEqual(self.calls,[])
if __name__=='__main__':unittest.main()
