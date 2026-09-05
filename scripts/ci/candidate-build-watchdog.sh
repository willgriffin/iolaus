#!/usr/bin/env bash

set -uo pipefail

watchdog_delay_seconds="${CANDIDATE_BUILD_WATCHDOG_DELAY_SECONDS:-180}"
case "${watchdog_delay_seconds}" in
  ''|*[!0-9]*) watchdog_delay_seconds=180 ;;
esac

print_proc_stats() {
  local pid="$1"
  if ! command -v sudo >/dev/null 2>&1 || ! sudo -n true 2>/dev/null; then
    return 0
  fi
  sudo -n sh -c '
    proc_dir="/proc/$1"
    comm="$(tr -d "\0" < "${proc_dir}/comm" 2>/dev/null || true)"
    state="$(awk "\$1 == \"State:\" {print \$2; exit}" "${proc_dir}/status" 2>/dev/null || true)"
    rss="$(awk "\$1 == \"VmRSS:\" {print \$2 \" \" \$3; exit}" "${proc_dir}/status" 2>/dev/null || true)"
    cpu_ticks="$(awk "{print \$14 \"/\" \$15; exit}" "${proc_dir}/stat" 2>/dev/null || true)"
    wchan="$(cat "${proc_dir}/wchan" 2>/dev/null || true)"
    printf "candidate-build process pid=%s comm=%s state=%s rss=%s cpu_ticks=%s wchan=%s\\n" \
      "$1" "${comm}" "${state:-unknown}" "${rss:-unknown}" \
      "${cpu_ticks:-unknown}" "${wchan:-unknown}"
    for task_dir in "${proc_dir}"/task/[0-9]*; do
      [ -d "${task_dir}" ] || continue
      task_comm="$(tr -d "\0" < "${task_dir}/comm" 2>/dev/null || true)"
      task_wchan="$(cat "${task_dir}/wchan" 2>/dev/null || true)"
      printf "candidate-build thread tid=%s comm=%s wchan=%s\\n" \
        "${task_dir##*/}" "${task_comm}" "${task_wchan:-unknown}"
    done
  ' sh "${pid}" || true
}

list_candidate_pids() {
  if ! command -v sudo >/dev/null 2>&1 || ! sudo -n true 2>/dev/null; then
    return 0
  fi
  sudo -n sh -c '
    for proc_dir in /proc/[0-9]*; do
      [ -d "${proc_dir}" ] || continue
      cwd="$(readlink "${proc_dir}/cwd" 2>/dev/null || true)"
      [ "${cwd}" = "/app/apps/site" ] || continue
      comm="$(tr -d "\0" < "${proc_dir}/comm" 2>/dev/null || true)"
      case "${comm}" in
        node|nodejs|vite) printf "%s\\n" "${proc_dir##*/}" ;;
      esac
    done
  ' 2>/dev/null || true
}

capture_build_diagnostics() {
  local pid
  local found=0
  local target_count=0

  while IFS= read -r pid; do
    case "${pid}" in
      ''|*[!0-9]*) continue ;;
    esac
    if [ "${target_count}" -ge 4 ]; then
      break
    fi
    target_count=$((target_count + 1))
    found=1
    print_proc_stats "${pid}"
    if command -v gdb >/dev/null 2>&1 && \
        command -v sudo >/dev/null 2>&1 && \
        command -v timeout >/dev/null 2>&1 && \
        sudo -n true 2>/dev/null; then
      printf '%s\n' \
        "::notice::Capturing bounded native stacks for candidate-build pid ${pid}."
      sudo -n timeout --signal=TERM --kill-after=5s 20s \
        gdb -nx -nh -batch \
        -iex 'set auto-load off' \
        -iex 'set debuginfod enabled off' \
        -iex 'set print frame-arguments none' \
        -ex 'thread apply all bt 8' \
        -p "${pid}" || true
    else
      printf '%s\n' \
        "::notice::gdb unavailable; retained bounded /proc stats for candidate-build pid ${pid}."
    fi
  done < <(list_candidate_pids)

  if [ "${found}" -eq 0 ]; then
    printf '%s\n' \
      "::notice::No candidate-build Node/Vite process with cwd /app/apps/site was visible; no unrelated process was inspected."
  fi
}

kill_tree() {
  local root="$1"
  local child children

  children="$(ps -eo pid=,ppid= 2>/dev/null | \
    awk -v parent="${root}" '$2 == parent {print $1}')"
  for child in ${children}; do
    kill_tree "${child}"
  done
  kill "${root}" 2>/dev/null || true
}

cleanup_watchdog() {
  if [ -n "${watchdog_pid:-}" ] && kill -0 "${watchdog_pid}" 2>/dev/null; then
    kill_tree "${watchdog_pid}"
  fi
}

if [ "${1:-}" != "--" ] || [ "$#" -lt 2 ]; then
  printf '%s\n' 'usage: candidate-build-watchdog.sh -- command [args...]' >&2
  exit 2
fi
shift

"$@" &
build_pid=$!
watchdog_pid=''
trap cleanup_watchdog EXIT

(
  sleep "${watchdog_delay_seconds}"
  if kill -0 "${build_pid}" 2>/dev/null; then
    printf '%s\n' \
      "::warning::Candidate image build is still running after ${watchdog_delay_seconds} seconds; collecting bounded native diagnostics."
    capture_build_diagnostics
  fi
) &
watchdog_pid=$!

build_status=0
if wait "${build_pid}"; then
  build_status=0
else
  build_status=$?
fi
cleanup_watchdog
wait "${watchdog_pid}" 2>/dev/null || true
exit "${build_status}"
