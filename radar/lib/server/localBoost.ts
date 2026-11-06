/**
 * LOCAL BOOST — only when the site runs on your own machine (npm run dev,
 * or RO_LOCAL_BOOST=1 with next start), never on Vercel.
 *
 * Lets the server's in-memory caches (radar tiles, satellite pictures, 3D
 * scans…) grow far past their normal caps for as long as the machine has
 * memory to spare, always keeping HEADROOM free for macOS and your other
 * apps. When available memory drops below that, caches shrink again on
 * their next insert (10% at a time, never below their normal size).
 *
 * "Available" on macOS = free + inactive + speculative + purgeable pages
 * (vm_stat) — memory macOS hands back instantly. os.freemem() alone counts
 * only truly empty pages, which on a Mac is often a few hundred MB even
 * with gigabytes really available.
 */
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import os from "os";

/** Always left free for the system and other apps. */
export const HEADROOM_BYTES = 2 * 1024 ** 3;

export function localBoostOn(): boolean {
  if (process.env.VERCEL) return false;
  // Off unless asked for: it used to come on by itself under `npm run dev`.
  return process.env.RO_LOCAL_BOOST === "1";
}

let memCache: { at: number; bytes: number } | null = null;
/** Memory the OS can hand out right now (bytes). Measured at most every 2 s. */
export function availableBytes(): number {
  const now = Date.now();
  if (memCache && now - memCache.at < 2000) return memCache.bytes;
  let bytes = os.freemem();
  try {
    if (process.platform === "darwin") {
      const out = execFileSync("vm_stat", { encoding: "utf8", timeout: 1000 });
      const page = Number(out.match(/page size of (\d+) bytes/)?.[1] ?? 16384);
      const pages = (label: string) => Number(out.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1] ?? 0);
      bytes = (pages("Pages free") + pages("Pages inactive") + pages("Pages speculative") + pages("Pages purgeable")) * page;
    } else if (process.platform === "linux") {
      const kb = Number(readFileSync("/proc/meminfo", "utf8").match(/MemAvailable:\s+(\d+)/)?.[1] ?? 0);
      if (kb) bytes = kb * 1024;
    }
  } catch {
    /* fall back to os.freemem() */
  }
  memCache = { at: now, bytes };
  return bytes;
}

/**
 * The size a cache may grow to. Normal (on Vercel, or with boost off):
 * `normal`. Boosted: unlimited while more than HEADROOM is available,
 * otherwise 90% of its current size (shrinking, not below `normal`).
 */
export function cacheLimit(normal: number, current: number): number {
  if (!localBoostOn()) return normal;
  if (availableBytes() > HEADROOM_BYTES) return Number.MAX_SAFE_INTEGER;
  return Math.max(normal, Math.floor(current * 0.9));
}

/** Parallel downloads/renders: all cores but two when boosted. */
export function parallelism(normal: number): number {
  return localBoostOn() ? Math.max(normal, os.cpus().length - 2) : normal;
}

let gpu: string | null | undefined;
/** GPU name and cores (macOS), for the boost badge. */
export function gpuName(): string | null {
  if (gpu !== undefined) return gpu;
  gpu = null;
  try {
    if (process.platform === "darwin") {
      const j = JSON.parse(execFileSync("system_profiler", ["SPDisplaysDataType", "-json"], { encoding: "utf8", timeout: 4000 }));
      const d = j?.SPDisplaysDataType?.[0];
      if (d) gpu = `${d.sppci_model ?? d._name ?? "GPU"}${d.sppci_cores ? ` · ${d.sppci_cores}-core GPU` : ""}`;
    }
  } catch {
    /* unknown */
  }
  return gpu;
}
