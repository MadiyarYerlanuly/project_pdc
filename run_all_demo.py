import os
import sys
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).parent.resolve()

def has_cmd(cmd):
    return shutil.which(cmd) is not None

def run_c_stage(title, src_files, out_name, extra_flags=None):
    print("\n" + "#" * 72)
    print(f"### {title}")
    print("#" * 72)
    extra = extra_flags or []

    # Check if native gcc exists; otherwise use WSL on Windows
    if has_cmd("gcc"):
        cmd = ["gcc", "-O3"] + extra + src_files + ["-o", out_name]
        subprocess.run(cmd, cwd=ROOT, check=True)
        exe = str(ROOT / (out_name + (".exe" if os.name == "nt" else "")))
        subprocess.run([exe], cwd=ROOT, check=True)
        if os.path.exists(exe):
            os.remove(exe)
    elif os.name == "nt" and has_cmd("wsl"):
        # Convert Windows path C:\... to /mnt/c/...
        drive = ROOT.drive[0].lower()
        rel = ROOT.as_posix().split(":", 1)[1]
        wsl_root = f"/mnt/{drive}{rel}"
        flags_str = " ".join(extra)
        srcs_str = " ".join(src_files)
        bash_cmd = f"cd '{wsl_root}' && gcc -O3 {flags_str} {srcs_str} -o {out_name} && ./{out_name} && rm -f {out_name}"
        subprocess.run(["wsl", "bash", "-c", bash_cmd], check=True)
    else:
        print("[ERROR] Neither native 'gcc' nor 'wsl' found on this machine.")

def main():
    print("========================================================================")
    print("   MINI-SPARK FULL PROJECT DEMO LAUNCHER (WEEKS 6-7 -> 8-9 -> 10)       ")
    print("========================================================================")

    # 1. Stage W6-W7
    run_c_stage(
        "STAGE 1 (W6-W7): Architecture Validation & Single-Core Serial Baseline",
        ["src_w6_w7/src/main_w6_w7.c", "src_w6_w7/src/sha256_serial.c"],
        "demo_w6_w7"
    )

    # 2. Stage W8-W9 (OpenMP + SIMD & Dynamic Scheduler)
    run_c_stage(
        "STAGE 2 (W8-W9): OpenMP+SIMD Multi-Core Engine & Dynamic Load Balancer",
        ["src_w8_w9/src/main_w8_w9.c", "src_w6_w7/src/sha256_serial.c"],
        "demo_w8_w9",
        extra_flags=["-fopenmp", "-mavx2"]
    )

    # 3. Stage W8-W9 (Universal OpenCL GPU Offloading)
    print("\n" + "#" * 72)
    print("### STAGE 3 (W8-W9): Universal OpenCL GPU Offloader (Zero CPU Choke)")
    print("#" * 72)
    gpu_script = ROOT / "src_w8_w9" / "run_opencl_gpu_bench.py"
    subprocess.run([sys.executable, str(gpu_script)], cwd=ROOT, check=False)

    # 4. Stage W10 (Progress Report Strong & Weak Scaling Suite)
    run_c_stage(
        "STAGE 4 (W10): Progress Report Strong & Weak Scaling Benchmark Suite",
        ["src_w10/src/main_w10_scaling.c", "src_w6_w7/src/sha256_serial.c"],
        "demo_w10",
        extra_flags=["-fopenmp", "-mavx2"]
    )

    print("\n========================================================================")
    print("   ALL STAGES (W6-W10) COMPLETED SUCCESSFULLY!                          ")
    print("========================================================================")

if __name__ == "__main__":
    main()
