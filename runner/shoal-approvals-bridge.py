#!/usr/bin/env python3
"""Relay native OpenClaw exec approvals to Shoal. No command execution or auto-approval.

SHOAL_API=http://127.0.0.1:5173
SHOAL_RUNNER_TOKEN=... (or BUZZ_RUNNER_TOKEN)
OPENCLAW_COMMAND_JSON='["openclaw"]'  # fixed trusted argv prefix, never a shell
OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789 (optional)
OPENCLAW_GATEWAY_TOKEN=... (optional; CLI can use its own saved credential)
Run under the host service manager, outside the agent sandbox.
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def cli_json(output):
    # NemoClaw prints an active-gateway banner before the native CLI JSON.
    decoder = json.JSONDecoder()
    for index, char in enumerate(output):
        if char not in "[{":
            continue
        try:
            value, end = decoder.raw_decode(output[index:])
            if not output[index + end:].strip():
                return value
        except json.JSONDecodeError:
            pass
    raise ValueError("Native CLI output does not end with JSON")


def action_for(native):
    request = native.get("request")
    if not isinstance(request, dict) or not isinstance(request.get("command"), str):
        raise ValueError("Native exec approval has no complete command request")
    if not isinstance(native.get("id"), str) or not native["id"]:
        raise ValueError("Native exec approval has no id")
    return {"kind": "exec", "request": request}


def action_equal(record, native):
    action = record.get("action")
    if isinstance(action, str):
        action = json.loads(action)
    return canonical(action) == canonical(action_for(native))


class Bridge:
    def __init__(self):
        self.api_url = os.environ.get("SHOAL_API", os.environ.get("BUZZ_API", "http://127.0.0.1:5173")).rstrip("/")
        self.token = os.environ.get("SHOAL_RUNNER_TOKEN", os.environ.get("BUZZ_RUNNER_TOKEN", ""))
        self.command = json.loads(os.environ.get("OPENCLAW_COMMAND_JSON", '["openclaw"]'))
        if not self.token:
            raise ValueError("SHOAL_RUNNER_TOKEN or BUZZ_RUNNER_TOKEN is required")
        if not isinstance(self.command, list) or not self.command or not all(isinstance(x, str) and x for x in self.command):
            raise ValueError("OPENCLAW_COMMAND_JSON must be a nonempty JSON argv array")
        self.gateway_args = []
        if os.environ.get("OPENCLAW_GATEWAY_URL"):
            self.gateway_args += ["--url", os.environ["OPENCLAW_GATEWAY_URL"]]
        # Prefer the CLI's saved operator credential. Passing --token makes it visible in argv.
        if os.environ.get("OPENCLAW_GATEWAY_TOKEN"):
            self.gateway_args += ["--token", os.environ["OPENCLAW_GATEWAY_TOKEN"]]
        self.sent = set()

    def api(self, path, payload=None):
        request = urllib.request.Request(
            self.api_url + path,
            data=canonical(payload).encode() if payload is not None else None,
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + self.token},
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            # Do not emit request bodies, headers, credentials, or command contents to logs.
            raise RuntimeError(f"Shoal {path}: HTTP {error.code}") from None

    def claw(self, *args):
        result = subprocess.run(self.command + list(args) + self.gateway_args, capture_output=True, text=True, timeout=25)
        if result.returncode:
            # NemoClaw can confirm native RPC exit 0, then fail its optional host
            # container-inspection cleanup when a user service lacks Docker access.
            # Accept only that exact post-command condition for these two RPCs;
            # parse and validate the native JSON below. Never mask native failures.
            cleanup_only = (
                args[:2] == ("gateway", "call")
                and len(args) > 2 and args[2] in ("exec.approval.list", "exec.approval.resolve")
                and "OpenClaw permission cleanup failed (command exit 0; cleanup exit 1): permission inspection unavailable:" in result.stderr
                and "Direct sandbox container discovery failed" in result.stderr
            )
            if not cleanup_only:
                raise RuntimeError(f"OpenClaw {args[0]} {args[1]} returned {result.returncode}")
            if not getattr(self, "cleanup_warning", False):
                print("Native approval RPC confirmed; host permission inspection unavailable to this service.", file=sys.stderr, flush=True)
                self.cleanup_warning = True
        try:
            return cli_json(result.stdout)
        except ValueError:
            raise RuntimeError("OpenClaw returned non-JSON output; verify the CLI wrapper") from None

    def call(self, method, params=None):
        return self.claw("gateway", "call", method, "--params", canonical(params or {}), "--json")

    def receipt(self, approval, status, result, decision=None):
        key = (approval["id"], status, decision)
        if key in self.sent:
            return
        value = {"status": status, "result": result}
        if decision:
            value["decision"] = decision
        action = approval["action"]
        if isinstance(action, str):
            action = json.loads(action)
        value["actionHash"] = hashlib.sha256(canonical(action).encode()).hexdigest()
        self.api("/api/approvals/" + urllib.parse.quote(approval["id"], safe="") + "/receipt", value)
        self.sent.add(key)
        print(f"approval {approval['id']}: {status}" + (f" ({decision})" if decision else ""), flush=True)

    def tick(self):
        pending = self.call("exec.approval.list")
        if not isinstance(pending, list):
            raise ValueError("Expected native exec.approval.list to return an array")
        native_by_id = {}
        for native in pending:
            action = action_for(native)
            request = native["request"]
            expires_ms = native.get("expiresAtMs")
            if not isinstance(expires_ms, (int, float)):
                raise ValueError("Native approval expiry is missing")
            native_by_id[native["id"]] = native
            self.api("/api/approvals", {
                "source": "openclaw", "externalId": native["id"],
                "sessionKey": request.get("sessionKey"), "agentId": request.get("agentId"),
                "title": "Approve local command", "body": "Review the exact command and working directory. This permits one native execution.",
                "action": action,
                "expiresAt": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(expires_ms / 1000)) + f".{int(expires_ms) % 1000:03d}Z",
            })

        records = self.api("/api/approvals?source=openclaw").get("approvals")
        if not isinstance(records, list):
            raise ValueError("Shoal must return {approvals: [...]} for bridge polling")
        for approval in records:
            try:
                self.forward(approval, native_by_id)
            except Exception as error:
                # An old/expired native id must not block decisions for other workers.
                print(f"approval {approval.get('id', '?')}: {error}", file=sys.stderr, flush=True)
        return {"nativePending": len(pending), "shoalApprovals": len(records)}

    def forward(self, approval, native_by_id):
        external_id = approval.get("externalId")
        if not external_id or approval.get("receipt") or approval.get("receiptStatus"):
            return
        native = native_by_id.get(external_id)
        if native and not action_equal(approval, native):
            self.receipt(approval, "failed", {"error": "The native action differs from the action reviewed in Shoal; no decision was forwarded."})
            return
        decision = {"Approved": "allow-once", "Rejected": "deny"}.get(approval.get("status"))
        if decision:
            # OpenClaw 2026.7.1 has no `approvals resolve` CLI. Its RPC returns
            # ok:true for both the first resolution and a repeated SAME decision;
            # a conflicting decision is rejected. Repeating the id never reruns exec.
            result = self.call("exec.approval.resolve", {"id": external_id, "decision": decision})
            if result.get("ok") is not True:
                raise RuntimeError("Native approval resolver did not confirm the requested decision")
            self.receipt(approval, "resolved", result, decision)
        elif not native:
            expires = approval.get("expiresAt")
            if expires:
                import datetime
                if datetime.datetime.fromisoformat(expires.replace("Z", "+00:00")).timestamp() < time.time():
                    self.receipt(approval, "expired", {"reason": "Native request no longer pending and its deadline passed. No decision was forwarded by this bridge."})


def self_test():
    native = {"id": "native-1", "request": {"command": "printf 'approved\\n' > approved.txt", "cwd": "/sandbox/shoal", "sessionKey": "shoal:run_test"}}
    reviewed = {"action": canonical(action_for(native))}
    assert action_equal(reviewed, native)
    changed = json.loads(json.dumps(native))
    changed["request"]["cwd"] = "/sandbox/elsewhere"
    assert not action_equal(reviewed, changed)
    changed["request"] = {**native["request"], "command": "printf 'different\\n' > approved.txt"}
    assert not action_equal(reviewed, changed)
    assert canonical({"b": 2, "a": 1}) == canonical({"a": 1, "b": 2})
    assert cli_json("\x1b[32mActive gateway set to 'nemoclaw'\x1b[0m\n[]\n") == []
    print("Exact command/cwd binding and stable action serialization passed.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        sys.exit(0)
    bridge = Bridge()
    connected = False
    while True:
        try:
            counts = bridge.tick()
            if not connected or args.once:
                print("Bridge connected: " + canonical(counts), flush=True)
                connected = True
        except Exception as error:
            connected = False
            print(str(error), file=sys.stderr, flush=True)
            if args.once:
                sys.exit(1)
        if args.once:
            break
        time.sleep(1)
