#!/usr/bin/env python3
"""
Mini-Spark worker — run this on EVERY laptop that should compute (Python 3.8+, stdlib only).

    python3 cluster/worker.py --master 192.168.1.10:8000
    python3 cluster/worker.py --master localhost:8000 --name my-mac --mode cpu

What it does (PROJECT_WIKI.md § 3.4):
  1. registers this laptop's hardware with the Master (CPU threads, OpenCL GPU if any)
  2. pulls a chunk [start, end) from the Master queue          (MSG_REQUEST_TASK / ASSIGN_TASK)
  3. hashes it locally on the GPU (OpenCL) or CPU (C engine, Anti-Choke threads)
  4. sends a heartbeat every 500 ms with current_index + MH/s  (MSG_HEARTBEAT, checkpoint)
  5. reports the result                                        (MSG_TASK_RESULT)

Compute engines, best first:
  gpu  — kernels/sha256_kernel.cl from src_w8_w9 via the system OpenCL driver (ctypes)
  cpu  — engine/ms_cpu_engine.c, compiled automatically with cc/gcc/clang (pthreads)
  py   — pure-Python hashlib fallback with multiprocessing (slow, but works anywhere)
"""
import argparse
import ctypes
import hashlib
import json
import multiprocessing as mp
import os
import platform
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
CHARSET = "abcdefghijklmnopqrstuvwxyz0123456789"
HEARTBEAT_S = 0.5

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def index_to_password(index, length):
    out = []
    for _ in range(length):
        out.append(CHARSET[index % 36])
        index //= 36
    return "".join(reversed(out))


# =============================================================================== engines
class Aborted(Exception):
    pass


class CEngine:
    """Native pthreads engine (fast CPU path)."""
    name = "cpu"

    def __init__(self):
        self.binary = None
        self.done = 0
        self.proc = None
        src = HERE / "engine" / "ms_cpu_engine.c"
        out = HERE / "build" / ("ms_cpu_engine.exe" if os.name == "nt" else "ms_cpu_engine")
        if out.exists() and out.stat().st_mtime >= src.stat().st_mtime:
            self.binary = out
            return
        cc = next((c for c in ("cc", "clang", "gcc") if shutil.which(c)), None)
        if not cc:
            return
        out.parent.mkdir(exist_ok=True)
        r = subprocess.run([cc, "-O3", "-pthread", "-o", str(out), str(src)], capture_output=True, text=True)
        if r.returncode == 0:
            self.binary = out
        else:
            log("C engine build failed, using Python fallback:\n" + r.stderr[-800:])

    @property
    def ok(self):
        return self.binary is not None

    def run(self, target_hex, start, end, length, threads, stop):
        self.done = 0
        self.proc = subprocess.Popen(
            [str(self.binary), target_hex, str(start), str(end), str(length), str(threads)],
            stdout=subprocess.PIPE, text=True, bufsize=1,
        )
        result = None
        try:
            for line in self.proc.stdout:
                if stop.is_set():
                    raise Aborted()
                kind, _, val = line.strip().partition(" ")
                if kind == "P":
                    self.done = int(val)
                elif kind == "F":
                    result = ("found", int(val))
                elif kind == "D":
                    self.done = int(val)
                    result = ("done", None)
            if result is None:
                raise Aborted()
            return result
        finally:
            if self.proc.poll() is None:
                self.proc.kill()
            self.proc.wait()

    def abort(self):
        if self.proc and self.proc.poll() is None:
            self.proc.kill()


def _py_scan(target, start, end, length, stride_id, nproc, done, found, found_idx):
    tgt = bytes.fromhex(target)
    block = 4096
    s = start + stride_id * block
    while s < end and not found.value:
        e = min(end, s + block)
        for idx in range(s, e):
            pw = index_to_password(idx, length).encode()
            if hashlib.sha256(pw).digest() == tgt:
                found_idx.value = idx
                found.value = 1
                break
        with done.get_lock():
            done.value += e - s
        s += block * nproc


class PyEngine:
    """Pure-Python fallback: hashlib + multiprocessing."""
    name = "py"
    ok = True

    def __init__(self):
        self._done = None
        self.procs = []

    @property
    def done(self):
        return self._done.value if self._done is not None else 0

    def run(self, target_hex, start, end, length, threads, stop):
        self._done = mp.Value("Q", 0)
        found, found_idx = mp.Value("i", 0), mp.Value("Q", 0)
        self.procs = [mp.Process(target=_py_scan, args=(target_hex, start, end, length, i, threads, self._done, found, found_idx), daemon=True) for i in range(threads)]
        for p in self.procs:
            p.start()
        try:
            while any(p.is_alive() for p in self.procs):
                if stop.is_set():
                    raise Aborted()
                time.sleep(0.05)
            return ("found", found_idx.value) if found.value else ("done", None)
        finally:
            self.abort()

    def abort(self):
        for p in self.procs:
            if p.is_alive():
                p.terminate()


class GpuEngine:
    """OpenCL engine running src_w8_w9/kernels/sha256_kernel.cl in batches,
    so heartbeats can report progress and an abort takes effect within ~0.1 s."""
    name = "gpu"

    def __init__(self):
        self.ok = False
        self.device_name = None
        self.compute_units = 0
        self.done = 0
        self.batch = 1 << 22
        try:
            self._init()
            self.ok = True
        except Exception as e:  # no driver / no GPU / build error
            self.error = str(e)

    def _lib(self):
        sysname = platform.system()
        if sysname == "Darwin":
            return ctypes.CDLL("/System/Library/Frameworks/OpenCL.framework/OpenCL")
        if sysname == "Windows":
            return ctypes.WinDLL("OpenCL.dll")
        return ctypes.CDLL("libOpenCL.so.1")

    def _init(self):
        cl = self.cl = self._lib()
        vp, u32, i32, sz = ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int32, ctypes.c_size_t
        P = ctypes.POINTER
        cl.clGetPlatformIDs.argtypes = [u32, P(vp), P(u32)]
        cl.clGetDeviceIDs.argtypes = [vp, ctypes.c_uint64, u32, P(vp), P(u32)]
        cl.clGetDeviceInfo.argtypes = [vp, u32, sz, vp, P(sz)]
        cl.clCreateContext.argtypes = [vp, u32, P(vp), vp, vp, P(i32)]
        cl.clCreateContext.restype = vp
        cl.clCreateCommandQueue.argtypes = [vp, vp, ctypes.c_uint64, P(i32)]
        cl.clCreateCommandQueue.restype = vp
        cl.clCreateProgramWithSource.argtypes = [vp, u32, P(ctypes.c_char_p), P(sz), P(i32)]
        cl.clCreateProgramWithSource.restype = vp
        cl.clBuildProgram.argtypes = [vp, u32, P(vp), ctypes.c_char_p, vp, vp]
        cl.clGetProgramBuildInfo.argtypes = [vp, vp, u32, sz, vp, P(sz)]
        cl.clCreateKernel.argtypes = [vp, ctypes.c_char_p, P(i32)]
        cl.clCreateKernel.restype = vp
        cl.clCreateBuffer.argtypes = [vp, ctypes.c_uint64, sz, vp, P(i32)]
        cl.clCreateBuffer.restype = vp
        cl.clSetKernelArg.argtypes = [vp, u32, sz, vp]
        cl.clEnqueueNDRangeKernel.argtypes = [vp, vp, u32, P(sz), P(sz), P(sz), u32, vp, vp]
        cl.clEnqueueReadBuffer.argtypes = [vp, vp, u32, sz, sz, vp, u32, vp, vp]
        cl.clEnqueueWriteBuffer.argtypes = [vp, vp, u32, sz, sz, vp, u32, vp, vp]
        cl.clFinish.argtypes = [vp]

        n = u32()
        if cl.clGetPlatformIDs(0, None, ctypes.byref(n)) != 0 or n.value == 0:
            raise RuntimeError("no OpenCL platform")
        plats = (vp * n.value)()
        cl.clGetPlatformIDs(n.value, plats, None)
        dev = None
        for p in plats:
            cnt = u32()
            if cl.clGetDeviceIDs(p, 0x4, 0, None, ctypes.byref(cnt)) == 0 and cnt.value:  # CL_DEVICE_TYPE_GPU
                devs = (vp * cnt.value)()
                cl.clGetDeviceIDs(p, 0x4, cnt.value, devs, None)
                dev = vp(devs[0])
                break
        if dev is None:
            raise RuntimeError("no OpenCL GPU device")
        buf = ctypes.create_string_buffer(256)
        cl.clGetDeviceInfo(dev, 0x102B, 256, buf, None)  # CL_DEVICE_NAME
        self.device_name = buf.value.decode(errors="ignore").strip()
        cu = u32()
        cl.clGetDeviceInfo(dev, 0x1002, 4, ctypes.byref(cu), None)  # CL_DEVICE_MAX_COMPUTE_UNITS
        self.compute_units = cu.value

        err = i32()
        devarr = (vp * 1)(dev.value)
        self.ctx = cl.clCreateContext(None, 1, devarr, None, None, ctypes.byref(err))
        self.queue = cl.clCreateCommandQueue(self.ctx, dev, 0, ctypes.byref(err))
        kpath = REPO / "src_w8_w9" / "kernels" / "sha256_kernel.cl"
        if not kpath.exists():
            raise RuntimeError("kernel not found: " + str(kpath))
        src = kpath.read_bytes()
        sptr, slen = ctypes.c_char_p(src), sz(len(src))
        prog = cl.clCreateProgramWithSource(self.ctx, 1, ctypes.byref(sptr), ctypes.byref(slen), ctypes.byref(err))
        if cl.clBuildProgram(prog, 1, devarr, None, None, None) != 0:
            lb = ctypes.create_string_buffer(8192)
            cl.clGetProgramBuildInfo(prog, dev, 0x1183, 8192, lb, None)
            raise RuntimeError("kernel build failed: " + lb.value.decode(errors="ignore")[:500])
        self.kernel = cl.clCreateKernel(prog, b"sha256_crack_kernel", ctypes.byref(err))
        self.buf_target = cl.clCreateBuffer(self.ctx, 1 << 2, 32, None, ctypes.byref(err))   # READ_ONLY
        self.buf_found = cl.clCreateBuffer(self.ctx, 1 << 0, 4, None, ctypes.byref(err))     # READ_WRITE
        self.buf_match = cl.clCreateBuffer(self.ctx, 1 << 0, 8, None, ctypes.byref(err))

    def run(self, target_hex, start, end, length, threads, stop):
        cl = self.cl
        self.done = 0
        digest = bytes.fromhex(target_hex)
        state = (ctypes.c_uint32 * 8)(*[int.from_bytes(digest[i * 4:i * 4 + 4], "big") for i in range(8)])
        zero = ctypes.c_int32(0)
        cl.clEnqueueWriteBuffer(self.queue, self.buf_target, 1, 0, 32, ctypes.byref(state), 0, None, None)
        cl.clEnqueueWriteBuffer(self.queue, self.buf_found, 1, 0, 4, ctypes.byref(zero), 0, None, None)
        plen = ctypes.c_int32(length)
        cl.clSetKernelArg(self.kernel, 1, 4, ctypes.byref(plen))
        for i, b in ((2, self.buf_target), (3, self.buf_found), (4, self.buf_match)):
            h = ctypes.c_void_p(b)
            cl.clSetKernelArg(self.kernel, i, ctypes.sizeof(h), ctypes.byref(h))
        pos = start
        found = ctypes.c_int32(0)
        while pos < end:
            if stop.is_set():
                raise Aborted()
            n = min(self.batch, end - pos)
            s = ctypes.c_uint64(pos)
            cl.clSetKernelArg(self.kernel, 0, 8, ctypes.byref(s))
            gws = (ctypes.c_size_t * 1)(n)
            t0 = time.perf_counter()
            cl.clEnqueueNDRangeKernel(self.queue, self.kernel, 1, None, gws, None, 0, None, None)
            cl.clFinish(self.queue)
            cl.clEnqueueReadBuffer(self.queue, self.buf_found, 1, 0, 4, ctypes.byref(found), 0, None, None)
            dt = time.perf_counter() - t0
            pos += n
            self.done = pos - start
            if found.value:
                m = ctypes.c_uint64(0)
                cl.clEnqueueReadBuffer(self.queue, self.buf_match, 1, 0, 8, ctypes.byref(m), 0, None, None)
                return ("found", m.value)
            # keep each batch around 100 ms so progress and aborts stay responsive
            if dt < 0.05 and self.batch < (1 << 28):
                self.batch *= 2
            elif dt > 0.2 and self.batch > (1 << 16):
                self.batch //= 2
        return ("done", None)

    def abort(self):
        pass  # checked between batches


# =============================================================================== worker
class Worker:
    def __init__(self, master, name, mode):
        self.base = "http://" + master if "://" not in master else master
        self.base = self.base.rstrip("/").replace("://localhost:", "://127.0.0.1:")
        self.name = name
        self.cpu_threads = os.cpu_count() or 4
        log("Probing compute engines…")
        self.gpu = GpuEngine()
        if self.gpu.ok:
            log("  GPU  : %s (%d compute units) via OpenCL" % (self.gpu.device_name, self.gpu.compute_units))
        else:
            log("  GPU  : not available (%s)" % getattr(self.gpu, "error", "?"))
        c = CEngine()
        self.cpu = c if c.ok else PyEngine()
        log("  CPU  : %s, %d logical threads" % ("native C engine" if c.ok else "Python fallback (no C compiler found)", self.cpu_threads))
        self.mode = mode if mode != "auto" else ("gpu" if self.gpu.ok else "cpu")
        if self.mode == "gpu" and not self.gpu.ok:
            log("  --mode gpu requested but no GPU → using CPU")
            self.mode = "cpu"
        self.anti_choke = True
        self.threads_cfg = self.cpu_threads
        self.node_id = None
        self.frozen = False
        self.stop = threading.Event()
        self.chunk = None
        self.engine = None
        self.rtt_ms = 0.0
        self.last_total = 0
        self.total = 0
        self.last_t = time.time()
        self.lock = threading.Lock()

    # ---------------------------------------------------------------- http
    def call(self, path, body=None, timeout=3):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, headers={"Content-Type": "application/json"}, method="POST" if data else "GET")
        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                self.rtt_ms = (time.time() - t0) * 1000
                return json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            try:
                msg = json.loads(e.read()).get("error", str(e))
            except Exception:
                msg = str(e)
            raise RuntimeError(msg)

    def allowed_threads(self):
        t = self.threads_cfg or self.cpu_threads
        return max(1, t - 2) if self.anti_choke else max(1, t)

    def register(self):
        info = {
            "name": self.name,
            "cpuThreads": self.cpu_threads,
            "gpu": {"available": self.gpu.ok, "name": self.gpu.device_name, "computeUnits": self.gpu.compute_units},
            "engine": self.cpu.name,
            "mode": self.mode,
            "os": platform.system() + " " + platform.machine(),
        }
        while True:
            try:
                r = self.call("/api/worker/register", info)
                self.node_id = r["nodeId"]
                self.apply_config(r.get("config") or {})
                log("Registered with Master %s as '%s' (node %s, role %s)" % (self.base, self.name, self.node_id, r.get("role")))
                return
            except Exception as e:
                log("Master not reachable at %s (%s) — retrying in 2 s" % (self.base, e))
                time.sleep(2)

    def apply_config(self, cfg):
        changed = False
        if cfg.get("mode") in ("gpu", "cpu") and cfg["mode"] != self.mode:
            self.mode = cfg["mode"]
            changed = True
        if "antiChoke" in cfg and cfg["antiChoke"] != self.anti_choke:
            self.anti_choke = bool(cfg["antiChoke"])
            changed = True
        if cfg.get("cpuThreads") and cfg["cpuThreads"] != self.threads_cfg:
            self.threads_cfg = int(cfg["cpuThreads"])
            changed = True
        if changed:
            log("Config from Master: mode=%s threads=%d%s" % (self.mode, self.allowed_threads(), " (Anti-Choke)" if self.anti_choke else ""))

    def current_index(self):
        c, e = self.chunk, self.engine
        if not c or not e:
            return None
        return c["from"] + e.done

    def cpu_load(self):
        if self.mode == "gpu":
            return 2.0
        if hasattr(os, "getloadavg"):
            try:
                return min(100.0, os.getloadavg()[0] / self.cpu_threads * 100)
            except OSError:
                pass
        return self.allowed_threads() / self.cpu_threads * 100

    # ---------------------------------------------------------------- heartbeat thread
    def heartbeat_loop(self):
        while True:
            time.sleep(HEARTBEAT_S)
            if self.frozen:
                try:
                    r = self.call("/api/worker/status?nodeId=" + self.node_id)
                    if r.get("alive"):
                        self.frozen = False
                        log("Restarted by the Master (fault test over) — rejoining")
                except Exception:
                    pass
                continue
            now = time.time()
            with self.lock:
                total = self.total + (self.engine.done if (self.engine and self.chunk) else 0)
                cur = self.current_index()
                chunk_id = self.chunk["id"] if self.chunk else None
            mhs = max(0, total - self.last_total) / max(1e-3, now - self.last_t) / 1e6
            self.last_total, self.last_t = total, now
            hb = {
                "nodeId": self.node_id,
                "chunkId": chunk_id,
                "currentIndex": cur,
                "mhs": round(mhs, 3),
                "cpuLoad": round(self.cpu_load(), 1),
                "rttMs": round(self.rtt_ms, 1),
                "mode": self.mode,
            }
            try:
                r = self.call("/api/worker/heartbeat", hb, timeout=2)
            except RuntimeError as e:
                if "unknown node" in str(e).lower():
                    log("Master restarted — registering again")
                    self.abort_chunk()
                    self.register()
                continue
            except Exception:
                continue  # Master briefly unreachable: keep computing, keep trying
            self.apply_config(r.get("config") or {})
            cmd = r.get("command")
            if cmd == "die":
                log("💥 Fault injected by Master: going silent (simulated crash)")
                self.frozen = True
                self.abort_chunk()
            elif cmd == "abort":
                self.abort_chunk()

    def abort_chunk(self):
        self.stop.set()
        if self.engine:
            self.engine.abort()

    # ---------------------------------------------------------------- main loop
    def run(self):
        self.register()
        threading.Thread(target=self.heartbeat_loop, daemon=True).start()
        while True:
            if self.frozen:
                time.sleep(0.2)
                continue
            try:
                r = self.call("/api/worker/request", {"nodeId": self.node_id})
            except Exception as e:
                if "unknown node" in str(e).lower():
                    self.register()
                time.sleep(1)
                continue
            ch = r.get("chunk")
            if not ch:
                time.sleep(r.get("retryMs", 300) / 1000)
                continue
            self.apply_config(r.get("config") or {})
            job = r["job"]
            self.stop.clear()
            engine = self.gpu if (self.mode == "gpu" and self.gpu.ok) else self.cpu
            threads = self.allowed_threads()
            self.chunk = {"id": ch["id"], "from": ch["from"], "end": ch["end"]}
            self.engine = engine
            t0 = time.time()
            what = "GPU" if engine is self.gpu else "CPU×%d" % threads
            log("Chunk #%d  [%s, %s)  %s" % (ch["id"], format(ch["from"], ","), format(ch["end"], ","), what))
            try:
                kind, idx = engine.run(job["targetHash"], ch["from"], ch["end"], job["length"], threads, self.stop)
            except Aborted:
                kind, idx = "aborted", None
            done = engine.done
            with self.lock:
                self.total += done
                self.chunk = None
            dt = time.time() - t0
            if kind == "aborted":
                log("Chunk #%d aborted after %s hashes" % (ch["id"], format(done, ",")))
                continue
            body = {"nodeId": self.node_id, "chunkId": ch["id"], "found": kind == "found", "hashes": done, "elapsed": dt, "engine": engine.name}
            if kind == "found":
                body["index"] = idx
                pw = index_to_password(idx, job["length"])
                ok = hashlib.sha256(pw.encode()).hexdigest() == job["targetHash"]
                log("🔑 FOUND '%s' at index %s (verified: %s)" % (pw, format(idx, ","), ok))
            else:
                log("Chunk #%d done · %.1f MH/s" % (ch["id"], done / max(dt, 1e-6) / 1e6))
            for _ in range(5):
                try:
                    self.call("/api/worker/result", body)
                    break
                except Exception:
                    time.sleep(0.5)


def main():
    ap = argparse.ArgumentParser(description="Mini-Spark worker node")
    ap.add_argument("--master", default="localhost:8000", help="Master address, e.g. 192.168.1.10:8000")
    ap.add_argument("--name", default=socket.gethostname().split(".")[0], help="name shown in the dashboard")
    ap.add_argument("--mode", choices=["auto", "gpu", "cpu"], default="auto")
    a = ap.parse_args()
    try:
        Worker(a.master, a.name, a.mode).run()
    except KeyboardInterrupt:
        log("Stopped (Ctrl+C) — the Master will notice the missing heartbeats in ~1 s")


if __name__ == "__main__":
    mp.freeze_support()
    main()
