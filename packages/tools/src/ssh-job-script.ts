/** Remote job state is stored only in its exclusive run directory. */
import { posix } from 'node:path'

const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`

export function detachedJobScript(command: string, runDir: string): string {
  const parent = posix.dirname(runDir)
  const child = `ps -p "$$" -o lstart= > ${quote(`${runDir}/identity`)}; printf '%s\\n' "$$" > ${quote(`${runDir}/pid`)}; bash -c ${quote(command)}; code=$?; printf '%s\\n' "$code" > ${quote(`${runDir}/exit_code.tmp`)}; mv ${quote(`${runDir}/exit_code.tmp`)} ${quote(`${runDir}/exit_code`)}; exit "$code"`
  return (
    `command -v setsid >/dev/null || exit 69; command -v nohup >/dev/null || exit 69; ` +
    `test ! -L ${quote(parent)} || exit 66; mkdir -p ${quote(parent)} || exit $?; ` +
    `mkdir -m 700 ${quote(runDir)} || exit $?; ` +
    `nohup setsid bash -c ${quote(child)} </dev/null >${quote(`${runDir}/stdout.log`)} 2>&1 &\n` +
    `for attempt in 1 2 3 4 5 6 7 8 9 10; do if test -s ${quote(`${runDir}/pid`)}; then cat ${quote(`${runDir}/pid`)}; exit 0; fi; sleep 0.1; done; exit 70`
  )
}

export function jobStatusScript(): string {
  return `cd "$path" || exit $?;
state=unknown; reason=missing_pid; pid=; code=;
if test -f pid; then pid=$(cat pid); fi;
case "$pid" in ''|*[!0-9]*) pid=; reason=invalid_pid;; *)
  if test -f exit_code; then
    code=$(cat exit_code);
    case "$code" in ''|*[!0-9]*) code=; reason=invalid_exit_code;;
      0) state=completed; reason=;; *) state=failed; reason=;; esac;
  elif kill -0 "$pid" 2>/dev/null; then
    identity=$(cat identity 2>/dev/null); current=$(ps -p "$pid" -o lstart= 2>/dev/null);
    if test -n "$identity" && test "$identity" = "$current"; then state=running; reason=;
    else reason=process_identity_unverified; fi;
  else reason=process_missing_without_exit_code; fi;; esac;
printf '__OPH_JOB__:%s:%s:%s:%s\\n' "$state" "$pid" "$code" "$reason";
if test -f stdout.log; then tail -n 50 stdout.log | tail -c 16000; fi`
}
