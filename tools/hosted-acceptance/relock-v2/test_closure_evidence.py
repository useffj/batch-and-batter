"""Pure synthetic fixtures. External I/O forbidden during each test."""
from dataclasses import replace, FrozenInstanceError
from copy import deepcopy
import sys
import unittest
from unittest.mock import patch
import closure_evidence as ce


def fixture():
    common = dict(schema_version=1, source='synthetic:fixture', execution_id='execution',
                  resource_id='resource', authorization_id='authorization', scope_digest='a'*64,
                  execution_version=1)
    def make(cls, eid, seq, **kw):
        return cls(evidence_id=eid, sequence=seq, **common, **kw)
    records = (
        make(ce.OperationIntent, 'intent', 1, operation_id='op', participant_id='worker', kind='ENABLE'),
        make(ce.OperationResolution, 'resolution', 2, operation_id='op', intent_ref='intent',
             outcome='COMPLETED', finality='FINAL', basis='TERMINAL_RESULT'),
        make(ce.ParticipantQuiescence, 'quiescence', 3, participant_id='worker', authority='REVOKED',
             work_state='ACCOUNTED', pending_operation_ids=(), resolution_refs=('resolution',)),
        make(ce.ExecutionInventory, 'inventory', 4, operation_ids=('op',), participant_ids=('worker',), cutoff=4),
        make(ce.DisabledObservation, 'observation', 5, configuration_id='configuration', configuration_digest='b'*64,
             revision_id='revision', update_state='SUCCESSFUL', admission='DISABLED',
             reconciled_refs=('resolution',), quiescence_refs=('quiescence',), inventory_ref='inventory'),
        make(ce.CleanupDisposition, 'cleanup', 7, observation_ref='observation', controller_result_ref='synthetic-controller-result',
             responsibility='RESOLVED', critical_codes=()),
        make(ce.ControllerResult, 'synthetic-controller-result', 6, observation_ref='observation',
             disposition='DISABLED_VERIFIED', critical_codes=()),
    )
    request = make(ce.EvaluationRequest, 'request', 8, inventory_ref='inventory', cutoff=4,
                   configuration_id='configuration', configuration_digest='b'*64)
    return request, records


class ClosureEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.request, self.records = fixture()
        for target in ('sqlite3.connect', 'socket.socket', 'socket.create_connection',
                       'subprocess.Popen', 'subprocess.run', 'os.system', 'builtins.open'):
            p = patch(target, side_effect=AssertionError('IO_FORBIDDEN'))
            p.start(); self.addCleanup(p.stop)
        p = patch.dict(sys.modules, {'boto3': None, 'botocore': None, 'stripe': None})
        p.start(); self.addCleanup(p.stop)

    def changed(self, index, **kw):
        values = list(self.records)
        values[index] = replace(values[index], **kw)
        return tuple(values)

    def blocked(self, records, code, request=None):
        result = ce.evaluate(request or self.request, records)
        self.assertEqual(result.status, 'SYNTHETIC_BLOCKED')
        self.assertIn(code, result.blocking_codes)
        return result

    def test_complete_synthetic_eligible(self):
        result = ce.evaluate(self.request, self.records)
        self.assertEqual(result.status, 'SYNTHETIC_ELIGIBLE')
        self.assertEqual(result.blocking_codes, ())
        self.assertEqual(len(result.evidence_digest), 64)

    def test_missing_required_records(self):
        for index in (3, 4, 5):
            with self.subTest(index=index):
                self.blocked(self.records[:index]+self.records[index+1:], 'REQUIRED_RECORD_COUNT')

    def test_unresolved_enable_and_timeout(self):
        for outcome, basis in [('UNKNOWN', 'TIMEOUT'), ('NOT_DISPATCHED', 'PROCESS_DEATH')]:
            self.blocked(self.changed(1, outcome=outcome, basis=basis), 'UNRESOLVED_OPERATION')

    def test_delayed_enable(self):
        self.blocked(self.changed(1, finality='MAY_COMPLETE'), 'UNRESOLVED_OPERATION')
        self.blocked(self.changed(1, sequence=8), 'OUTSIDE_CUTOFF')

    def test_conflicting_resolution(self):
        other = replace(self.records[1], evidence_id='other-resolution', sequence=8, outcome='UNKNOWN')
        self.blocked(self.records+(other,), 'MISSING_OR_CONFLICTING_RESOLUTION')

    def test_wrong_bindings(self):
        for key in ('execution_id','resource_id','authorization_id','source'):
            value = 'synthetic:other' if key == 'source' else 'other'
            self.blocked(self.changed(1, **{key: value}), 'BINDING_MISMATCH')
        self.blocked(self.changed(1, scope_digest='c'*64), 'BINDING_MISMATCH')

    def test_missing_participant(self):
        self.blocked(self.records[:2]+self.records[3:], 'PARTICIPANT_INVENTORY_MISMATCH')

    def test_participant_authority_and_work(self):
        for kw in (dict(authority='RETAINED'), dict(work_state='UNKNOWN'), dict(pending_operation_ids=('op',)),
                   dict(authority='PROCESS_DEAD')):
            self.blocked(self.changed(2, **kw), 'PARTICIPANT_NOT_QUIESCENT')

    def test_causal_ordering(self):
        self.blocked(self.changed(4, sequence=2), 'OBSERVATION_ORDER')
        self.blocked(self.changed(2, sequence=1), 'QUIESCENCE_REFERENCE_MISMATCH')
        self.blocked(self.changed(1, sequence=1), 'INVALID_RESOLUTION_REFERENCE')
        self.blocked(self.changed(5, sequence=4), 'CLEANUP_REFERENCE_MISMATCH')

    def test_identical_duplicates_idempotent(self):
        self.assertEqual(ce.evaluate(self.request, self.records), ce.evaluate(self.request, self.records+self.records))

    def test_conflicting_duplicate_rejected(self):
        self.blocked(self.records+(replace(self.records[1], outcome='UNKNOWN'),), 'CONFLICTING_EVIDENCE_ID')

    def test_stale_version(self):
        self.blocked(self.changed(1, execution_version=2), 'BINDING_MISMATCH')

    def test_cutoff_mismatch(self):
        self.blocked(self.records, 'CUTOFF_MISMATCH', replace(self.request, cutoff=5))
        self.blocked(self.changed(3, cutoff=3), 'CUTOFF_MISMATCH')

    def test_malformed_and_unknown_types(self):
        for value in ({'disabled': True}, object(), None):
            self.blocked(self.records+(value,), 'MALFORMED_EVIDENCE')
        for kw in (dict(sequence=True), dict(schema_version=2), dict(execution_id='TEST SECRET'),
                   dict(source='live'), dict(scope_digest='invalid')):
            self.blocked(self.changed(1, **kw), 'MALFORMED_EVIDENCE')
        self.blocked(self.changed(2, pending_operation_ids=[]), 'MALFORMED_EVIDENCE')
        self.assertEqual(ce.evaluate(None,self.records).status,'SYNTHETIC_BLOCKED')

    def test_historical_critical_preserved_without_acceptance(self):
        result = ce.evaluate(self.request, self.changed(5, critical_codes=('DEADLINE_MISSED',)))
        self.assertEqual(result.status, 'SYNTHETIC_ELIGIBLE')
        self.assertEqual(result.historical_critical_codes, ('DEADLINE_MISSED',))
        self.assertFalse(hasattr(result,'acceptance_passed'))
        self.assertFalse(hasattr(result,'authorized_for_release'))

    def test_repeat_order_independence_and_immutability(self):
        before = deepcopy((self.request,self.records))
        result = ce.evaluate(self.request,self.records)
        self.assertEqual(result,ce.evaluate(self.request,tuple(reversed(self.records))))
        self.assertEqual(result,ce.evaluate(self.request,self.records))
        self.assertEqual(before,(self.request,self.records))
        with self.assertRaises(FrozenInstanceError):
            self.records[0].kind='DISABLE'

    def test_inventory_missing_extra_duplicate_operations(self):
        self.blocked(self.records[1:], 'OPERATION_INVENTORY_MISMATCH')
        self.blocked(self.changed(3, operation_ids=('op','missing')), 'OPERATION_INVENTORY_MISMATCH')
        self.blocked(self.records+(replace(self.records[0], evidence_id='extra',sequence=8),), 'OPERATION_INVENTORY_MISMATCH')
        self.blocked(self.changed(3, operation_ids=('op','op')), 'MALFORMED_EVIDENCE')

    def test_guarded_observation_fields(self):
        for kw in (dict(configuration_id='other'), dict(configuration_digest='c'*64),
                   dict(update_state='PENDING'), dict(admission='ENABLED')):
            self.blocked(self.changed(4,**kw),'DISABLED_GUARD_MISMATCH')
        self.blocked(self.changed(4,revision_id=''),'MALFORMED_EVIDENCE')

    def test_evidence_references(self):
        self.blocked(self.changed(1,intent_ref='other'),'INVALID_RESOLUTION_REFERENCE')
        self.blocked(self.changed(2,resolution_refs=()),'QUIESCENCE_REFERENCE_MISMATCH')
        self.blocked(self.changed(4,quiescence_refs=()),'OBSERVATION_REFERENCE_MISMATCH')
        self.blocked(self.changed(5,observation_ref='other'),'CLEANUP_REFERENCE_MISMATCH')

    def test_cleanup_unresolved(self):
        self.blocked(self.changed(5,responsibility='UNKNOWN'),'CLEANUP_UNRESOLVED')

    def test_prevented_dispatch_resolution(self):
        result=ce.evaluate(self.request,self.changed(1,outcome='NOT_DISPATCHED',basis='DISPATCH_PREVENTED'))
        self.assertEqual(result.status,'SYNTHETIC_ELIGIBLE')

    def test_no_io_or_release_capability(self):
        self.assertEqual(ce.evaluate(self.request,self.records).status,'SYNTHETIC_ELIGIBLE')
        for name in ('sqlite3','subprocess','boto3','stripe','release','close_execution','run_hosted'):
            self.assertFalse(hasattr(ce,name))

    def test_request_order_and_identity_collision(self):
        self.blocked(self.records,'REQUEST_ORDER',replace(self.request,sequence=5))
        self.blocked(self.records,'CONFLICTING_EVIDENCE_ID',replace(self.request,evidence_id='intent'))

    def test_sanitized_failure(self):
        result=self.blocked(self.changed(5,critical_codes=('TEST SECRET',)),'MALFORMED_EVIDENCE')
        self.assertNotIn('TEST SECRET',repr(result))

    def test_controller_reference_original_bypasses_blocked(self):
        for ref in ('unrelated-controller-result', 'cleanup', 'request', 'intent'):
            with self.subTest(ref=ref):
                self.blocked(self.changed(5, controller_result_ref=ref), 'CONTROLLER_REFERENCE_MISMATCH')

    def test_missing_controller_result(self):
        self.blocked(self.records[:-1], 'CONTROLLER_REFERENCE_MISMATCH')

    def test_controller_binding_mismatches(self):
        for key, value in (('execution_id','other'), ('resource_id','other'),
                           ('authorization_id','other'), ('scope_digest','c'*64),
                           ('execution_version',2), ('source','synthetic:other')):
            with self.subTest(key=key):
                self.blocked(self.changed(6, **{key:value}), 'BINDING_MISMATCH')

    def test_controller_causal_order(self):
        self.blocked(self.changed(6, sequence=9), 'CONTROLLER_ORDER')
        self.blocked(self.changed(6, sequence=4), 'CONTROLLER_OBSERVATION_MISMATCH')
        self.blocked(self.changed(6, observation_ref='cleanup'), 'CONTROLLER_OBSERVATION_MISMATCH')

    def test_controller_conflicting_identity(self):
        self.blocked(self.records+(replace(self.records[6], disposition='UNKNOWN'),), 'CONFLICTING_EVIDENCE_ID')
        self.blocked(self.records+(replace(self.records[6], evidence_id='another-controller',sequence=9),), 'REQUIRED_RECORD_COUNT')
        self.assertEqual(ce.evaluate(self.request,self.records),
                         ce.evaluate(self.request,self.records+(self.records[6],)))

    def test_controller_critical_codes_preserved(self):
        records=self.changed(6, disposition='CRITICAL_DISABLED_VERIFIED', critical_codes=('DEADLINE_MISSED',))
        result=ce.evaluate(self.request,records)
        self.assertEqual(result.status,'SYNTHETIC_ELIGIBLE')
        self.assertEqual(result.historical_critical_codes,('DEADLINE_MISSED',))
        self.assertFalse(hasattr(result,'acceptance_passed'))
        self.blocked(self.changed(6, disposition='UNKNOWN'),'CONTROLLER_DISPOSITION_MISMATCH')
        self.blocked(self.changed(6, disposition='CRITICAL_DISABLED_VERIFIED'),'CONTROLLER_DISPOSITION_MISMATCH')

    def test_controller_binding_digest_changes(self):
        records=list(self.records)
        records[6]=replace(records[6],evidence_id='different-result')
        records[5]=replace(records[5],controller_result_ref='different-result')
        result=ce.evaluate(self.request,tuple(records))
        self.assertEqual(result.status,'SYNTHETIC_ELIGIBLE')
        self.assertNotEqual(result.evidence_digest,ce.evaluate(self.request,self.records).evidence_digest)
        self.assertEqual(result,ce.evaluate(self.request,tuple(reversed(records))))

    def test_all_integer_fields_reject_unsupported_values(self):
        from dataclasses import fields
        # Exercise every integer field in every record and request through the
        # public entry point, without serializing or displaying the huge value.
        for index, record in enumerate((*self.records, self.request)):
            for field in fields(record):
                if field.type is not int:
                    continue
                for value in (0, -1, True, ce.MAX_INTEGER+1, 10**5000):
                    with self.subTest(index=index, field=field.name):
                        changed=replace(record,**{field.name:value})
                        if index == len(self.records):
                            request,records=changed,self.records
                        else:
                            request=self.request
                            records=self.records[:index]+(changed,)+self.records[index+1:]
                        result=ce.evaluate(request,records)
                        self.assertEqual(result.status,'SYNTHETIC_BLOCKED')
                        self.assertEqual(result.blocking_codes,('MALFORMED_EVIDENCE',))
                        self.assertIsNone(result.evidence_digest)
                        self.assertLess(len(repr(result)),300)
                        self.assertEqual(result,ce.evaluate(request,records))
                        self.assertEqual(getattr(changed,field.name),value)

    def test_supported_numeric_maximum(self):
        offset=ce.MAX_INTEGER-self.request.sequence
        records=tuple(replace(r,sequence=r.sequence+offset,execution_version=ce.MAX_INTEGER,
                              **({'cutoff':r.cutoff+offset} if isinstance(r,ce.ExecutionInventory) else {}))
                      for r in self.records)
        request=replace(self.request,sequence=ce.MAX_INTEGER,cutoff=self.request.cutoff+offset,
                        execution_version=ce.MAX_INTEGER)
        result=ce.evaluate(request,records)
        self.assertEqual(result.status,'SYNTHETIC_ELIGIBLE')
        self.assertEqual(result,ce.evaluate(request,records))
        self.assertEqual(len(result.evidence_digest),64)
        self.blocked(records,'MALFORMED_EVIDENCE',replace(request,schema_version=ce.MAX_INTEGER))
