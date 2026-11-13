#!/usr/bin/env python3
"""
Mini-Spark Master — run this on ONE laptop (Python 3.8+, stdlib only, nothing to install).

    python3 cluster/master.py              # serves the dashboard + API on 0.0.0.0:8000

Then on every computing laptop (including this one, if it should hash too):

    python3 cluster/worker.py --master <this-laptop-ip>:8000

The Master keeps the TaskChunk queue (dynamic, pull-based — H3), watches 500 ms heartbeats
with a 1 s timeout, rolls a dead worker's chunk back to its last checkpoint and re-queues it
with priority (H2), and serves frontend/ so every laptop can open http://<master-ip>:8000.

Master failover note: the web server itself keeps running, so "Kill Master" is a logical
fault injection here — the coordinator stops dispatching, misses its heartbeats, and the
Shadow Master node is promoted with the replicated queue state. A separate-process standby
Master is the W11 work item (S3).
"""
import argparse
import hashlib
import json
import mimetypes
import os
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(__file__).resolve().parent
FRONTEND = HERE.parent / "frontend"
CHARSET = "abcdefghijklmnopqrstuvwxyz0123456789"
PENDING, IN_FLIGHT, COMPLETED, RECOVERING = 0, 1, 2, 3   # ChunkStatus (framework_types.h)
HEARTBEAT_S, TIMEOUT_S = 0.5, 1.0
MAX_NODES, MAX_CHUNKS = 5, 4096
ROLE = {"master": "Master", "shadow": "Shadow Master", "worker": "Worker"}


class ApiError(Exception):
    def __init__(self, msg, code=400):
        super().__init__(msg)
        self.code = code


def index_to_password(index, length):
    out = []
    for _ in range(length):
        out.append(CHARSET[index % 36])
        index //= 36
    return "".join(reversed(out))


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))  # no packet is sent; just picks the Wi-Fi interface
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def fmt_compact(n):
    for v, suf in ((1e12, "T"), (1e9, "B"), (1e6, "M"), (1e3, "K")):
        if n >= v:
            return ("%.2f" % (n / v)).rstrip("0").rstrip(".") + suf
    return str(int(n))


def fmt_dur(sec):
    return "%.1f s" % sec if sec < 60 else "%dm %02ds" % (sec // 60, sec % 60)


class Cluster:
    def __init__(self, port):
        self.lock = threading.RLock()
        self.next_id = 0
        self.nodes = []
        self.job = None
        self.status = "idle"
        self.chunks = []
        self.events = []
        self.recoveries = []
        self.history = []
        self.elapsed = 0.0
        self.found = None
        self.last_sample = 0.0
        host = socket.gethostname().split(".")[0]
        self.server_node = self._new_node(host + "-master", lan_ip(), role="master", server=True)
        self.server_node.update(status="online", deviceLabel="Coordinator (master.py)", engine="—")
        self._log("ok", "Master %s started on %s:%d — waiting for workers" % (host, self.server_node["host"], port), "node")

    # ------------------------------------------------------------------ helpers
    def _new_node(self, name, host, role="worker", server=False):
        n = {
            "id": "n%d" % self.next_id, "name": name, "host": host, "role": role, "server": server,
            "mode": "cpu", "gpuAvailable": False, "deviceLabel": "", "engine": "", "os": "",
            "cpuThreads": os.cpu_count() or 4, "antiChoke": True, "threadsAllowed": 1,
            "alive": True, "status": "joining", "latencyMs": 0.0, "lastHb": time.time(), "hbSeq": 0,
            "chunkId": None, "mhs": 0.0, "estMhs": None, "cpuLoad": 0.0,
            "busy": 0.0, "idle": 0.0, "chunksDone": 0, "hashesDone": 0,
        }
        self.next_id += 1
        self._threads(n)
        self.nodes.append(n)
        return n

    @staticmethod
    def _threads(n):
        n["threadsAllowed"] = max(1, n["cpuThreads"] - 2) if n["antiChoke"] else n["cpuThreads"]

    def _log(self, level, msg, kind="info"):
        self.events.append({"t": self.elapsed * 1000, "level": level, "kind": kind, "msg": msg})
        del self.events[:-300]
        print("[%s] %s" % (level.upper(), msg), flush=True)

    def _node(self, nid):
        for n in self.nodes:
            if n["id"] == nid:
                return n
        raise ApiError("unknown node", 404)

    def _role(self, role):
        return next((n for n in self.nodes if n["role"] == role), None)

    def _coordinator_up(self):
        m = self._role("master")
        return bool(m and m["alive"] and m["status"] == "online")

    def _mode_label(self, n):
        if n["server"]:
            return "coordinator"
        if n["mode"] == "gpu":
            return "OpenCL GPU · " + (n["deviceLabel"] or "GPU")
        return "CPU · %d/%d threads%s" % (n["threadsAllowed"], n["cpuThreads"], " (Anti-Choke)" if n["antiChoke"] else "")

    # ------------------------------------------------------------------ job
    def create_job(self, b):
        with self.lock:
            if self.status == "running":
                raise ApiError("Stop the running job first.")
            h = str(b.get("targetHash", "")).strip().lower()
            if len(h) != 64 or any(c not in "0123456789abcdef" for c in h):
                raise ApiError("targetHash must be 64 hex characters")
            L, cs = int(b.get("length", 0)), int(b.get("chunkSize", 0))
            if not 1 <= L <= 10:
                raise ApiError("Password length must be 1–10")
            total = 36 ** L
            if cs < 1 or -(-total // cs) > MAX_CHUNKS:
                raise ApiError("Too many chunks — choose a bigger chunk size (max %d chunks)" % MAX_CHUNKS)
            self.job = {"targetHash": h, "length": L, "chunkSize": cs, "keyspace": total, "targetLabel": b.get("targetLabel") or "SHA-256 hash"}
            self._reset_queue()
            self._log("info", "Job created · L=%d · keyspace %s · %d chunks × %s" % (L, fmt_compact(total), len(self.chunks), fmt_compact(cs)), "job")
            return self.state()

    def _reset_queue(self):
        self.chunks = []
        s, i = 0, 0
        while s < self.job["keyspace"]:
            e = min(self.job["keyspace"], s + self.job["chunkSize"])
            self.chunks.append({"id": i, "start": s, "end": e, "checkpoint": s, "cursor": s, "nodeId": None, "status": PENDING})
            s, i = e, i + 1
        self.status, self.elapsed, self.found = "ready", 0.0, None
        self.recoveries, self.history, self.events = [], [], []
        self.last_sample = 0.0
        for n in self.nodes:
            n.update(chunkId=None, busy=0.0, idle=0.0, chunksDone=0, hashesDone=0, mhs=0.0)

    def start(self):
        with self.lock:
            if not self.job:
                raise ApiError("Create a job first.")
            if self.status in ("found", "exhausted"):
                raise ApiError("Job finished — reset to run again.")
            if not self._coordinator_up():
                raise ApiError("No online Master — restart a node first.")
            workers = [n for n in self.nodes if n["role"] != "master" and n["status"] == "online"]
            if not workers:
                raise ApiError("No workers online. Run: python3 cluster/worker.py --master %s:%d" % (self.server_node["host"], PORT))
            resumed = self.elapsed > 0
            self.status = "running"
            self._log("ok", "Computation resumed" if resumed else "Computation started on %d worker node%s" % (len(workers), "s" if len(workers) > 1 else ""), "job")
            return self.state()

    def stop(self):
        with self.lock:
            if self.status == "running":
                self.status = "paused"
                for c in self.chunks:
                    if c["status"] == IN_FLIGHT:
                        c.update(status=PENDING, nodeId=None, cursor=c["checkpoint"])
                for n in self.nodes:
                    n["chunkId"] = None
                self._log("info", "Computation paused — in-flight chunks keep their checkpoints", "job")
            return self.state()

    def reset(self):
        with self.lock:
            if self.job:
                self._reset_queue()
                for n in self.nodes:
                    n["chunkId"] = None
                self._log("info", "Job reset — chunk queue regenerated", "job")
            return self.state()

    # ------------------------------------------------------------------ dashboard node ops
    def update_node(self, nid, b):
        with self.lock:
            n = self._node(nid)
            running = self.status == "running"
            if "role" in b and b["role"] != n["role"]:
                r = b["role"]
                if running:
                    raise ApiError("Change roles while the job is stopped.")
                if r == "master" or n["role"] == "master":
                    raise ApiError("The Master is the laptop running master.py — use Kill Master to test failover.")
                if r == "shadow":
                    old = self._role("shadow")
                    if old:
                        old["role"] = "worker"
                n["role"] = r
                self._log("info", "%s is now %s" % (n["name"], ROLE[r]), "node")
            if b.get("name"):
                n["name"] = str(b["name"])[:32]
            if b.get("host"):
                n["host"] = str(b["host"])[:64]
            cfg = False
            if b.get("mode") in ("gpu", "cpu") and b["mode"] != n["mode"]:
                if b["mode"] == "gpu" and not n["gpuAvailable"]:
                    raise ApiError("%s has no OpenCL GPU — CPU mode only." % n["name"])
                n["mode"] = b["mode"]
                n["estMhs"] = None
                cfg = True
            if "antiChoke" in b:
                n["antiChoke"] = bool(b["antiChoke"])
                cfg = True
            if b.get("cpuThreads"):
                n["cpuThreads"] = max(1, min(256, int(b["cpuThreads"])))
                cfg = True
            self._threads(n)
            if cfg:
                self._log("info", "%s → %s (applies from its next chunk)" % (n["name"], self._mode_label(n)), "node")
            return self.state()

    def remove_node(self, nid):
        with self.lock:
            n = self._node(nid)
            if n["server"] or n["role"] == "master":
                raise ApiError("The Master cannot be removed.")
            if self.status == "running" and n["status"] != "offline":
                raise ApiError("Stop the job (or kill the node) before removing it.")
            self._recover(n, quiet=True)
            self.nodes.remove(n)
            self._log("info", "%s removed from the cluster" % n["name"], "node")
            return self.state()

    def kill(self, nid):
        with self.lock:
            n = self._node(nid)
            if n["alive"]:
                n["alive"] = False
                self._log("error", "💥 Fault injected: %s (%s) process killed" % (n["name"], ROLE[n["role"]]), "fault")
            return self.state()

    def kill_master(self):
        with self.lock:
            m = self._role("master")
            if not m:
                raise ApiError("No Master")
            return self.kill(m["id"])

    def revive(self, nid):
        with self.lock:
            n = self._node(nid)
            if n["alive"]:
                return self.state()
            n["alive"] = True
            n["status"] = "joining"
            n["lastHb"] = time.time()
            if n["role"] == "master" and self._role("master") is not n:
                n["role"] = "worker"
            if n["role"] == "worker" and not self._role("shadow"):
                n["role"] = "shadow"
                self._log("info", "%s restarted — rejoins as the new Shadow Master (standby)" % n["name"], "node")
            else:
                self._log("info", "%s restarted — re-registering with the Master" % n["name"], "node")
            return self.state()

    # ------------------------------------------------------------------ worker protocol
    def register(self, b, ip):
        with self.lock:
            name = str(b.get("name") or ip)[:32]
            n = next((x for x in self.nodes if x["name"] == name and not x["server"]), None)
            if n is None:
                if len(self.nodes) >= MAX_NODES:
                    raise ApiError("Cluster is full (%d laptops)." % MAX_NODES, 409)
                role = "worker" if self._role("shadow") else "shadow"
                n = self._new_node(name, ip, role=role)
                self._log("info", "%s (%s) registered as %s" % (name, ip, ROLE[role]), "node")
            else:
                self._recover(n)
                self._log("info", "%s (%s) re-registered" % (name, ip), "node")
            gpu = b.get("gpu") or {}
            n.update(host=ip, alive=True, status="joining", lastHb=time.time(),
                     gpuAvailable=bool(gpu.get("available")), engine=b.get("engine", ""), os=b.get("os", ""),
                     cpuThreads=int(b.get("cpuThreads") or n["cpuThreads"]))
            n["mode"] = b.get("mode") if b.get("mode") in ("gpu", "cpu") else n["mode"]
            if n["mode"] == "gpu" and not n["gpuAvailable"]:
                n["mode"] = "cpu"
            n["deviceLabel"] = (gpu.get("name") or "GPU") + (" (%d CU)" % gpu["computeUnits"] if gpu.get("computeUnits") else "") if n["gpuAvailable"] else ""
            self._threads(n)
            return {"nodeId": n["id"], "role": n["role"], "config": self._cfg(n)}

    def _cfg(self, n):
        return {"mode": n["mode"], "antiChoke": n["antiChoke"], "cpuThreads": n["cpuThreads"]}

    def heartbeat(self, b):
        with self.lock:
            n = self._node(b.get("nodeId"))
            if not n["alive"]:
                return {"command": "die"}
            now = time.time()
            n["lastHb"], n["hbSeq"] = now, n["hbSeq"] + 1
            n["latencyMs"] = float(b.get("rttMs") or 0)
            n["mhs"] = float(b.get("mhs") or 0)
            n["cpuLoad"] = float(b.get("cpuLoad") or 0)
            if n["mhs"] > 0 and b.get("mode") == n["mode"]:
                n["estMhs"] = n["mhs"] if n["estMhs"] is None else n["estMhs"] * 0.7 + n["mhs"] * 0.3
            if n["status"] != "online":
                n["status"] = "online"
                self._log("ok", "%s online · %s" % (n["name"], self._mode_label(n)), "node")
            cmd = None
            cid, cur = b.get("chunkId"), b.get("currentIndex")
            if cid is not None:
                c = self.chunks[cid] if 0 <= cid < len(self.chunks) else None
                if c and c["status"] == IN_FLIGHT and c["nodeId"] == n["id"] and self.status == "running":
                    if cur is not None and c["start"] <= cur <= c["end"]:
                        c["checkpoint"] = c["cursor"] = max(c["cursor"], int(cur))  # checkpoint_index
                else:
                    cmd = "abort"  # chunk was recovered elsewhere, job paused/reset, or found
            return {"command": cmd, "config": self._cfg(n)}

    def request(self, b):
        with self.lock:
            n = self._node(b.get("nodeId"))
            if (not n["alive"] or n["status"] != "online" or n["role"] == "master"
                    or self.status != "running" or not self._coordinator_up() or n["chunkId"] is not None):
                return {"chunk": None, "retryMs": 300}
            c = next((x for x in self.chunks if x["status"] == RECOVERING), None) or next((x for x in self.chunks if x["status"] == PENDING), None)
            if not c:
                return {"chunk": None, "retryMs": 500}
            if c["status"] == RECOVERING:
                r = next((x for x in self.recoveries if x["chunkId"] == c["id"] and x["toNodeId"] is None), None)
                if r:
                    r["toNodeId"] = n["id"]
                self._log("ok", "Chunk #%d resumed by %s from checkpoint %s" % (c["id"], n["name"], format(c["checkpoint"], ",")), "recovery")
            c.update(status=IN_FLIGHT, nodeId=n["id"])
            n["chunkId"] = c["id"]
            return {"chunk": {"id": c["id"], "from": c["cursor"], "end": c["end"]},
                    "job": {"targetHash": self.job["targetHash"], "length": self.job["length"]},
                    "config": self._cfg(n)}

    def result(self, b):
        with self.lock:
            n = self._node(b.get("nodeId"))
            cid = b.get("chunkId")
            c = self.chunks[cid] if isinstance(cid, int) and 0 <= cid < len(self.chunks) else None
            if c is None:
                return {"ok": False}
            n["hashesDone"] += int(b.get("hashes") or 0)
            if b.get("found") and self.status not in ("found",):
                idx = int(b["index"])
                pw = index_to_password(idx, self.job["length"])
                if hashlib.sha256(pw.encode()).hexdigest() == self.job["targetHash"]:  # Master re-verifies
                    c.update(status=COMPLETED, cursor=idx + 1, checkpoint=idx + 1, nodeId=n["id"])
                    n["chunkId"] = None
                    self.status = "found"
                    self.found = {"password": pw, "index": idx, "nodeId": n["id"], "nodeName": n["name"], "chunkId": c["id"],
                                   "elapsedMs": self.elapsed * 1000, "hashesComputed": sum(x["hashesDone"] for x in self.nodes)}
                    for x in self.nodes:
                        x["mhs"] = 0.0
                    self._log("ok", "🔑 Password recovered by %s: \"%s\" at index %s (chunk #%d) in %s" % (n["name"], pw, format(idx, ","), c["id"], fmt_dur(self.elapsed)), "found")
                    return {"ok": True}
                self._log("warn", "%s reported a match that failed verification — ignored" % n["name"], "job")
            if c["status"] == IN_FLIGHT and c["nodeId"] == n["id"]:
                c.update(status=COMPLETED, cursor=c["end"], checkpoint=c["end"])
                n["chunkId"] = None
                n["chunksDone"] += 1
                if self.status == "running" and all(x["status"] == COMPLETED for x in self.chunks):
                    self.status = "exhausted"
                    self._log("warn", "Keyspace exhausted in %s — no password of length %d matches this hash" % (fmt_dur(self.elapsed), self.job["length"]), "job")
            return {"ok": True}

    # ------------------------------------------------------------------ fault tolerance
    def _recover(self, n, quiet=False):
        cid = n["chunkId"]
        n["chunkId"] = None
        if cid is None or cid >= len(self.chunks):
            return
        c = self.chunks[cid]
        if c["status"] != IN_FLIGHT or c["nodeId"] != n["id"]:
            return
        span = c["end"] - c["start"]
        lost = max(0, int(c["cursor"] - c["checkpoint"]))
        c.update(status=RECOVERING, nodeId=None, cursor=c["checkpoint"])
        rec = {"t": self.elapsed * 1000, "chunkId": c["id"], "fromNodeId": n["id"], "toNodeId": None, "checkpoint": c["checkpoint"],
               "start": c["start"], "end": c["end"], "lostHashes": lost, "savedPct": (c["checkpoint"] - c["start"]) / span * 100}
        self.recoveries.append(rec)
        del self.recoveries[:-50]
        if not quiet:
            self._log("warn", "Chunk #%d rolled back to checkpoint %s (%.0f%% kept) → RECOVERING" % (c["id"], format(c["checkpoint"], ","), rec["savedPct"]), "recovery")

    def _failover(self, dead):
        self._log("error", "Master %s missed heartbeats → primary coordinator lost" % dead["name"], "fault")
        shadow = next((x for x in self.nodes if x["role"] == "shadow" and x["alive"] and x["status"] == "online"), None)
        if not shadow:
            if self.status == "running":
                self.status = "halted"
            self._log("error", "No Shadow Master available — cluster halted (single point of failure)", "fault")
            return
        dead["role"] = "worker"
        shadow["role"] = "master"
        self._recover(shadow)  # the new Master stops hashing; its chunk goes back to the queue
        done = sum(1 for c in self.chunks if c["status"] == COMPLETED)
        self._log("ok", "👑 Shadow Master %s promoted to Master — replicated queue state restored (%d/%d chunks done)" % (shadow["name"], done, len(self.chunks)), "failover")
        if self.status == "halted":
            self.status = "running"

    def monitor(self):
        last = time.time()
        while True:
            time.sleep(0.1)
            with self.lock:
                now = time.time()
                dt = now - last
                last = now
                running = self.status == "running"
                if running:
                    self.elapsed += dt
                s = self.server_node  # the server's own heartbeat
                if s["alive"] and now - s["lastHb"] >= HEARTBEAT_S:
                    s.update(lastHb=now, hbSeq=s["hbSeq"] + 1, status="online", cpuLoad=4.0)
                for n in self.nodes:
                    if n["status"] != "offline" and now - n["lastHb"] > TIMEOUT_S:
                        n["status"], n["mhs"] = "offline", 0.0
                        if n["role"] == "master":
                            self._failover(n)
                        else:
                            self._log("warn", "Heartbeat timeout: %s silent for %d ms → marked OFFLINE" % (n["name"], (now - n["lastHb"]) * 1000), "fault")
                        self._recover(n)
                    if running and n["role"] != "master" and n["status"] == "online":
                        if n["chunkId"] is not None:
                            n["busy"] += dt
                        else:
                            n["idle"] += dt
                if running and self.elapsed - self.last_sample >= 0.5:
                    self.last_sample = self.elapsed
                    self.history.append(self._throughput())
                    del self.history[:-120]
                if running and all(c["status"] == COMPLETED for c in self.chunks) and self.chunks:
                    self.status = "exhausted"

    def _throughput(self):
        if self.status != "running":
            return 0.0
        return sum(n["mhs"] for n in self.nodes if n["status"] == "online" and n["role"] != "master")

    # ------------------------------------------------------------------ snapshot
    def state(self):
        with self.lock:
            now = time.time()
            counts = [0, 0, 0, 0]
            scanned = 0
            for c in self.chunks:
                counts[c["status"]] += 1
                scanned += c["cursor"] - c["start"]
            busy = sum(n["busy"] for n in self.nodes if not n["server"])
            idle = sum(n["idle"] for n in self.nodes if not n["server"])
            nodes = []
            for n in self.nodes:
                c = self.chunks[n["chunkId"]] if n["chunkId"] is not None else None
                on = n["status"] == "online"
                nodes.append({
                    "id": n["id"], "name": n["name"], "host": n["host"], "role": n["role"], "mode": n["mode"],
                    "device": n["deviceLabel"], "deviceLabel": n["deviceLabel"] or ("C engine" if n["engine"] == "cpu" else n["engine"]),
                    "gpuAvailable": n["gpuAvailable"], "server": n["server"], "os": n["os"],
                    "cpuThreads": n["cpuThreads"], "antiChoke": n["antiChoke"], "threadsAllowed": n["threadsAllowed"],
                    "status": n["status"], "alive": n["alive"], "latencyMs": n["latencyMs"],
                    "heartbeatAgeMs": (now - n["lastHb"]) * 1000, "hbSeq": n["hbSeq"],
                    "chunkId": n["chunkId"], "chunkProgress": (c["cursor"] - c["start"]) / (c["end"] - c["start"]) if c else 0,
                    "checkpoint": c["checkpoint"] if c else None,
                    "mhs": n["mhs"] if on and self.status == "running" else 0.0, "estMhs": n["estMhs"],
                    "cpuLoad": n["cpuLoad"] if on else 0.0, "chunksDone": n["chunksDone"], "hashesDone": n["hashesDone"],
                })
            job = {"status": "idle"}
            if self.job:
                job = dict(self.job, status=self.status, totalChunks=len(self.chunks), elapsedMs=self.elapsed * 1000, scanned=scanned, result=self.found)
            m = self._role("master")
            return {
                "mode": "live", "job": job, "activeMasterId": m["id"] if m else None, "nodes": nodes,
                "chunks": [{k: c[k] for k in ("id", "start", "end", "checkpoint", "cursor", "nodeId", "status")} for c in self.chunks],
                "metrics": {"throughputMhs": self._throughput(), "history": list(self.history),
                            "scannedPct": scanned / self.job["keyspace"] * 100 if self.job else 0,
                            "pending": counts[0], "inFlight": counts[1], "completed": counts[2], "recovering": counts[3],
                            "efficiencyPct": busy / (busy + idle) * 100 if busy + idle > 0 else None},
                "recoveries": self.recoveries[-12:], "events": self.events[-80:],
            }


# ====================================================================== HTTP
CLUSTER = None
PORT = 8000


class Handler(BaseHTTPRequestHandler):
    server_version = "MiniSpark/1.0"

    def log_message(self, *a):
        pass

    def _send(self, code, obj=None, body=None, ctype="application/json"):
        data = body if body is not None else json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        raw = self.rfile.read(n)
        try:
            return json.loads(raw)
        except ValueError:
            raise ApiError("Body must be JSON")

    def _route(self, method):
        u = urlparse(self.path)
        p = u.path.rstrip("/") or "/"
        C = CLUSTER
        try:
            if p.startswith("/api/"):
                b = self._body() if method in ("POST", "PATCH") else {}
                if method == "GET" and p == "/api/health":
                    return self._send(200, {"ok": True})
                if method == "GET" and p == "/api/state":
                    return self._send(200, C.state())
                if method == "POST" and p == "/api/job":
                    return self._send(200, C.create_job(b))
                if method == "POST" and p in ("/api/job/start", "/api/job/stop", "/api/job/reset"):
                    return self._send(200, getattr(C, p.rsplit("/", 1)[1])())
                if method == "POST" and p == "/api/nodes":
                    raise ApiError("Laptops join by themselves: run  python3 cluster/worker.py --master %s:%d  on that laptop." % (C.server_node["host"], PORT))
                if p.startswith("/api/nodes/") and method in ("PATCH", "DELETE"):
                    nid = p.rsplit("/", 1)[1]
                    return self._send(200, C.update_node(nid, b) if method == "PATCH" else C.remove_node(nid))
                if method == "POST" and p == "/api/fault/kill-node":
                    return self._send(200, C.kill(b.get("nodeId")))
                if method == "POST" and p == "/api/fault/kill-master":
                    return self._send(200, C.kill_master())
                if method == "POST" and p == "/api/fault/revive":
                    return self._send(200, C.revive(b.get("nodeId")))
                if method == "POST" and p == "/api/worker/register":
                    return self._send(200, C.register(b, self.client_address[0] if self.client_address[0] != "127.0.0.1" else C.server_node["host"]))
                if method == "POST" and p == "/api/worker/heartbeat":
                    return self._send(200, C.heartbeat(b))
                if method == "POST" and p == "/api/worker/request":
                    return self._send(200, C.request(b))
                if method == "POST" and p == "/api/worker/result":
                    return self._send(200, C.result(b))
                if method == "GET" and p == "/api/worker/status":
                    nid = (parse_qs(u.query).get("nodeId") or [""])[0]
                    with C.lock:
                        return self._send(200, {"alive": C._node(nid)["alive"]})
                raise ApiError("Not found", 404)
            if method != "GET":
                raise ApiError("Not found", 404)
            f = (FRONTEND / ("index.html" if p == "/" else p.lstrip("/"))).resolve()
            if FRONTEND.resolve() not in f.parents or not f.is_file():
                raise ApiError("Not found", 404)
            return self._send(200, body=f.read_bytes(), ctype=mimetypes.guess_type(str(f))[0] or "application/octet-stream")
        except ApiError as e:
            return self._send(e.code, {"error": str(e)})
        except Exception as e:  # never kill the server on a bad request
            return self._send(500, {"error": "%s: %s" % (type(e).__name__, e)})

    def do_GET(self):
        self._route("GET")

    def do_POST(self):
        self._route("POST")

    def do_PATCH(self):
        self._route("PATCH")

    def do_DELETE(self):
        self._route("DELETE")


def main():
    global CLUSTER, PORT
    ap = argparse.ArgumentParser(description="Mini-Spark Master: dashboard + task queue")
    ap.add_argument("--port", type=int, default=8000)
    a = ap.parse_args()
    PORT = a.port
    CLUSTER = Cluster(PORT)
    threading.Thread(target=CLUSTER.monitor, daemon=True).start()
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    srv.daemon_threads = True
    ip = CLUSTER.server_node["host"]
    print("""
==================================================================
  MINI-SPARK MASTER is running
  Dashboard on this laptop : http://localhost:%d
  Dashboard for the team   : http://%s:%d
  Start a worker on each laptop (this one too, if it should hash):
      python3 cluster/worker.py --master %s:%d
  Stop with Ctrl+C
==================================================================""" % (PORT, ip, PORT, ip, PORT), flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nMaster stopped.")


if __name__ == "__main__":
    main()
