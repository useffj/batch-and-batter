"""Pure synthetic evidence consistency checks. Never live closure authority."""
from dataclasses import dataclass, asdict, fields
from hashlib import sha256
import json
import re
from typing import get_type_hints, get_origin, get_args


@dataclass(frozen=True)
class Evidence:
    evidence_id: str
    schema_version: int
    source: str
    execution_id: str
    resource_id: str
    authorization_id: str
    scope_digest: str
    execution_version: int
    sequence: int


@dataclass(frozen=True)
class ExecutionInventory(Evidence):
    operation_ids: tuple[str, ...]
    participant_ids: tuple[str, ...]
    cutoff: int


@dataclass(frozen=True)
class OperationIntent(Evidence):
    operation_id: str
    participant_id: str
    kind: str


@dataclass(frozen=True)
class OperationResolution(Evidence):
    operation_id: str
    intent_ref: str
    outcome: str
    finality: str
    basis: str


@dataclass(frozen=True)
class ParticipantQuiescence(Evidence):
    participant_id: str
    authority: str
    work_state: str
    pending_operation_ids: tuple[str, ...]
    resolution_refs: tuple[str, ...]


@dataclass(frozen=True)
class DisabledObservation(Evidence):
    configuration_id: str
    configuration_digest: str
    revision_id: str
    update_state: str
    admission: str
    reconciled_refs: tuple[str, ...]
    quiescence_refs: tuple[str, ...]
    inventory_ref: str


@dataclass(frozen=True)
class ControllerResult(Evidence):
    observation_ref: str
    disposition: str
    critical_codes: tuple[str, ...]


@dataclass(frozen=True)
class CleanupDisposition(Evidence):
    observation_ref: str
    controller_result_ref: str
    responsibility: str
    critical_codes: tuple[str, ...]


@dataclass(frozen=True)
class EvaluationRequest(Evidence):
    inventory_ref: str
    cutoff: int
    configuration_id: str
    configuration_digest: str


@dataclass(frozen=True)
class SyntheticResult:
    status: str
    blocking_codes: tuple[str, ...]
    execution_id: str | None
    execution_version: int | None
    evidence_digest: str | None
    historical_critical_codes: tuple[str, ...]


TYPES = (ExecutionInventory, OperationIntent, OperationResolution,
         ParticipantQuiescence, DisabledObservation, ControllerResult, CleanupDisposition)


MAX_INTEGER = 2**63 - 1


def _valid(record):
    hints = get_type_hints(type(record))
    for field in fields(record):
        value, hint = getattr(record, field.name), hints[field.name]
        if hint is int:
            if type(value) is not int or not 1 <= value <= MAX_INTEGER:
                return False
        elif hint is str:
            if type(value) is not str or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}', value):
                return False
        elif get_origin(hint) is tuple and get_args(hint) == (str, Ellipsis):
            if type(value) is not tuple or any(type(v) is not str or not re.fullmatch(
                    r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}', v) for v in value) or len(set(value)) != len(value):
                return False
        else:
            return False
    for name in ('scope_digest', 'configuration_digest'):
        if hasattr(record, name) and not re.fullmatch('[0-9a-f]{64}', getattr(record, name)):
            return False
    return record.schema_version == 1 and record.source.startswith('synthetic:')


def evaluate(request, records):
    """Evaluate immutable records; repeat evaluation is not durable replay control.

    All sources and facts are synthetic declarations. Complete inventory and
    dispatch-prevention/terminal-result assertions are not independently proven.
    """
    def malformed():
        return SyntheticResult('SYNTHETIC_BLOCKED', ('MALFORMED_EVIDENCE',), None, None, None, ())
    if type(request) is not EvaluationRequest or type(records) not in (tuple, list):
        return malformed()
    if not _valid(request) or any(type(r) not in TYPES or not _valid(r) for r in records):
        return malformed()
    errors = set()
    by_id = {request.evidence_id: request}
    for r in records:
        if r.evidence_id in by_id and r != by_id[r.evidence_id]:
            errors.add('CONFLICTING_EVIDENCE_ID')
        else:
            by_id[r.evidence_id] = r
    # Digest includes conflicting records too; input order and identical duplicates
    # do not affect the reference. It is a consistency hash, not a signature.
    serial = sorted(set(json.dumps({'type': type(r).__name__, **asdict(r)}, sort_keys=True,
                                  separators=(',', ':')) for r in [request, *records]))
    digest = sha256(json.dumps(serial, separators=(',', ':')).encode()).hexdigest()
    if errors:
        return SyntheticResult('SYNTHETIC_BLOCKED', tuple(sorted(errors)), request.execution_id,
                               request.execution_version, digest, ())
    unique = [r for r in by_id.values() if type(r) is not EvaluationRequest]
    bindings = ('source', 'execution_id', 'resource_id', 'authorization_id', 'scope_digest', 'execution_version')
    for r in unique:
        if any(getattr(r, k) != getattr(request, k) for k in bindings):
            errors.add('BINDING_MISMATCH')
    if len({r.sequence for r in [request, *unique]}) != len(unique) + 1:
        errors.add('SEQUENCE_CONFLICT')
    def exactly_one(cls):
        found = [r for r in unique if type(r) is cls]
        if len(found) != 1:
            errors.add('REQUIRED_RECORD_COUNT')
            return None
        return found[0]
    inventory = exactly_one(ExecutionInventory)
    observation = exactly_one(DisabledObservation)
    cleanup = exactly_one(CleanupDisposition)
    controller = exactly_one(ControllerResult)
    intents = [r for r in unique if type(r) is OperationIntent]
    resolutions = [r for r in unique if type(r) is OperationResolution]
    participants = [r for r in unique if type(r) is ParticipantQuiescence]
    if inventory:
        if inventory.evidence_id != request.inventory_ref or inventory.cutoff != request.cutoff or inventory.sequence != request.cutoff:
            errors.add('CUTOFF_MISMATCH')
        if (set(inventory.operation_ids) != {r.operation_id for r in intents}
                or len(intents) != len(inventory.operation_ids)
                or {r.operation_id for r in resolutions} != set(inventory.operation_ids)
                or len(resolutions) != len(intents)):
            errors.add('OPERATION_INVENTORY_MISMATCH')
        if (not inventory.participant_ids
                or set(inventory.participant_ids) != {r.participant_id for r in participants}
                or len(participants) != len(inventory.participant_ids)):
            errors.add('PARTICIPANT_INVENTORY_MISMATCH')
        for r in [*intents, *resolutions, *participants]:
            if r.sequence >= inventory.cutoff:
                errors.add('OUTSIDE_CUTOFF')
    for intent in intents:
        matching = [r for r in resolutions if r.operation_id == intent.operation_id]
        if intent.kind not in ('ENABLE', 'DISABLE'):
            errors.add('INVALID_OPERATION_KIND')
        if inventory and intent.participant_id not in inventory.participant_ids:
            errors.add('PARTICIPANT_INVENTORY_MISMATCH')
        if len(matching) != 1:
            errors.add('MISSING_OR_CONFLICTING_RESOLUTION')
            continue
        resolution = matching[0]
        if resolution.intent_ref != intent.evidence_id or resolution.sequence <= intent.sequence:
            errors.add('INVALID_RESOLUTION_REFERENCE')
    for r in resolutions:
        if (r.finality != 'FINAL' or (r.outcome, r.basis) not in
                (('NOT_DISPATCHED', 'DISPATCH_PREVENTED'), ('COMPLETED', 'TERMINAL_RESULT'))):
            errors.add('UNRESOLVED_OPERATION')
    for p in participants:
        owned = {i.operation_id for i in intents if i.participant_id == p.participant_id}
        required = [r for r in resolutions if r.operation_id in owned]
        if p.authority != 'REVOKED' or p.work_state != 'ACCOUNTED' or p.pending_operation_ids:
            errors.add('PARTICIPANT_NOT_QUIESCENT')
        if set(p.resolution_refs) != {r.evidence_id for r in required} or any(r.sequence >= p.sequence for r in required):
            errors.add('QUIESCENCE_REFERENCE_MISMATCH')
    if observation:
        if (observation.configuration_id != request.configuration_id
                or observation.configuration_digest != request.configuration_digest
                or observation.update_state != 'SUCCESSFUL' or observation.admission != 'DISABLED'):
            errors.add('DISABLED_GUARD_MISMATCH')
        if (observation.inventory_ref != request.inventory_ref
                or set(observation.reconciled_refs) != {r.evidence_id for r in resolutions}
                or set(observation.quiescence_refs) != {p.evidence_id for p in participants}):
            errors.add('OBSERVATION_REFERENCE_MISMATCH')
        if observation.sequence <= max([request.cutoff, *[r.sequence for r in resolutions], *[p.sequence for p in participants]]):
            errors.add('OBSERVATION_ORDER')
    critical = tuple(sorted({code for c in unique if type(c) in (CleanupDisposition, ControllerResult) for code in c.critical_codes}))
    if any(not re.fullmatch('[A-Z][A-Z0-9_]{0,63}', code) for code in critical):
        return malformed()
    if controller:
        if (controller.disposition not in ('DISABLED_VERIFIED', 'CRITICAL_DISABLED_VERIFIED')
                or bool(controller.critical_codes) != (controller.disposition == 'CRITICAL_DISABLED_VERIFIED')):
            errors.add('CONTROLLER_DISPOSITION_MISMATCH')
        if observation and (controller.observation_ref != observation.evidence_id
                            or controller.sequence <= observation.sequence):
            errors.add('CONTROLLER_OBSERVATION_MISMATCH')
    if cleanup:
        referenced = by_id.get(cleanup.controller_result_ref)
        if type(referenced) is not ControllerResult or referenced is not controller:
            errors.add('CONTROLLER_REFERENCE_MISMATCH')
        elif controller.sequence >= cleanup.sequence:
            errors.add('CONTROLLER_ORDER')
        if cleanup.responsibility != 'RESOLVED':
            errors.add('CLEANUP_UNRESOLVED')
        if observation and (cleanup.observation_ref != observation.evidence_id or cleanup.sequence <= observation.sequence):
            errors.add('CLEANUP_REFERENCE_MISMATCH')
    if any(r.sequence >= request.sequence for r in unique):
        errors.add('REQUEST_ORDER')
    return SyntheticResult('SYNTHETIC_BLOCKED' if errors else 'SYNTHETIC_ELIGIBLE',
                           tuple(sorted(errors)), request.execution_id, request.execution_version,
                           digest, critical)
