#!/usr/bin/env bash
# Collects the raw inputs for cli/score.ts into one output directory.
# SKIP_PMD, SKIP_SFGE, SKIP_TESTS and SKIP_LOGS set to 1 skip the inputs of dimensions with weight 0.
set -uo pipefail

[ $# -eq 3 ] || { echo "Usage: $0 <target-org alias or username> <run folder> <comma-separated test classes>" >&2; exit 1; }
ORG=$1
OUT=$2
TEST_CLASSES=$3
DEBUG_LEVEL=ClimbScore
rm -rf "$OUT"
mkdir -p "$OUT/logs" target/tmp/code-analyzer/logs

tooling_query() {
  sf data query -o "$ORG" --use-tooling-api --json -q "$1" | jq -r '.result.records[]?.Id'
}

# Compile gate: a failed deploy stops collection, and the scorer reports the gate from deploy.json.
# Each worktree has its own source tracking, so org changes from other worktrees show as conflicts.
sf project deploy start -o "$ORG" --source-dir force-app --ignore-conflicts --json > "$OUT/deploy.json"
jq -e '.result.success != null' "$OUT/deploy.json" > /dev/null || { jq -r '.message' "$OUT/deploy.json" >&2; exit 1; }
[ "$(jq -r '.result.success' "$OUT/deploy.json")" = "true" ] || exit 0

[ "${SKIP_PMD:-}" = 1 ] || sf code-analyzer run --rule-selector pmd --target force-app --output-file "$OUT/pmd.json" || exit 1
[ "${SKIP_SFGE:-}" = 1 ] || sf code-analyzer run --rule-selector sfge --workspace force-app --output-file "$OUT/sfge.json" || exit 1
[ "${SKIP_TESTS:-}" = 1 ] && exit 0

# Logs only profiling, which holds the TESTING_LIMITS blocks the scorer reads.
START=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
if [ "${SKIP_LOGS:-}" != 1 ]; then
  DEBUG_LEVEL_ID=$(tooling_query "SELECT Id FROM DebugLevel WHERE DeveloperName = '$DEBUG_LEVEL'")
  if [ -z "$DEBUG_LEVEL_ID" ]; then
    DEBUG_LEVEL_ID=$(sf data create record -o "$ORG" --use-tooling-api --json -s DebugLevel \
      -v "DeveloperName=$DEBUG_LEVEL MasterLabel=$DEBUG_LEVEL ApexCode=ERROR ApexProfiling=INFO Database=NONE System=NONE Workflow=NONE Validation=NONE Callout=NONE Visualforce=NONE" \
      | jq -r '.result.id')
  fi
  USERNAME=$(sf org display -o "$ORG" --json | jq -r '.result.username')
  USER_ID=$(sf data query -o "$ORG" --json -q "SELECT Id FROM User WHERE Username = '$USERNAME'" | jq -r '.result.records[0].Id')
  END=$(date -u -v+1H +%Y-%m-%dT%H:%M:%S.000Z)
  TRACE_FLAG_ID=$(tooling_query "SELECT Id FROM TraceFlag WHERE DebugLevelId = '$DEBUG_LEVEL_ID' AND TracedEntityId = '$USER_ID'")
  if [ -z "$TRACE_FLAG_ID" ]; then
    sf data create record -o "$ORG" --use-tooling-api --json -s TraceFlag \
      -v "TracedEntityId=$USER_ID DebugLevelId=$DEBUG_LEVEL_ID LogType=USER_DEBUG StartDate=$START ExpirationDate=$END" > /dev/null || exit 1
  else
    sf data update record -o "$ORG" --use-tooling-api --json -s TraceFlag -i "$TRACE_FLAG_ID" \
      -v "StartDate=$START ExpirationDate=$END" > /dev/null || exit 1
  fi
fi

# Failing tests exit non-zero, but still write results that the scorer needs.
sf apex run test -o "$ORG" -n "$TEST_CLASSES" --code-coverage --result-format json -w 10 > "$OUT/tests.json"
jq -e '.result.summary' "$OUT/tests.json" > /dev/null || exit 1
[ "${SKIP_LOGS:-}" = 1 ] && exit 0

# The test log can appear a few seconds after the run finishes.
for _ in 1 2 3 4 5 6; do
  LOG_IDS=$(tooling_query "SELECT Id FROM ApexLog WHERE Operation = 'ApexTestHandler' AND StartTime >= $START")
  [ -n "$LOG_IDS" ] && break
  sleep 5
done
[ -n "$LOG_IDS" ] || { echo "No test logs found" >&2; exit 1; }
for id in $LOG_IDS; do
  sf apex get log -o "$ORG" -i "$id" -d "$OUT/logs" > /dev/null || exit 1
done
