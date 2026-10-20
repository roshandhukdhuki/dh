"""Inactive cloud-runner transport. Requires separately documented, approved production Site authentication.

Never supply a temporary get_site/Sign-in-with-ChatGPT bypass or test token here.
This module does not create credentials or establish their production scope.
"""
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request


class SchedulerError(Exception):
    """Only fixed, non-sensitive error codes are returned to the runner log."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise SchedulerError("scheduler_redirect_rejected")


def fetch_json(url, token, payload=None):
    headers = {"OAI-Sites-Authorization": "Bearer " + token, "Accept": "application/json"}
    data = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=data, headers=headers, method="POST" if data else "GET")
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=40) as response:
            body = response.read(131073)
        if len(body) > 131072:
            raise SchedulerError("scheduler_response_too_large")
        result = json.loads(body)
        if not isinstance(result, dict):
            raise SchedulerError("scheduler_invalid_response")
        return result
    except SchedulerError:
        raise
    except Exception:
        # urllib exceptions and response text can contain the private origin or credentials.
        raise SchedulerError("scheduler_transport_or_response_failed") from None


def run_cloud_tick(environ=None, sender=fetch_json):
    env = os.environ if environ is None else environ
    if env.get("ARTHA_PRODUCTION_AUTH_APPROVED") != "true":
        raise SchedulerError("documented_production_service_auth_required")
    origin = env.get("ARTHA_SITE_ORIGIN", "")
    token = env.get("ARTHA_PRODUCTION_SERVICE_TOKEN", "")
    try:
        parsed = urllib.parse.urlsplit(origin)
        port = parsed.port
    except (ValueError, UnicodeError):
        raise SchedulerError("scheduler_configuration_invalid") from None
    if (parsed.scheme != "https" or not re.fullmatch(r"[a-z0-9-]+\.[a-z0-9-]+\.chatgpt\.site", parsed.hostname or "")
            or parsed.username or parsed.password or port or parsed.query or parsed.fragment or parsed.path not in ("", "/")
            or not token or len(token) > 8192 or "\n" in token or "\r" in token):
        raise SchedulerError("scheduler_configuration_invalid")
    run_id = env.get("GITHUB_RUN_ID", "")
    attempt = env.get("GITHUB_RUN_ATTEMPT", "")
    event = env.get("GITHUB_EVENT_NAME", "")
    request_id = run_id + ":" + attempt
    if not re.fullmatch(r"\d{1,30}:\d{1,6}", request_id) or event not in ("schedule", "workflow_dispatch"):
        raise SchedulerError("unsupported_scheduler_event")
    base = origin.rstrip("/")
    result = sender(base + "/api/engine/tick", token, {"request_id": request_id, "event": event})
    status = result.get("status")
    if status not in ("completed", "partial", "paused_busy_or_not_due", "duplicate_request"):
        raise SchedulerError("scheduler_execution_not_ready")
    state = sender(base + "/api/engine/status", token)
    verified = False
    if status in ("completed", "partial"):
        runs = state.get("runs", [])
        if not isinstance(runs, list) or any(not isinstance(run, dict) for run in runs):
            raise SchedulerError("scheduler_invalid_response")
        saved = next((run for run in runs if run.get("id") == result.get("run_id")
                      and run.get("request_id") == request_id), None)
        if not saved or saved.get("status") not in ("completed", "partial"):
            raise SchedulerError("scheduler_persistence_not_verified")
        verified = True
    return {"status": status, "completed": result.get("completed", 0), "persistence_verified": verified}


if __name__ == "__main__":
    try:
        print(json.dumps(run_cloud_tick()))
    except SchedulerError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
