#!/bin/sh
# ------------------------------------------------------------------
# 机器健康采样 —— 每 5 分钟跑一次，结果写进 journal。
#
# 为什么需要它：
#   2026-11-27 那台机器僵死时，**没有任何监控**，
#   所以「最后一根稻草到底是什么」永远定不死 ——
#   只能说「系统被渐进拖垮」，说不出「被什么拖垮的」。
#   有采样，下次再僵死就能直接看出是内存、CPU 还是磁盘的问题。
#
# 采什么（都是当时**真正缺**的）：
#   - 整机可用内存 / swap 使用量 —— 内存被吃光的直接证据
#   - 本服务的 cgroup 内存       —— 能抓到「一局 AI 吃掉 500MB」这类事
#   - 最占内存的三个进程         —— 抓元凶（不是猜）
#   - 根分区占用                —— 日志/存档涨爆磁盘的信号
#   - 负载                      —— 死循环的信号
#
# 只读、不改任何状态；采样本身的开销可以忽略（一条 journal 记录）。
# ------------------------------------------------------------------
set -u

mem_total_kb=$(awk '/^MemTotal/{print $2; exit}' /proc/meminfo)
mem_avail_kb=$(awk '/^MemAvailable/{print $2; exit}' /proc/meminfo)
swap_total_kb=$(awk '/^SwapTotal/{print $2; exit}' /proc/meminfo)
swap_free_kb=$(awk '/^SwapFree/{print $2; exit}' /proc/meminfo)

load=$(cut -d' ' -f1-3 /proc/loadavg)

# 本服务的 cgroup 内存（systemd 的 MemoryCurrent）
svc_mb=$(systemctl show lan-chess-ws -p MemoryCurrent --value 2>/dev/null |
  awk '{ if ($1 ~ /^[0-9]+$/) printf "%d", $1/1048576; else printf "?" }')

# 最占内存的三个进程（抓元凶，不是猜）
top3=$(ps -eo rss=,comm= --sort=-rss 2>/dev/null | head -3 |
  awk '{ printf "%s=%dMB ", $2, $1/1024 }')

# 根分区占用
disk_pct=$(df -P / 2>/dev/null | awk 'NR==2 { gsub("%","",$5); print $5 }')

echo "[watch] mem_total=$((mem_total_kb / 1024))MB mem_avail=$((mem_avail_kb / 1024))MB" \
  "swap_used=$(( (swap_total_kb - swap_free_kb) / 1024 ))MB/swap_total=$((swap_total_kb / 1024))MB" \
  "load=$load chess_ws=${svc_mb}MB top: ${top3}disk=${disk_pct}%"
