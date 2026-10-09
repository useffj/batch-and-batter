"""Deterministic local validation; no subprocesses, sockets, SDKs or real sleeps."""

import base64
from copy import deepcopy
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import socket
import subprocess
from threading import Event
import unittest
from unittest.mock import patch

from admission_window import (
    AdmissionWindow, API_SHA256, CriticalRelockFailure, FUNCTION,
    LEDGER_NAMESPACE, NS, SANDBOX, Stamp,
)


def baseline():
    return {
        "FunctionName": FUNCTION,
        "FunctionArn": "arn:aws:lambda:us-east-2:302154194958:function:" + FUNCTION,
        "CodeSha256": base64.b64encode(bytes.fromhex(API_SHA256)).decode(),
        "RevisionId": "before-enable", "State": "Active",
        "LastUpdateStatus": "Successful", "Timeout": 15,
        "Environment": {"Variables": {
            "PAYMENT_START_ENABLED": "false", "STRIPE_ACCOUNT_ID": SANDBOX,
            "STRIPE_LEDGER_ACCOUNT_ID": SANDBOX,
            "STRIPE_LEDGER_NAMESPACE": LEDGER_NAMESPACE,
            "UNCHANGED_SETTING": "synthetic-preserved-value",
        }},
    }


class FakeClock:
    def __init__(self):
        self.ns = 17 * NS  # Nonzero monotonic origin catches epoch assumptions.
        self.utc_jump = 0
        self.delay_ns = 0
        self.stop_after_ns = None
        self.after_wait = None
        self.waits = []

    def advance(self, ns):
        self.ns += ns

    def now_ns(self):
        return self.ns

    def stamp(self):
        utc = datetime(2026, 10, 9, tzinfo=timezone.utc) + timedelta(
            seconds=self.ns / NS + self.utc_jump)
        return Stamp(self.ns, utc.isoformat())

    def wait(self, stop, seconds):
        self.waits.append(seconds)
        if stop.is_set():
            return
        duration = round(seconds * NS)
        if self.stop_after_ns is not None:
            duration = min(duration, self.stop_after_ns)
            self.stop_after_ns = None
            stop.set()
        self.ns += duration + self.delay_ns
        self.delay_ns = 0
        if self.after_wait:
            callback, self.after_wait = self.after_wait, None
            callback()


class FakeTransport:
    def __init__(self, clock):
        self.clock = clock
        self.config = baseline()
        self.calls = []
        self.dispatch_errors = []
        self.read_errors = []
        self.before_dispatch_ns = 0
        self.update_latency_ns = 0
        self.read_latency_ns = 0
        self.complete_update = True
        self.on_read = None
        self.on_update = None
        self.omit_dispatch_callback = False

    def enable(self, complete_verification=None):
        self.config["Environment"]["Variables"]["PAYMENT_START_ENABLED"] = "true"
        self.config["RevisionId"] = "verified-enabled-revision"
        live = deepcopy(self.config)
        return complete_verification(live) if complete_verification else live

    def dispatch_disable(self, request, timeout_seconds, on_dispatch):
        assert timeout_seconds > 0
        self.clock.advance(self.before_dispatch_ns)
        if not self.omit_dispatch_callback:
            on_dispatch()
        self.calls.append(("dispatch", self.clock.ns, deepcopy(request)))
        if self.on_update:
            self.on_update()
        if self.dispatch_errors:
            raise self.dispatch_errors.pop(0)
        if request["RevisionId"] != self.config["RevisionId"]:
            raise RuntimeError("Revision conflict")
        self.clock.advance(self.update_latency_ns)
        if self.complete_update:
            self.config["Environment"] = deepcopy(request["Environment"])
            self.config["RevisionId"] = "disabled-revision"
        else:
            self.config["LastUpdateStatus"] = "InProgress"

    def read_configuration(self, timeout_seconds):
        self.calls.append(("read", self.clock.ns, timeout_seconds))
        if self.on_read:
            self.on_read()
        if self.read_errors:
            raise self.read_errors.pop(0)
        self.clock.advance(self.read_latency_ns)
        return deepcopy(self.config)


class DeadlineTests(unittest.TestCase):
    def setUp(self):
        # Fail closed if a future implementation accidentally adds real I/O.
        for target in ("socket.socket", "socket.create_connection", "subprocess.Popen",
                       "subprocess.run", "os.system", "os.posix_spawn", "time.sleep"):
            blocker = patch(target, side_effect=AssertionError("REAL_IO_FORBIDDEN"))
            blocker.start()
            self.addCleanup(blocker.stop)
        self.clock = FakeClock()
        self.transport = FakeTransport(self.clock)
        self.stop = Event()
        self.window = AdmissionWindow(baseline(), self.transport, self.stop, self.clock)

    def run_window(self, critical=False, enable=None):
        if critical:
            with self.assertRaises(CriticalRelockFailure) as cm:
                self.window.run(enable or self.transport.enable)
            return cm.exception.report
        return self.window.run(enable or self.transport.enable)

    def event(self, report, name):
        return next(e for e in report["events"] if e["event"] == name)

    def elapsed(self, report, name):
        return (self.event(report, name)["monotonic_ns"]
                - self.event(report, "enabled_verified")["monotonic_ns"])

    def test_normal_schedule_and_actual_dispatch_boundary(self):
        report = self.run_window()
        self.assertEqual(self.elapsed(report, "relock_entry"), 100 * NS)
        self.assertEqual(self.elapsed(report, "disable_update_dispatch"), 100 * NS)
        self.assertLess(self.elapsed(report, "disable_update_dispatch"), 120 * NS)
        self.assertEqual(self.transport.calls[0][0], "dispatch")
        self.assertEqual(self.event(report, "disable_update_dispatch")["monotonic_ns"],
                         self.transport.calls[0][1])
        self.assertEqual(report["result"], "DISABLED_VERIFIED")

    def test_small_scheduler_delay(self):
        self.clock.delay_ns = 5_100_000
        report = self.run_window()
        self.assertEqual(self.elapsed(report, "disable_update_dispatch"), 100_005_100_000)

    def test_larger_scheduler_delay_within_margin(self):
        self.clock.delay_ns = 19 * NS
        report = self.run_window()
        self.assertEqual(self.elapsed(report, "disable_update_dispatch"), 119 * NS)

    def test_dispatch_one_nanosecond_before_deadline(self):
        self.clock.delay_ns = 20 * NS - 1
        report = self.run_window()
        self.assertEqual(self.elapsed(report, "disable_update_dispatch"), 120 * NS - 1)

    def test_exact_deadline_is_critical_but_still_disables(self):
        self.clock.delay_ns = 20 * NS
        report = self.run_window(critical=True)
        self.assertIn("DISPATCH_DEADLINE_MISSED", report["errors"])
        self.assertTrue(report["disabled_verified"])
        self.assertFalse(report["instructions_allowed"])

    def test_past_deadline_is_critical_but_cleanup_is_not_skipped(self):
        self.clock.delay_ns = 30 * NS
        report = self.run_window(critical=True)
        self.assertEqual(self.elapsed(report, "disable_update_dispatch"), 130 * NS)
        self.assertTrue(report["disabled_verified"])

    def test_slow_configuration_read_cannot_precede_initial_dispatch(self):
        self.transport.read_latency_ns = 45 * NS
        report = self.run_window()
        self.assertEqual(self.elapsed(report, "disable_update_dispatch"), 100 * NS)
        self.assertEqual(self.elapsed(report, "disabled_verified"), 145 * NS)
        self.assertEqual([c[0] for c in self.transport.calls], ["dispatch", "read"])

    def test_procedure_entry_is_not_dispatch(self):
        self.transport.before_dispatch_ns = 21 * NS  # Broken/slow adapter.
        report = self.run_window(critical=True)
        self.assertEqual(self.elapsed(report, "relock_entry"), 100 * NS)
        self.assertEqual(self.elapsed(report, "disable_update_dispatch"), 121 * NS)
        self.assertIn("DISPATCH_DEADLINE_MISSED", report["errors"])

    def test_stop_signal_revokes_instruction_gate_and_runs_cleanup(self):
        self.clock.stop_after_ns = 7 * NS
        self.clock.after_wait = lambda: self.assertFalse(self.window.instructions_allowed())
        report = self.run_window()
        self.assertEqual(self.elapsed(report, "disable_update_dispatch"), 7 * NS)
        self.assertTrue(self.stop.is_set())
        self.assertFalse(self.window.instructions_allowed())

    def test_time_gate_closes_even_if_controller_wakeup_is_delayed(self):
        self.clock.delay_ns = 5 * NS
        self.clock.after_wait = lambda: self.assertFalse(self.window.instructions_allowed())
        self.run_window()

    def test_gate_cannot_authorize_after_stop_during_verification(self):
        self.transport.on_update = lambda: self.assertFalse(self.window.instructions_allowed())
        self.transport.on_read = lambda: self.assertFalse(self.window.instructions_allowed())
        self.run_window()

    def test_failed_disable_never_reports_success_even_after_recovery(self):
        self.transport.dispatch_errors = [RuntimeError("sensitive payload must not be logged")]
        report = self.run_window(critical=True)
        self.assertIn("DISABLE_UPDATE_FAILED", report["errors"])
        self.assertTrue(report["disabled_verified"])
        self.assertEqual(self.window.dispatches, 2)
        self.assertNotIn("sensitive", str(report))

    def test_all_disable_attempts_fail(self):
        self.transport.dispatch_errors = [RuntimeError()] * 3
        report = self.run_window(critical=True)
        self.assertFalse(report["disabled_verified"])
        self.assertIn("DISABLED_NOT_VERIFIED", report["errors"])
        self.assertEqual(self.window.dispatches, 3)

    def test_failed_verification_is_critical(self):
        self.transport.complete_update = False
        report = self.run_window(critical=True)
        self.assertFalse(report["disabled_verified"])
        self.assertIn("DISABLED_NOT_VERIFIED", report["errors"])
        self.assertEqual(self.window.dispatches, 1)

    def test_false_flag_without_successful_update_is_not_verification(self):
        def failed_status():
            self.transport.config["LastUpdateStatus"] = "Failed"
        self.transport.on_read = failed_status
        report = self.run_window(critical=True)
        self.assertFalse(report["disabled_verified"])
        self.assertIn("CONFIGURATION_NOT_READY", report["errors"])

    def test_verification_requires_full_configuration_not_just_false(self):
        def drift():
            self.transport.config["Timeout"] = 99
        self.transport.on_read = drift
        report = self.run_window(critical=True)
        self.assertFalse(report["disabled_verified"])
        self.assertIn("CLEANUP_EXCEPTION", report["errors"])

    def test_enabled_snapshot_drift_invalidates_window(self):
        def unexpected_enable(complete_verification):
            self.transport.enable()
            self.transport.config["Environment"]["Variables"]["UNEXPECTED"] = "changed"
            return complete_verification(deepcopy(self.transport.config))
        report = self.run_window(critical=True, enable=unexpected_enable)
        self.assertFalse(report["instructions_allowed"])
        self.assertFalse(report["disabled_verified"])
        self.assertEqual(self.window.dispatches, 0)

    def test_read_failure_keeps_cleanup_running_but_latches_failure(self):
        self.transport.read_errors = [RuntimeError()]
        report = self.run_window(critical=True)
        self.assertTrue(report["disabled_verified"])
        self.assertIn("DISABLED_READ_FAILED", report["errors"])

    def test_read_exceeding_verification_budget_cannot_pass(self):
        self.transport.read_latency_ns = 101 * NS
        report = self.run_window(critical=True)
        self.assertFalse(report["disabled_verified"])

    def test_monotonic_elapsed_ignores_wall_clock_steps(self):
        for jump in (-3600, 3600):
            with self.subTest(jump=jump):
                self.clock = FakeClock()
                self.transport = FakeTransport(self.clock)
                self.window = AdmissionWindow(baseline(), self.transport, Event(), self.clock)
                self.clock.after_wait = lambda: setattr(self.clock, "utc_jump", jump)
                report = self.run_window()
                self.assertEqual(self.elapsed(report, "disable_update_dispatch"), 100 * NS)
                start = datetime.fromisoformat(self.event(report, "enabled_verified")["utc"])
                dispatch = datetime.fromisoformat(self.event(report, "disable_update_dispatch")["utc"])
                self.assertEqual((dispatch - start).total_seconds(), 100 + jump)

    def test_separate_paired_entry_dispatch_and_verified_timestamps(self):
        self.transport.before_dispatch_ns = 2 * NS
        self.transport.update_latency_ns = 3 * NS
        self.transport.read_latency_ns = 4 * NS
        report = self.run_window()
        for name, seconds in [("relock_entry", 100), ("disable_update_dispatch", 102),
                              ("disabled_verified", 109)]:
            self.assertEqual(self.elapsed(report, name), seconds * NS)
            self.assertIsNotNone(datetime.fromisoformat(self.event(report, name)["utc"]).tzinfo)

    def test_revision_cas_refresh_only_after_conflict(self):
        self.clock.after_wait = lambda: self.transport.config.update(RevisionId="external-revision")
        report = self.run_window(critical=True)
        self.assertTrue(report["disabled_verified"])
        calls = self.transport.calls
        self.assertEqual([c[0] for c in calls], ["dispatch", "read", "dispatch", "read"])
        self.assertEqual(calls[0][2]["RevisionId"], "verified-enabled-revision")
        self.assertEqual(calls[2][2]["RevisionId"], "external-revision")

    def test_config_drift_is_not_overwritten_during_conflict_recovery(self):
        def drift():
            self.transport.config["RevisionId"] = "external-revision"
            self.transport.config["Environment"]["Variables"]["UNCHANGED_SETTING"] = "changed"
        self.clock.after_wait = drift
        report = self.run_window(critical=True)
        self.assertFalse(report["disabled_verified"])
        self.assertEqual(self.window.dispatches, 1)
        self.assertIn("CLEANUP_EXCEPTION", report["errors"])

    def test_only_admission_changes_and_caller_baseline_is_not_mutated(self):
        before = baseline()
        self.run_window()
        request = self.transport.calls[0][2]
        self.assertEqual(request["Environment"], before["Environment"])
        self.assertEqual(request["FunctionName"], FUNCTION)
        self.assertEqual(self.window.baseline, before)

    def test_enable_ambiguity_still_cleans_up(self):
        def ambiguous(complete_verification):
            self.transport.enable()
            raise TimeoutError()
        report = self.run_window(critical=True, enable=ambiguous)
        self.assertTrue(report["disabled_verified"])
        self.assertFalse(any(e["event"] == "enabled_verified" for e in report["events"]))

    def test_controller_interruption_still_cleans_up(self):
        def interrupt():
            raise KeyboardInterrupt()
        self.clock.after_wait = interrupt
        report = self.run_window(critical=True)
        self.assertTrue(report["disabled_verified"])

    def test_preset_stop_does_not_enable_or_skip_cleanup(self):
        self.stop.set()
        def forbidden_enable(complete_verification):
            self.fail("Enable called despite stop")
        report = self.run_window(critical=True, enable=forbidden_enable)
        self.assertTrue(report["disabled_verified"])
        self.assertEqual(self.window.dispatches, 0)

    def test_second_window_rejected(self):
        self.run_window()
        with self.assertRaises(ValueError):
            self.window.run(self.transport.enable)

    def test_missing_transport_dispatch_marker_invalidates_run(self):
        self.transport.omit_dispatch_callback = True
        report = self.run_window(critical=True)
        self.assertTrue(report["disabled_verified"])
        self.assertIn("DISPATCH_NOT_RECORDED", report["errors"])

    def test_approved_scope_guards(self):
        changes = [
            ("CodeSha256", "AAAA"), ("FunctionArn", "arn:wrong"),
            ("FunctionName", "wrong"), ("LastUpdateStatus", "InProgress"),
        ]
        for key, value in changes:
            with self.subTest(key=key):
                config = baseline()
                config[key] = value
                with self.assertRaises(ValueError):
                    AdmissionWindow(config, self.transport, Event(), self.clock)
        for key in ("STRIPE_ACCOUNT_ID", "STRIPE_LEDGER_ACCOUNT_ID", "STRIPE_LEDGER_NAMESPACE",
                    "PAYMENT_START_ENABLED"):
            with self.subTest(key=key):
                config = baseline()
                config["Environment"]["Variables"][key] = "wrong"
                with self.assertRaises(ValueError):
                    AdmissionWindow(config, self.transport, Event(), self.clock)

    def delayed_callback(self, delay_ns, utc_jump=0):
        def enable(complete_verification):
            handoff = self.transport.enable(complete_verification)
            self.assertFalse(self.window.instructions_allowed())
            self.clock.advance(delay_ns)
            self.clock.utc_jump = utc_jump
            return handoff
        return enable

    def test_origin_is_completed_verification_not_enable_initiation(self):
        origin = self.clock.ns
        def enable(complete):
            live = self.transport.enable()
            self.clock.advance(20 * NS)  # Simulated update and verification latency.
            handoff = complete(live)
            self.clock.advance(5 * NS)
            return handoff
        report = self.run_window(enable=enable)
        self.assertEqual(self.event(report, "enabled_verified")["monotonic_ns"], origin + 20 * NS)
        self.assertEqual(self.event(report, "disable_update_dispatch")["monotonic_ns"], origin + 120 * NS)
        self.assertEqual(self.elapsed(report, "disable_update_dispatch"), 100 * NS)

    def test_stop_during_callback_never_opens_instruction_gate(self):
        def enable(complete):
            handoff = self.transport.enable(complete)
            self.clock.advance(5 * NS)
            self.stop.set()
            self.assertFalse(self.window.instructions_allowed())
            return handoff
        report = self.run_window(enable=enable)
        self.assertEqual(self.elapsed(report, "disable_update_dispatch"), 5 * NS)
        self.assertTrue(report["disabled_verified"])
        self.assertFalse(report["instructions_allowed"])

    def test_callback_return_delays_preserve_original_origin(self):
        for seconds in (0, 5, 25, 105, 119):
            with self.subTest(seconds=seconds):
                self.clock = FakeClock()
                self.transport = FakeTransport(self.clock)
                self.window = AdmissionWindow(baseline(), self.transport, Event(), self.clock)
                origin = self.clock.ns
                report = self.run_window(enable=self.delayed_callback(seconds * NS))
                enabled = self.event(report, "enabled_verified")
                self.assertEqual(enabled["monotonic_ns"], origin)
                self.assertEqual(enabled["hard_deadline_ns"], origin + 120 * NS)
                self.assertEqual(self.elapsed(report, "disable_update_dispatch"), max(100, seconds) * NS)
                self.assertEqual(self.clock.waits, [100 - seconds] if seconds < 100 else [])
                self.assertEqual(self.transport.calls[0][2]["RevisionId"], "verified-enabled-revision")

    def test_callback_return_deadline_boundaries(self):
        for delay in (120 * NS - 1, 120 * NS, 125 * NS):
            with self.subTest(delay=delay):
                self.clock = FakeClock()
                self.transport = FakeTransport(self.clock)
                self.window = AdmissionWindow(baseline(), self.transport, Event(), self.clock)
                report = self.run_window(critical=delay >= 120 * NS,
                                         enable=self.delayed_callback(delay))
                self.assertEqual(self.elapsed(report, "disable_update_dispatch"), delay)
                self.assertTrue(report["disabled_verified"])
                self.assertEqual("DISPATCH_DEADLINE_MISSED" in report["errors"], delay >= 120 * NS)
                self.assertEqual(self.clock.waits, [])

    def test_invalid_or_future_verification_timestamp(self):
        for bad in (-1, True, 1.5, "17", None, 17 * NS - 1, 17 * NS + 1):
            with self.subTest(timestamp=bad):
                self.clock = FakeClock()
                self.transport = FakeTransport(self.clock)
                self.window = AdmissionWindow(baseline(), self.transport, Event(), self.clock)
                def enable(complete_verification):
                    live = self.transport.enable()
                    with patch.object(self.clock, "stamp", return_value=Stamp(bad, "2026-10-09T00:00:00+00:00")):
                        return complete_verification(live)
                report = self.run_window(critical=True, enable=enable)
                self.assertIn("INVALID_VERIFICATION_HANDOFF", report["errors"])
                self.assertIsNone(self.window.enabled)
                self.assertTrue(report["disabled_verified"])

    def test_invalid_utc_verification_timestamp(self):
        for bad in (None, "invalid", "2026-10-09T00:00:00", "2026-10-09T00:00:00-06:00"):
            with self.subTest(utc=bad):
                self.clock = FakeClock()
                self.transport = FakeTransport(self.clock)
                self.window = AdmissionWindow(baseline(), self.transport, Event(), self.clock)
                def enable(complete_verification):
                    live = self.transport.enable()
                    with patch.object(self.clock, "stamp", return_value=Stamp(self.clock.ns, bad)):
                        return complete_verification(live)
                report = self.run_window(critical=True, enable=enable)
                self.assertIsNone(self.window.enabled)
                self.assertTrue(report["disabled_verified"])

    def test_missing_handoff_does_not_invent_verification(self):
        report = self.run_window(critical=True, enable=lambda complete: self.transport.enable())
        self.assertIn("INVALID_VERIFICATION_HANDOFF", report["errors"])
        self.assertIsNone(self.window.enabled)
        self.assertTrue(report["disabled_verified"])
        self.assertEqual(self.transport.calls[0][0], "read")

    def test_inconsistent_handoff_retains_original_cleanup_revision(self):
        def enable(complete):
            handoff = self.transport.enable(complete)
            handoff.configuration["RevisionId"] = "invented"
            return handoff
        report = self.run_window(critical=True, enable=enable)
        self.assertIn("INVALID_VERIFICATION_HANDOFF", report["errors"])
        self.assertEqual(self.transport.calls[0][2]["RevisionId"], "verified-enabled-revision")
        self.assertTrue(report["disabled_verified"])

    def test_reconstructed_or_foreign_handoff_rejected(self):
        def enable(complete):
            handoff = self.transport.enable(complete)
            return replace(handoff)  # Serialized/foreign records cannot establish clock provenance.
        report = self.run_window(critical=True, enable=enable)
        self.assertIn("INVALID_VERIFICATION_HANDOFF", report["errors"])
        self.assertTrue(report["disabled_verified"])

    def test_invalid_revision_is_not_cached(self):
        for revision in (None, "", " ", 12):
            with self.subTest(revision=revision):
                self.clock = FakeClock()
                self.transport = FakeTransport(self.clock)
                self.window = AdmissionWindow(baseline(), self.transport, Event(), self.clock)
                def enable(complete):
                    live = self.transport.enable()
                    live["RevisionId"] = revision
                    return complete(live)
                report = self.run_window(critical=True, enable=enable)
                self.assertIsNone(self.window.cached)
                self.assertTrue(report["disabled_verified"])
                self.assertEqual(self.transport.calls[0][0], "read")

    def test_exception_after_recorded_verification_keeps_origin_and_revision(self):
        def enable(complete):
            self.transport.enable(complete)
            self.clock.advance(125 * NS)
            raise TimeoutError("sensitive callback failure")
        report = self.run_window(critical=True, enable=enable)
        self.assertEqual(self.elapsed(report, "disable_update_dispatch"), 125 * NS)
        self.assertIn("DISPATCH_DEADLINE_MISSED", report["errors"])
        self.assertTrue(report["disabled_verified"])
        self.assertEqual(self.transport.calls[0][0], "dispatch")
        self.assertNotIn("sensitive", str(report))

    def test_utc_adjustment_during_callback_does_not_move_deadline(self):
        for jump in (-3600, 3600):
            with self.subTest(jump=jump):
                self.clock = FakeClock()
                self.transport = FakeTransport(self.clock)
                self.window = AdmissionWindow(baseline(), self.transport, Event(), self.clock)
                report = self.run_window(enable=self.delayed_callback(25 * NS, jump))
                self.assertEqual(self.elapsed(report, "disable_update_dispatch"), 100 * NS)
                enabled = datetime.fromisoformat(self.event(report, "enabled_verified")["utc"])
                dispatch = datetime.fromisoformat(self.event(report, "disable_update_dispatch")["utc"])
                self.assertEqual((dispatch - enabled).total_seconds(), 100 + jump)

    def test_duplicate_verification_cannot_restart_origin(self):
        def enable(complete):
            first = self.transport.enable(complete)
            self.clock.advance(25 * NS)
            try:
                complete(self.transport.config)
            except ValueError:
                pass  # Swallowing a bad handoff cannot erase critical status.
            return first
        report = self.run_window(critical=True, enable=enable)
        self.assertIn("INVALID_VERIFICATION_HANDOFF", report["errors"])
        self.assertEqual(self.elapsed(report, "disable_update_dispatch"), 25 * NS)
        self.assertEqual(sum(e["event"] == "enabled_verified" for e in report["events"]), 1)

    def test_real_io_tripwires_are_installed(self):
        for action in (lambda: socket.socket(), lambda: subprocess.run(["aws", "--version"])):
            with self.assertRaisesRegex(AssertionError, "REAL_IO_FORBIDDEN"):
                action()


if __name__ == "__main__":
    unittest.main()
