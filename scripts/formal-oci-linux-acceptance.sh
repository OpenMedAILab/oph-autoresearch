#!/usr/bin/env sh
# Run manually on the approved Linux execution host.  This script never installs
# Podman, pulls an image, or submits a research job.
set -eu

if [ "$(uname -s)" != "Linux" ]; then
  echo "UNSUPPORTED: formal OCI requires Linux" >&2
  exit 2
fi
if ! command -v podman >/dev/null 2>&1; then
  echo "NOT ADMITTED: podman is absent; no container was run" >&2
  exit 3
fi

info="$(podman info --format json 2>/dev/null)" || {
  echo "NOT ADMITTED: podman info failed" >&2
  exit 4
}
printf '%s' "$info" | grep -q '"rootless"[[:space:]]*:[[:space:]]*true' || {
  echo "NOT ADMITTED: Podman is not rootless" >&2
  exit 5
}
printf '%s' "$info" | grep -q '"cgroupVersion"[[:space:]]*:[[:space:]]*"v2"' || {
  echo "NOT ADMITTED: cgroup v2 resource controls unavailable" >&2
  exit 6
}
echo "ADMISSION READY: rootless Podman with cgroup v2; no image or experiment was run"
