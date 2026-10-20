import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location("cloud_tick", pathlib.Path(__file__).parents[1] / "scripts/cloud_tick.py")
cloud = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cloud)


class CloudTickTests(unittest.TestCase):
    def env(self, **overrides):
        return {"ARTHA_SITE_ORIGIN": "https://fixture.owner.chatgpt.site", "ARTHA_PRODUCTION_SERVICE_TOKEN": "UNIT_TEST_TRANSPORT_ONLY",
                "ARTHA_PRODUCTION_AUTH_APPROVED": "true", "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1",
                "GITHUB_EVENT_NAME": "schedule", **overrides}

    def test_unapproved_auth_never_sends_a_request(self):
        with self.assertRaisesRegex(cloud.SchedulerError, "documented_production_service_auth_required"):
            cloud.run_cloud_tick(self.env(ARTHA_PRODUCTION_AUTH_APPROVED="false"), lambda *args: self.fail("network attempted"))

    def test_ssrf_credentials_urls_and_other_workflow_events_fail_closed(self):
        for origin in ("http://fixture.owner.chatgpt.site", "https://127.0.0.1", "https://fixture.owner.chatgpt.site.evil.test",
                       "https://user:pw@fixture.owner.chatgpt.site", "https://fixture.owner.chatgpt.site/?token=bad",
                       "https://fixture.owner.chatgpt.site:bad", "https://[malformed"):
            with self.assertRaises(cloud.SchedulerError):
                cloud.run_cloud_tick(self.env(ARTHA_SITE_ORIGIN=origin), lambda *args: self.fail("network attempted"))
        with self.assertRaisesRegex(cloud.SchedulerError, "unsupported_scheduler_event"):
            cloud.run_cloud_tick(self.env(GITHUB_EVENT_NAME="pull_request"))

    def test_completed_invocation_requires_exact_persisted_run_readback(self):
        calls = []
        def sender(url, token, payload=None):
            calls.append((url, token, payload))
            if payload:
                return {"status": "completed", "completed": 2, "run_id": "fixture-run"}
            return {"runs": [{"id": "fixture-run", "request_id": "123:1", "status": "completed"}]}
        result = cloud.run_cloud_tick(self.env(), sender)
        self.assertEqual(result, {"status": "completed", "completed": 2, "persistence_verified": True})
        self.assertEqual(calls[0][2], {"request_id": "123:1", "event": "schedule"})
        self.assertNotIn("UNIT_TEST", str(result))

    def test_missing_persistence_is_a_failure(self):
        def sender(url, token, payload=None):
            return {"status": "completed", "run_id": "fixture-run"} if payload else {"runs": []}
        with self.assertRaisesRegex(cloud.SchedulerError, "scheduler_persistence_not_verified"):
            cloud.run_cloud_tick(self.env(), sender)

    def test_paused_and_duplicate_invocations_are_visible_without_claiming_work(self):
        for status in ("paused_busy_or_not_due", "duplicate_request"):
            result = cloud.run_cloud_tick(self.env(), lambda url, token, payload=None: {"status": status} if payload else {"runs": []})
            self.assertFalse(result["persistence_verified"])

    def test_redirects_never_receive_a_forwarded_credential(self):
        with self.assertRaisesRegex(cloud.SchedulerError, "scheduler_redirect_rejected"):
            cloud.NoRedirect().redirect_request(None, None, 302, "redirect", {}, "https://evil.test")

    def test_workflow_is_inactive_pinned_and_uses_no_artifact_uploads(self):
        root = pathlib.Path(__file__).parents[1]
        template = (root / "deploy/github-scheduler.workflow.yml").read_text()
        self.assertFalse((root / ".github/workflows/artha-cloud.yml").exists())
        for text in ("2-59/5", "cancel-in-progress: false", "persist-credentials: false", "3d3c42e5aac5ba805825da76410c181273ba90b1"):
            self.assertIn(text, template)
        self.assertNotIn("upload-artifact", template)


if __name__ == "__main__":
    unittest.main()
