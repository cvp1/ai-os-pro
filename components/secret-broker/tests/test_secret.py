#!/usr/bin/env python3
"""Validation for the ai-os secret broker.

Runs on any box (no OS keyring needed): the keyring layer is stubbed with an
in-memory store, SMTP is stubbed, and `fetch` hits a real local HTTP server.
What it proves: the capability interface, the two actions, the metadata-only
audit, the no-`get`-verb guarantee, and the ZERO-LEAK property (a stored value
appears in none of our stdout/stderr/audit/index outputs).

The native `security`/`secret-tool` calls themselves are thin wrappers reviewed
by hand; they must be live-validated on a machine with a real keyring.

    python3 test_secret.py    # exits 0 on pass, 1 on failure
"""
import importlib.util
from importlib.machinery import SourceFileLoader
import io
import os
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

SENTINEL = "SUPERSECRET-VALUE-DEADBEEF-9f3a"  # must never leak into our output

FAILURES = []


def check(cond, label):
    print(("PASS " if cond else "FAIL ") + label)
    if not cond:
        FAILURES.append(label)


# --- load the broker as a module, with HOME pointed at a throwaway dir -------
TMP = tempfile.mkdtemp(prefix="secret-test-")
os.environ["HOME"] = TMP
BROKER = os.path.join(os.path.dirname(__file__), "..", "secret")
spec = importlib.util.spec_from_loader("secretbroker", SourceFileLoader("secretbroker", BROKER))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
# recompute paths against the temp HOME (module captured them at import)
mod.HOME = TMP
mod.AIOS_DIR = os.path.join(TMP, "ai-os")
mod.AUDIT_PATH = os.path.join(mod.AIOS_DIR, ".secrets-audit.jsonl")
mod.INDEX_PATH = os.path.join(mod.AIOS_DIR, ".secret-handles")

# --- stub the keyring layer (in-memory) --------------------------------------
STORE = {}
mod._kr_store = lambda name, value: STORE.__setitem__(name, value)
mod._kr_get = lambda name: STORE[name] if name in STORE else (_ for _ in ()).throw(
    mod.BrokerError(f"no secret stored for secret://{name}"))
mod._kr_delete = lambda name: STORE.pop(name, None)


# --- capture stdout/stderr (handles both text and bytes writes) --------------
class Cap:
    def __init__(self):
        self.buffer = io.BytesIO()

    def write(self, s):
        self.buffer.write(s.encode() if isinstance(s, str) else s)

    def flush(self):
        pass

    def isatty(self):
        return False

    def value(self):
        return self.buffer.getvalue().decode(errors="replace")


def run(argv, stdin_text=None):
    out, err = Cap(), Cap()
    o0, e0, i0 = sys.stdout, sys.stderr, sys.stdin
    sys.stdout, sys.stderr = out, err
    if stdin_text is not None:
        sys.stdin = io.StringIO(stdin_text)
    try:
        rc = mod.main(argv)
    except SystemExit as e:   # argparse errors
        rc = e.code
    finally:
        sys.stdout, sys.stderr, sys.stdin = o0, e0, i0
    return rc, out.value(), err.value()


ALL_OUTPUT = []  # everything WE emit; the leak check runs over this


def record(rc, out, err):
    ALL_OUTPUT.append(out)
    ALL_OUTPUT.append(err)
    return rc, out, err


# --- 1. set (via piped stdin, no echo path) ----------------------------------
rc, out, err = record(*run(["set", "secret://test-key"], stdin_text=SENTINEL + "\n"))
check(rc == 0 and STORE.get("test-key") == SENTINEL, "set stores the value in the keyring")
check("test-key" in mod._index_read(), "set adds the handle to the names-only index")
check(SENTINEL not in out and SENTINEL not in err, "set never echoes the value")

# --- 2. list (names only) ----------------------------------------------------
rc, out, err = record(*run(["list"]))
check(rc == 0 and "secret://test-key" in out, "list shows the handle")
check(SENTINEL not in out, "list never shows a value")

# --- 3. NO get verb ----------------------------------------------------------
rc, out, err = record(*run(["get", "secret://test-key"]))
check(rc != 0, "there is no `get` verb (argparse rejects it)")
choices = set(mod.build_parser()._subparsers._group_actions[0].choices)
check("get" not in choices and choices == {"set", "send-email", "fetch", "list", "revoke"},
      "verb set is exactly {set, send-email, fetch, list, revoke}")

# --- 4. send-email (SMTP stubbed) -------------------------------------------
import smtplib
CAPTURED = {}


class FakeSMTP:
    def __init__(self, host, port, timeout=None):
        CAPTURED["host"] = host
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def starttls(self): pass
    def login(self, user, pw): CAPTURED["login"] = (user, pw)
    def send_message(self, msg): CAPTURED["to"] = msg["To"]


_orig_smtp = smtplib.SMTP
smtplib.SMTP = FakeSMTP
try:
    rc, out, err = record(*run([
        "send-email", "secret://test-key",
        "--to", "alice@example.com", "--subject", "hi",
        "--body", "hello", "--from", "me@example.com",
    ]))
finally:
    smtplib.SMTP = _orig_smtp
check(rc == 0 and CAPTURED.get("login") == ("me@example.com", SENTINEL),
      "send-email uses the stored password to authenticate")
check("sent to alice@example.com" in out, "send-email returns only the outcome")
check(SENTINEL not in out and SENTINEL not in err, "send-email never prints the password")

# --- 5. fetch (real local HTTP server) --------------------------------------
WIRE = {}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        WIRE["auth"] = self.headers.get("Authorization")
        body = b'{"ok":true,"data":123}'
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a): pass


srv = HTTPServer(("127.0.0.1", 0), Handler)
port = srv.server_address[1]
threading.Thread(target=srv.handle_request, daemon=True).start()
rc, out, err = record(*run([
    "fetch", "secret://test-key",
    "--url", f"http://127.0.0.1:{port}/x", "--inject", "bearer",
]))
srv.server_close()
check(rc == 0 and '"ok":true' in out, "fetch returns the response body")
check(WIRE.get("auth") == f"Bearer {SENTINEL}", "fetch injects the secret as a bearer token on the wire")
check(SENTINEL not in out and SENTINEL not in err, "fetch never prints the injected secret")

# --- 6. audit is metadata-only ----------------------------------------------
audit = open(mod.AUDIT_PATH).read() if os.path.exists(mod.AUDIT_PATH) else ""
check("send-email" in audit and "fetch" in audit, "audit records the actions")
check("example.com" in audit and "127.0.0.1" in audit, "audit records coarse targets")
check("alice@example.com" not in audit, "audit does NOT record the full recipient")
check(SENTINEL not in audit, "audit never records the value")

# --- 7. revoke ---------------------------------------------------------------
rc, out, err = record(*run(["revoke", "secret://test-key"]))
check(rc == 0 and "test-key" not in STORE, "revoke deletes the keyring entry")
check("test-key" not in mod._index_read(), "revoke removes the handle from the index")

# --- 8. THE ZERO-LEAK GUARANTEE ---------------------------------------------
index_file = open(mod.INDEX_PATH).read() if os.path.exists(mod.INDEX_PATH) else ""
leaked_in = []
for i, chunk in enumerate(ALL_OUTPUT):
    if SENTINEL in chunk:
        leaked_in.append(f"output#{i}")
if SENTINEL in audit:
    leaked_in.append("audit")
if SENTINEL in index_file:
    leaked_in.append("index")
check(not leaked_in, f"ZERO-LEAK: value appears in none of our outputs (leaked in: {leaked_in})")

# --- 9. handle validation ----------------------------------------------------
rc, _, _ = record(*run(["revoke", "secret://../etc/passwd"]))
check(rc != 0, "malformed handle names are rejected")
rc, _, _ = record(*run(["revoke", "plain-name-no-scheme"]))
check(rc != 0, "a non-secret:// argument is rejected")

print()
if FAILURES:
    print(f"{len(FAILURES)} FAILURE(S): {FAILURES}")
    sys.exit(1)
print("all checks passed")
sys.exit(0)
