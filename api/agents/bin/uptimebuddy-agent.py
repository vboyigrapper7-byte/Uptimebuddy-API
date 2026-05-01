#!/usr/bin/env python3
import os
import time
import json
import socket
import http.client
import ssl
from urllib.parse import urlparse

# ========================================================
# MonitorHub Native Python Agent (Linux - Pro Edition)
# Zero-Dependency, SSL-Resilient, High Performance
# ========================================================

TOKEN = os.getenv('AGENT_TOKEN')
INGEST_URL = os.getenv('INGEST_URL')
INTERVAL = 30

def get_metrics():
    try:
        # 1. CPU Percent (Calculated from /proc/stat)
        with open('/proc/stat', 'r') as f:
            line = f.readline()
            fields = [float(column) for column in line.strip().split()[1:]]
            idle, total = fields[3], sum(fields)
        time.sleep(0.5) # Reduced sleep for faster response
        with open('/proc/stat', 'r') as f:
            line = f.readline()
            fields = [float(column) for column in line.strip().split()[1:]]
            idle2, total2 = fields[3], sum(fields)
        cpu_usage = 100 * (1 - (idle2 - idle) / (total2 - total))

        # 2. Memory (from /proc/meminfo)
        mem = {}
        with open('/proc/meminfo', 'r') as f:
            for line in f:
                parts = line.split(':')
                if len(parts) == 2:
                    mem[parts[0].strip()] = int(parts[1].split()[0])
        
        total_ram = mem.get('MemTotal', 0) / 1024
        available_ram = mem.get('MemAvailable', mem.get('MemFree', 0)) / 1024
        used_ram = total_ram - available_ram
        ram_percent = (used_ram / total_ram) * 100 if total_ram > 0 else 0

        # 3. Disk (Root FS)
        st = os.statvfs('/')
        disk_total_gb = (st.f_blocks * st.f_frsize) / (1024**3)
        disk_free_gb = (st.f_bavail * st.f_frsize) / (1024**3)
        disk_used_gb = disk_total_gb - disk_free_gb
        disk_percent = (disk_used_gb / disk_total_gb) * 100 if disk_total_gb > 0 else 0

        # 4. Uptime & Processes
        with open('/proc/uptime', 'r') as f:
            uptime_seconds = float(f.readline().split()[0])
        
        # Fast process count
        processes = len([f for f in os.listdir('/proc') if f.isdigit()])

        return {
            "os_type": "linux",
            "hostname": socket.gethostname(),
            "agent_type": "python",
            "agent_version": "1.1.0",
            "metrics": {
                "cpu_percent": round(cpu_usage, 2),
                "ram_mb": int(used_ram),
                "ram_total_mb": int(total_ram),
                "ram_percent": round(ram_percent, 2),
                "disk_percent": round(disk_percent, 2),
                "disk_total_gb": round(disk_total_gb, 2),
                "disk_free_gb": round(disk_free_gb, 2),
                "uptime_seconds": int(uptime_seconds),
                "process_count": processes
            }
        }
    except Exception as e:
        print(f"Error collecting metrics: {e}")
        return None

def send_telemetry(url, token, data):
    try:
        parsed = urlparse(url)
        # 🛡️ Bypass SSL check if needed (Enterprise Hardening)
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        
        if parsed.scheme == 'https':
            conn = http.client.HTTPSConnection(parsed.netloc, context=ctx, timeout=10)
        else:
            conn = http.client.HTTPConnection(parsed.netloc, timeout=10)
        
        payload = json.dumps(data)
        headers = {
            "X-Agent-Token": token,
            "Content-Type": "application/json",
            "User-Agent": "MonitorHubPro/1.1"
        }
        
        conn.request("POST", parsed.path, body=payload, headers=headers)
        response = conn.getresponse()
        conn.close()
        return response.status == 200
    except Exception as e:
        print(f"Error shipping telemetry: {e}")
        return False

if __name__ == "__main__":
    if not TOKEN or not INGEST_URL:
        print("Error: AGENT_TOKEN and INGEST_URL environment variables must be set.")
        exit(1)

    print(f"===============================================")
    print(f" MonitorHub Enterprise Linux Agent (v1.1.0)")
    print(f" Target: {INGEST_URL}")
    print(f"===============================================")

    while True:
        metrics = get_metrics()
        if metrics:
            success = send_telemetry(INGEST_URL, TOKEN, metrics)
            status = "✓" if success else "✗"
            print(f"[{time.strftime('%H:%M:%S')}] {status} Pulse Sent.")
        
        time.sleep(INTERVAL)
