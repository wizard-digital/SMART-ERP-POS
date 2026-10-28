#!/bin/sh
# 50-redis-suspicious-keys.sh  —  preserve evidence of, then remove, the foreign keys an attacker left in production Redis.
#
# WHAT THEY ARE (observed in the copy of the real prod dump.rdb, 100,444 keys; PROOF_REDIS_SUSPICIOUS_KEYS_REHEARSAL.json):
#   float:NNNNNN  100,000  strings  "1337.<digits>"            (not written by this application)
#   hui:<letter>       25  strings  repeated single letter, some with a binary header
#   test                1  string   "1"
#   everything else is BullMQ (bull:<queue>:*) written by the backend.  Redis was open to the internet with no password
#   (see PROOF_REDIS_PG_LOCKDOWN.md), so these are treated as attacker data: the evidence is kept before anything is removed.
#
# THIS SCRIPT NEVER: runs FLUSHALL/FLUSHDB/DEL with a pattern, touches bull:* keys, or deletes the Redis volume / dump.rdb / AOF.
# Removal is by UNLINK of an explicit key list, every key of which was re-validated against a STRICT regex AND its value shape.
#
# PHASES  (read-only unless --apply; use the same --ts in every phase):
#   check      read-only: counts, strict-shape validation of every target, non-target census, attack indicators (replication, modules, dir)
#   evidence   BGSAVE + copy dump.rdb + sha256 + redis-check-rdb, key manifest (key,type,bytes), digest of the target values, INFO/commandstats
#   remove     needs evidence marker and EXACT expected counts (--expect-float N --expect-hui N --expect-test N); UNLINK in batches;
#              proves: targets gone, non-target non-bull keyspace digest unchanged, bull structural keys still present
#   verify     read-only post-check
#   restore    RECOVERY: copy the removed keys back from the evidence dump.rdb loaded into a scratch Redis (MIGRATE ... COPY, never REPLACE)
#              --scratch-host H --scratch-port P  [--keys-file F]   (scratch must have been started from $CHG/redis-keys/dump.rdb)
#
#   ssh root@HOST 'sh -s -- --phase check' < ops/security/50-redis-suspicious-keys.sh
#   ssh root@HOST 'sh -s -- --phase evidence --apply --ts TS' < ops/security/50-redis-suspicious-keys.sh
#   ssh root@HOST 'sh -s -- --phase remove --apply --ts TS --expect-float 100000 --expect-hui 25 --expect-test 1' < ops/security/50-redis-suspicious-keys.sh
#
# ---- common prelude (identical in every ops/security script, plus this script's own arguments) ----
set -eu
APPLY=0; PHASE=plan; TS=""; QUIESCE=0
EXP_FLOAT=""; EXP_HUI=""; EXP_TEST=""; SCR_HOST=""; SCR_PORT=""; KEYS_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --phase) PHASE="$2"; shift ;;
    --ts) TS="$2"; shift ;;
    --quiesce) QUIESCE=1 ;;
    --expect-float) EXP_FLOAT="$2"; shift ;;
    --expect-hui) EXP_HUI="$2"; shift ;;
    --expect-test) EXP_TEST="$2"; shift ;;
    --scratch-host) SCR_HOST="$2"; shift ;;
    --scratch-port) SCR_PORT="$2"; shift ;;
    --keys-file) KEYS_FILE="$2"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
RD=samplepos-redis
[ -n "$TS" ] || TS=$(date -u +%Y%m%dT%H%M%SZ)
CHG=${OPS_CHG_BASE:-/root}/sec-change-$TS
EV=$CHG/redis-keys
say() { printf '%s\n' "$*"; }
pass() { say "PASS  $*"; }
warn() { say "WARN  $*"; }
die() { say "FAIL  $*" >&2; exit 1; }
live() { [ "$APPLY" = 1 ]; }
# EVERY mutating command goes through mut(): executed only with --apply, otherwise printed and skipped.
mut() { if live; then say "+ $*"; "$@"; else say "DRY-RUN (not executed): $*"; fi; }
# ---- end prelude ----

# OPS_RCLI lets the local rehearsal point at a real redis-cli (e.g. "redis-cli -p 6391"); in production it is docker exec.
if [ -n "${OPS_RCLI:-}" ]; then
  rcli() { $OPS_RCLI "$@" | tr -d '\r'; }
  rcli_in() { $OPS_RCLI "$@"; }
else
  rcli() { docker exec "$RD" redis-cli "$@" | tr -d '\r'; }
  rcli_in() { docker exec -i "$RD" redis-cli "$@"; }
fi
ifield() { rcli info "$1" | sed -n "s/^$2://p"; }
sha() { sha256sum | cut -d' ' -f1; }

# strict shapes (anything that does not match is NOT a target and is never touched)
RE_FLOAT='^float:[0-9]{6}$'
RE_HUI='^hui:[A-Za-z]$'
RE_TEST='^test$'
RE_FLOAT_VAL='^1337\.[0-9]+$'

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
ALL=$TMP/all.keys; TGT=$TMP/targets.keys; NONT=$TMP/nontarget.keys

scan_all() { rcli --scan | LC_ALL=C sort > "$ALL"; }
classify() {
  grep -E "$RE_FLOAT" "$ALL" > "$TMP/float.keys" || true
  grep -E "$RE_HUI" "$ALL" > "$TMP/hui.keys" || true
  grep -E "$RE_TEST" "$ALL" > "$TMP/test.keys" || true
  cat "$TMP/float.keys" "$TMP/hui.keys" "$TMP/test.keys" | LC_ALL=C sort > "$TGT"
  LC_ALL=C comm -23 "$ALL" "$TGT" > "$NONT"
  grep -v '^bull:' "$NONT" > "$TMP/nonbull.keys" || true
  grep '^bull:' "$NONT" > "$TMP/bull.keys" || true
  N_FLOAT=$(wc -l < "$TMP/float.keys" | tr -d ' '); N_HUI=$(wc -l < "$TMP/hui.keys" | tr -d ' '); N_TEST=$(wc -l < "$TMP/test.keys" | tr -d ' ')
  N_ALL=$(wc -l < "$ALL" | tr -d ' '); N_NONT=$(wc -l < "$NONT" | tr -d ' '); N_BULL=$(wc -l < "$TMP/bull.keys" | tr -d ' ')
}
# one redis-cli process, one command per key (stdin mode prints raw replies, one per command)
batch() { _cmd=$1; _file=$2; awk -v c="$_cmd" '{print c " " $0}' "$_file" | rcli_in; }
nonbull_digest() { sha < "$TMP/nonbull.keys"; }

# strict value-shape validation of every target; sets VALUE_DIGEST
validate_targets() {
  if [ "$N_FLOAT" -gt 0 ]; then
    batch GET "$TMP/float.keys" | tr -d '\r' > "$TMP/float.vals"
    [ "$(wc -l < "$TMP/float.vals" | tr -d ' ')" = "$N_FLOAT" ] || die "float:* reply count != key count (a value contains a newline or a command failed)"
    bad=$(grep -c -v -E "$RE_FLOAT_VAL" "$TMP/float.vals" || true)
    [ "$bad" = 0 ] && pass "all $N_FLOAT float:* values match $RE_FLOAT_VAL (type string)" || die "$bad float:* values do not match the expected shape — refusing; investigate"
  fi
  if [ "$N_HUI" -gt 0 ]; then
    batch TYPE "$TMP/hui.keys" | tr -d '\r' | sort -u > "$TMP/hui.types"
    [ "$(cat "$TMP/hui.types")" = string ] && pass "all $N_HUI hui:* keys are strings" || die "hui:* keys are not all strings"
  fi
  if [ "$N_TEST" -gt 0 ]; then
    [ "$(rcli get test)" = 1 ] && pass "key 'test' is the string 1" || die "key 'test' does not hold the string 1 — refusing"
  fi
  {
    if [ "$N_FLOAT" -gt 0 ]; then cat "$TMP/float.vals"; fi
    if [ "$N_HUI" -gt 0 ]; then batch GET "$TMP/hui.keys"; fi
    if [ "$N_TEST" -gt 0 ]; then rcli get test; fi
  } | sha > "$TMP/value.digest"
  VALUE_DIGEST=$(cat "$TMP/value.digest")
}

indicators() {
  say "-- attack / tamper indicators (read-only) --"
  say "role=$(ifield replication role) master_host=$(ifield replication master_host) connected_slaves=$(ifield replication connected_slaves)"
  [ "$(ifield replication role)" = master ] && pass "role is master (not replicating from an external host)" || warn "role is NOT master: this Redis is a replica of $(ifield replication master_host)"
  mods=$(rcli module list | tr -d '[:space:]' || true)
  case "$mods" in
    "") pass "no modules loaded" ;;
    ERR*|\(error\)*) pass "MODULE command is disabled on this instance (renamed), so nothing can be loaded at runtime" ;;
    *) warn "modules loaded: $mods" ;;
  esac
  say "dir=$(rcli config get dir | sed -n 2p) dbfilename=$(rcli config get dbfilename | sed -n 2p)"
  [ "$(rcli config get dbfilename | sed -n 2p)" = dump.rdb ] && pass "dbfilename is dump.rdb" || warn "dbfilename has been changed (classic attack indicator)"
}

check() {
  say "== CHECK (read-only) =="
  rcli ping | grep -q PONG || die "redis does not answer PING"
  [ "$(ifield persistence loading)" = 0 ] || die "redis is loading"
  scan_all; classify
  say "dbsize=$(rcli dbsize) scanned=$N_ALL float=$N_FLOAT hui=$N_HUI test=$N_TEST bull=$N_BULL other_non_target=$(wc -l < "$TMP/nonbull.keys" | tr -d ' ')"
  [ "$(rcli dbsize)" -ge "$N_ALL" ] || warn "dbsize smaller than the scan (keys are churning)"
  if [ -s "$TMP/nonbull.keys" ]; then warn "non-target, non-bull keys exist (they will be left untouched):"; head -20 "$TMP/nonbull.keys"; fi
  awk 'BEGIN{FS=":"} {print $1 ":" $2}' "$TMP/bull.keys" | sort | uniq -c | sort -rn | head -12
  validate_targets
  say "target value digest: $VALUE_DIGEST"
  say "non-target non-bull key digest: $(nonbull_digest)"
  indicators
  [ "$N_FLOAT" -gt 0 ] || [ "$N_HUI" -gt 0 ] || [ "$N_TEST" -gt 0 ] || say "NOTE  no target keys present: nothing to do"
}

need_evidence() { [ -f "$EV/EVIDENCE_OK" ] || die "no evidence marker at $EV/EVIDENCE_OK (run --phase evidence --apply --ts $TS first)"; }

bgsave_and_wait() {
  _n=$(ifield persistence rdb_saves); rcli bgsave >/dev/null; _i=0
  while [ "$(ifield persistence rdb_saves)" = "$_n" ] || [ "$(ifield persistence rdb_bgsave_in_progress)" != 0 ] || [ "$(ifield persistence rdb_last_bgsave_status)" != ok ]; do
    _i=$((_i + 1)); [ "$_i" -ge 90 ] && die "BGSAVE did not finish within 90s"; sleep 1
  done
  pass "BGSAVE finished (rdb_saves $_n -> $(ifield persistence rdb_saves))"
}
copy_rdb() { if [ -n "${OPS_RDB_SRC:-}" ]; then cp "$OPS_RDB_SRC" "$EV/dump.rdb"; else docker cp "$RD:/data/dump.rdb" "$EV/dump.rdb"; fi; }
remote_rdb_sha() { if [ -n "${OPS_RDB_SRC:-}" ]; then sha256sum "$OPS_RDB_SRC" | cut -d' ' -f1; else docker exec "$RD" sha256sum /data/dump.rdb | cut -d' ' -f1; fi; }
check_rdb() { if [ -n "${OPS_RDB_SRC:-}" ]; then ${OPS_CHECK_RDB:-true} "$EV/dump.rdb" | tail -2; else docker exec "$RD" redis-check-rdb /data/dump.rdb | tail -2; fi; }

evidence() {
  say "== EVIDENCE =="
  check
  live || { say "DRY-RUN: would BGSAVE, copy dump.rdb to $EV/, hash + redis-check-rdb, write key manifest, target value digest, INFO/commandstats (no secrets)"; return 0; }
  mkdir -p "$EV"; chmod 700 "$CHG" "$EV"
  bgsave_and_wait
  _t=0
  while :; do
    copy_rdb
    a=$(sha256sum "$EV/dump.rdb" | cut -d' ' -f1); b=$(remote_rdb_sha)
    [ "$a" = "$b" ] && break
    _t=$((_t + 1)); [ "$_t" -ge 3 ] && die "dump.rdb kept changing while copying"; bgsave_and_wait
  done
  echo "$a  dump.rdb" > "$EV/dump.rdb.sha256"
  check_rdb > "$EV/redis-check-rdb.txt" || true
  grep -q 'looks OK' "$EV/redis-check-rdb.txt" || [ -n "${OPS_RDB_SRC:-}" ] || die "redis-check-rdb did not report OK"
  # manifest of EVERY key (name, type, bytes) so a wrongly removed key can be identified later
  batch TYPE "$ALL" | tr -d '\r' > "$TMP/all.types"
  paste -d'\t' "$ALL" "$TMP/all.types" > "$EV/key-manifest.tsv"
  cp "$TGT" "$EV/target.keys"; cp "$NONT" "$EV/nontarget.keys"
  { echo "targets_float=$N_FLOAT"; echo "targets_hui=$N_HUI"; echo "targets_test=$N_TEST"; echo "target_value_digest=$VALUE_DIGEST";
    echo "nonbull_digest=$(nonbull_digest)"; echo "dbsize=$(rcli dbsize)"; echo "all_keys_digest=$(sha < "$ALL")"; } > "$EV/pre-state.txt"
  { rcli info replication; rcli info commandstats; rcli info clients; rcli info keyspace; rcli info stats | grep -E 'rejected|expired|total_(commands|connections)' ; rcli module list; rcli acl log 20; } > "$EV/redis-info.txt" 2>&1 || true
  { rcli config get dir; rcli config get dbfilename; rcli config get appendonly; rcli config get save; } > "$EV/redis-config-nonsecret.txt" 2>&1 || true
  ( cd "$EV" && sha256sum key-manifest.tsv target.keys nontarget.keys pre-state.txt redis-info.txt > MANIFEST.sha256 )
  touch "$EV/EVIDENCE_OK"
  pass "evidence preserved in $EV (dump.rdb sha256 $a)"
}

remove() {
  say "== REMOVE =="
  check
  [ -n "$EXP_FLOAT" ] && [ -n "$EXP_HUI" ] && [ -n "$EXP_TEST" ] || die "--expect-float/--expect-hui/--expect-test are required (copy them from the check phase output)"
  [ "$N_FLOAT" = "$EXP_FLOAT" ] && [ "$N_HUI" = "$EXP_HUI" ] && [ "$N_TEST" = "$EXP_TEST" ] || die "counts differ from approval: float $N_FLOAT/$EXP_FLOAT hui $N_HUI/$EXP_HUI test $N_TEST/$EXP_TEST — stop and re-review"
  _bad=$(grep -c -E '^bull:' "$TGT" || true); [ "$_bad" = 0 ] || die "a target key is in the bull: namespace — impossible by regex; refusing"
  live || { say "DRY-RUN (not executed): UNLINK of $((N_FLOAT + N_HUI + N_TEST)) keys in batches of 500; evidence marker is checked only with --apply"; return 0; }
  need_evidence
  [ "$(sed -n 's/^target_value_digest=//p' "$EV/pre-state.txt")" = "$VALUE_DIGEST" ] || die "target values changed since the evidence was taken"
  [ "$(sha256sum "$EV/dump.rdb" | cut -d' ' -f1)" = "$(cut -d' ' -f1 "$EV/dump.rdb.sha256")" ] || die "evidence dump.rdb hash mismatch"
  pre_nb=$(nonbull_digest); pre_bull_struct=$(grep -E '^bull:[^:]+:(id|meta|wait|active|paused|delayed|failed|completed|stalled-check)$' "$TMP/bull.keys" | sort | sha)
  pre_size=$(rcli dbsize); total=$((N_FLOAT + N_HUI + N_TEST))
  awk '{ if (NR%500==1) { if (NR>1) printf "\n"; printf "UNLINK" } printf " %s", $0 } END { printf "\n" }' "$TGT" > "$TMP/unlink.cmds"
  say "+ UNLINK $total keys ($(wc -l < "$TMP/unlink.cmds" | tr -d ' ') batches)"
  rcli_in < "$TMP/unlink.cmds" | tr -d '\r' | awk '{s+=$1} END{print "unlinked=" s}' | tee "$TMP/unlinked"
  [ "$(sed 's/unlinked=//' "$TMP/unlinked")" = "$total" ] || die "UNLINK removed $(cat "$TMP/unlinked") keys, expected $total"
  scan_all; classify
  [ "$N_FLOAT$N_HUI$N_TEST" = 000 ] && pass "no target keys remain" || die "target keys remain: float=$N_FLOAT hui=$N_HUI test=$N_TEST"
  [ "$(nonbull_digest)" = "$pre_nb" ] && pass "non-target non-bull key digest unchanged" || die "non-target non-bull key set CHANGED"
  post_struct=$(grep -E '^bull:[^:]+:(id|meta|wait|active|paused|delayed|failed|completed|stalled-check)$' "$TMP/bull.keys" | sort | sha)
  [ "$post_struct" = "$pre_bull_struct" ] && pass "BullMQ structural keys unchanged" || warn "BullMQ structural keys changed (workers are live; compare census) — not caused by UNLINK of the target list"
  post_size=$(rcli dbsize)
  [ "$post_size" = "$((pre_size - total))" ] && pass "dbsize $pre_size -> $post_size (exactly -$total)" || warn "dbsize $pre_size -> $post_size (expected -$total; live queue churn)"
  { echo "removed=$total"; echo "at=$(date -u +%FT%TZ)"; echo "dbsize_before=$pre_size"; echo "dbsize_after=$post_size"; } > "$EV/REMOVED"
}

verify() {
  say "== VERIFY (read-only) =="
  scan_all; classify
  [ "$N_FLOAT$N_HUI$N_TEST" = 000 ] && pass "no float:*/hui:*/test keys" || die "target keys present: float=$N_FLOAT hui=$N_HUI test=$N_TEST"
  say "dbsize=$(rcli dbsize) bull_keys=$N_BULL"
  indicators
}

restore() {
  say "== RESTORE (recovery from evidence) =="
  need_evidence
  [ -n "$SCR_HOST" ] && [ -n "$SCR_PORT" ] || die "--scratch-host and --scratch-port are required: a scratch redis started from $EV/dump.rdb (never the live one)"
  [ "$(sha256sum "$EV/dump.rdb" | cut -d' ' -f1)" = "$(cut -d' ' -f1 "$EV/dump.rdb.sha256")" ] || die "evidence dump.rdb hash mismatch"
  _keys=${KEYS_FILE:-$EV/target.keys}; [ -s "$_keys" ] || die "key list $_keys is empty"
  say "keys to copy back: $(wc -l < "$_keys" | tr -d ' ') from $_keys (MIGRATE ... COPY without REPLACE: existing keys are never overwritten)"
  [ -n "${OPS_LIVE_HOST:-}" ] && [ -n "${OPS_LIVE_PORT:-}" ] || die "OPS_LIVE_HOST/OPS_LIVE_PORT (as seen from the scratch instance) are required"
  live || { say "DRY-RUN (not executed): MIGRATE $OPS_LIVE_HOST $OPS_LIVE_PORT COPY KEYS ... in batches of 200"; return 0; }
  # the live password is passed through the environment of this process and written into a 0600 temp file (never argv)
  _auth=""; [ -n "${REDISCLI_AUTH:-}" ] && _auth=" AUTH $REDISCLI_AUTH"
  umask 077
  awk -v h="$OPS_LIVE_HOST" -v p="$OPS_LIVE_PORT" -v a="$_auth" '{ if (NR%200==1) { if (NR>1) printf " \n"; printf "MIGRATE %s %s \"\" 0 15000 COPY%s KEYS", h, p, a } printf " %s", $0 } END { printf "\n" }' "$_keys" > "$TMP/migrate.cmds"
  _out=$(REDISCLI_AUTH="${OPS_SCRATCH_AUTH:-}" ${OPS_SCRATCH_RCLI:-redis-cli} -h "$SCR_HOST" -p "$SCR_PORT" < "$TMP/migrate.cmds" | tr -d '\r' | sort | uniq -c)
  say "$_out"
  say "$_out" | grep -E 'BUSYKEY|ERR' >/dev/null && warn "some keys were refused (BUSYKEY = already present on the live instance: left untouched)" || true
  pass "restore finished; run --phase check to confirm"
}

case "$PHASE" in
  plan|check) check ;;
  evidence) evidence ;;
  remove) remove ;;
  verify) verify ;;
  restore) restore ;;
  *) die "unknown phase $PHASE" ;;
esac
