#!/usr/bin/env bash
# Collects the raw inputs for cli/score.ts into one output directory.
set -uo pipefail

ORG=climb-your-apex
DEBUG_LEVEL=ClimbScore
OUT=${1:-target/tmp/score}
rm -rf "$OUT"
mkdir -p "$OUT/logs"

tooling_query() {
  sf data query -o "$ORG" --use-tooling-api --json -q "$1" | jq -r '.result.records[]?.Id'
}

# Compile gate: a failed deploy stops collection, and the scorer reports the gate from deploy.json.
sf project deploy start -o "$ORG" --source-dir force-app --json > "$OUT/deploy.json"
[ "$(jq -r '.result.success' "$OUT/deploy.json")" = "true" ] || exit 0

sf code-analyzer run --rule-selector pmd --target force-app --output-file "$OUT/pmd.json" || exit 1
sf code-analyzer run --rule-selector sfge --workspace force-app --output-file "$OUT/sfge.json" || exit 1

# Logs only profiling, which holds the TESTING_LIMITS blocks the scorer reads.
DEBUG_LEVEL_ID=$(tooling_query "SELECT Id FROM DebugLevel WHERE DeveloperName = '$DEBUG_LEVEL'")
if [ -z "$DEBUG_LEVEL_ID" ]; then
  DEBUG_LEVEL_ID=$(sf data create record -o "$ORG" --use-tooling-api --json -s DebugLevel \
    -v "DeveloperName=$DEBUG_LEVEL MasterLabel=$DEBUG_LEVEL ApexCode=ERROR ApexProfiling=INFO Database=NONE System=NONE Workflow=NONE Validation=NONE Callout=NONE Visualforce=NONE" \
    | jq -r '.result.id')
fi
USERNAME=$(sf org display -o "$ORG" --json | jq -r '.result.username')
USER_ID=$(sf data query -o "$ORG" --json -q "SELECT Id FROM User WHERE Username = '$USERNAME'" | jq -r '.result.records[0].Id')
START=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
END=$(date -u -v+1H +%Y-%m-%dT%H:%M:%S.000Z)
TRACE_FLAG_ID=$(tooling_query "SELECT Id FROM TraceFlag WHERE DebugLevelId = '$DEBUG_LEVEL_ID' AND TracedEntityId = '$USER_ID'")
if [ -z "$TRACE_FLAG_ID" ]; then
  sf data create record -o "$ORG" --use-tooling-api --json -s TraceFlag \
    -v "TracedEntityId=$USER_ID DebugLevelId=$DEBUG_LEVEL_ID LogType=USER_DEBUG StartDate=$START ExpirationDate=$END" > /dev/null || exit 1
else
  sf data update record -o "$ORG" --use-tooling-api --json -s TraceFlag -i "$TRACE_FLAG_ID" \
    -v "StartDate=$START ExpirationDate=$END" > /dev/null || exit 1
fi

# Failing tests exit non-zero, but still write results that the scorer needs.
sf apex run test -o "$ORG" -n AccountHealthRollupTest --code-coverage --result-format json -w 10 > "$OUT/tests.json"
jq -e '.result.summary' "$OUT/tests.json" > /dev/null || exit 1

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
