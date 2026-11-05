import pymupdf
from pathlib import Path

html = """
<h1>Week 10 Progress Report: Resilient Distributed Engine for Cryptographic Forensics</h1>
<p class="meta"><b>Course:</b> Parallel &amp; Distributed Computing &middot; <b>Instructor:</b> Dr. Mohammed Alaa Ala&rsquo;anzy &middot; <b>Date:</b> November 2026</p>
<p class="meta"><b>Team:</b> Atabek Bakhytzhanov (240107104) &middot; Begzhan Imangali (240107042) &middot; Karzhaubay Bakdaulet (240107105) &middot; Yerkebulan Kenzhegali (240107051) &middot; Madiyar Yerlanuly (240107040)</p>

<h2>1. Executive Summary &amp; Completed Milestones (W6&ndash;W10)</h2>
<p>In accordance with our approved proposal, all baseline milestones from Week 6 through Week 10 have been implemented, verified, and benchmarked in C/C++ (repository: <tt>github.com/MadiyarYerlanuly/project_pdc-</tt>). Specifically: <b>(1) W6&ndash;W7:</b> Implemented the FIPS 180-4 SHA-256 cryptographic engine (<tt>S5</tt>), verified against official NIST test vectors, and defined core data structures (<tt>TaskChunk</tt>, <tt>HeartbeatPacket</tt>). <b>(2) W8:</b> Developed the multi-threaded OpenMP + AVX2 SIMD worker engine (<tt>S4</tt>) and extended it with a hardware-agnostic <b>OpenCL GPU kernel</b> (<tt>sha256_kernel.cl</tt>). <b>(3) W9:</b> Implemented the Dynamic Master-Worker Task Queue (<tt>S1/S2</tt>) using asynchronous pull-based chunk scheduling. <b>(4) W10:</b> Conducted full Strong and Weak Scaling baseline benchmarks prior to fault injection.</p>

<h2>2. Architectural Enhancement: Mitigating CPU Starvation via OpenCL GPU Offloading</h2>
<p>During W8 testing on a 4-core/8-thread laptop (Intel Core i5-1135G7), we observed that saturating all 8 logical CPU threads (100% CPU load) reduced OpenMP parallel efficiency to <b>55.69%</b> due to SMT contention and caused OS scheduling jitter that risks delaying asynchronous MPI Heartbeats. To prevent CPU starvation across our heterogeneous student laptops (which lack NVIDIA GPUs and include Intel integrated graphics and Apple Silicon Macs), we introduced two improvements while keeping all syllabus components intact:</p>
<p>&bull; <b>Anti-Choke OpenMP Guard (CPU Baseline &amp; Batch Prep):</b> Reserves 2 logical CPU threads exclusively for the OS and MPI asynchronous network daemon, running OpenMP+SIMD on the remaining 6 threads.<br/>
&bull; <b>Universal OpenCL GPU Offloading:</b> Offloads the compute-bound SHA-256 loop onto <i>any</i> vendor's integrated or discrete GPU. On our test laptop's integrated <b>Intel(R) Iris(R) Xe Graphics (80 Compute Units)</b>, OpenCL achieved <b>197.48 MH/s (85.1&times; speedup over 1 CPU core)</b> while keeping host CPU utilization at <b>~2%</b>.</p>

<h2>3. Experimental Baseline Results (Hypotheses H1 &amp; H3, Without Failures)</h2>
<table>
<tr>
  <td><b>Compute Mode (H1 Strong Scaling)</b></td>
  <td><b>Hardware / Threads</b></td>
  <td><b>Time (2M Hashes)</b></td>
  <td><b>Throughput</b></td>
  <td><b>Speedup</b></td>
  <td><b>Efficiency</b></td>
  <td><b>Host CPU Load</b></td>
</tr>
<tr>
  <td>W6&ndash;W7 Serial Baseline</td>
  <td>1 CPU Thread</td>
  <td>0.8389 s</td>
  <td>2.38 MH/s</td>
  <td>1.00&times;</td>
  <td>100.00%</td>
  <td>12.5%</td>
</tr>
<tr>
  <td>W8 OpenMP + SIMD</td>
  <td>2 CPU Threads</td>
  <td>0.4390 s</td>
  <td>4.56 MH/s</td>
  <td>1.91&times;</td>
  <td>95.54%</td>
  <td>25.0%</td>
</tr>
<tr>
  <td>W8 OpenMP + SIMD</td>
  <td>4 CPU Threads</td>
  <td>0.2602 s</td>
  <td>7.69 MH/s</td>
  <td>3.22&times;</td>
  <td>80.60%</td>
  <td>50.0%</td>
</tr>
<tr>
  <td>W8 OpenMP + SIMD (Anti-Choke)</td>
  <td>6 CPU Threads (2 free)</td>
  <td>0.2131 s</td>
  <td>9.38 MH/s</td>
  <td>3.94&times;</td>
  <td>65.61%</td>
  <td>75.0%</td>
</tr>
<tr>
  <td>W8 OpenMP + SIMD (Saturated)</td>
  <td>8 CPU Threads</td>
  <td>0.1883 s</td>
  <td>10.62 MH/s</td>
  <td>4.46&times;</td>
  <td>55.69%</td>
  <td>100.0%</td>
</tr>
<tr>
  <td><b>W8 Universal OpenCL GPU</b></td>
  <td><b>Intel Iris Xe (80 CUs)</b></td>
  <td><b>0.0101 s (equiv.)</b></td>
  <td><b>197.48 MH/s</b></td>
  <td><b>85.10&times;</b></td>
  <td><b>GPU Offload</b></td>
  <td><b>~2.0%</b></td>
</tr>
</table>

<p style="margin-top:4pt;"><b>Weak Scaling &amp; Dynamic Load Balancing (Hypothesis H3):</b> Scaling workload proportionally (1,000,000 hashes per worker node across 1 to 4 worker nodes) yielded aggregate throughputs of <b>11.61 MH/s (1 node, 100%)</b>, <b>22.82 MH/s (2 nodes, 98.23%)</b>, <b>33.63 MH/s (3 nodes, 96.53%)</b>, and <b>44.07 MH/s (4 nodes, 94.88% weak-scaling efficiency)</b>. Under asymmetric node speeds (simulating heterogeneous laptops from 1.0&times; to 5.5&times; relative speed across 24 chunks), the dynamic pull scheduler achieved <b>96.06% load-balancing efficiency</b>, exceeding our &gt;90% H3 target.</p>

<h2>4. Next Steps (Weeks 11&ndash;15: Fault Tolerance &amp; 5-Laptop Chaos Testing)</h2>
<p>&bull; <b>W11 (Module S3 - Rescuer):</b> Activate 500ms asynchronous <tt>MPI_Isend</tt> heartbeats, periodic chunk checkpointing, automatic dead-node chunk reassignment (Hypothesis H2), and <tt>Rank 1</tt> Shadow Master replication to eliminate Single Point of Failure.<br/>
&bull; <b>W12&ndash;W15:</b> Deploy across all 5 physical laptops over WLAN and conduct live chaos testing (disconnecting nodes mid-execution).</p>
"""

FS = 9.0
css = f"""
* {{ font-family: sans-serif; font-size: {FS}pt; line-height: 1.24; }}
h1 {{ font-size: {FS+3.2}pt; text-align: center; margin: 0 0 3pt 0; color: #112244; }}
h2 {{ font-size: {FS+1.2}pt; margin: 6pt 0 2pt 0; color: #1f3b73; }}
p {{ margin: 0 0 3pt 0; text-align: justify; }}
p.meta {{ text-align: center; color: #444; margin-bottom: 2pt; }}
table {{ border-collapse: collapse; width: 100%; margin-top: 3pt; margin-bottom: 3pt; }}
td {{ border: 0.5pt solid #888; padding: 2pt 4pt; vertical-align: middle; font-size: {FS-0.5}pt; }}
tt {{ font-family: monospace; }}
"""

for out_path in [
    Path(r"C:\Users\User\.gemini\antigravity\scratch\project_pdc\proposal\Progress_Report_W10.pdf"),
    Path(r"C:\Users\User\Downloads\Progress_Report_W10.pdf")
]:
    story = pymupdf.Story(html=html, user_css=css)
    writer = pymupdf.DocumentWriter(str(out_path))
    mediabox = pymupdf.paper_rect("a4")
    where = mediabox + (38, 34, -38, -34)
    more = 1
    while more:
        dev = writer.begin_page(mediabox)
        more, _ = story.place(where)
        story.draw(dev)
        writer.end_page()
    writer.close()
    print("Generated ->", out_path)
