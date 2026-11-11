#!/usr/bin/env bash
# Run the integration tests against a throwaway S3-compatible server.
#
# R2 has no emulator for its S3 API (Miniflare only emulates the Workers
# binding), so this uses SeaweedFS: it verifies SigV4 signatures and supports
# the conditional writes the sync engine relies on.
set -euo pipefail

IMAGE="chrislusf/seaweedfs@sha256:ccad23e18639c8b98cee17e7100b95830a06077b56d8e5b006d6dcf8ec5e94a0"
NAME="r2v2-integration-$$"
PORT="${R2V2_TEST_PORT:-18333}"
KEY_ID="r2v2test"
SECRET="r2v2testsecret"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$NAME" -p "127.0.0.1:$PORT:8333" \
  -e AWS_ACCESS_KEY_ID="$KEY_ID" -e AWS_SECRET_ACCESS_KEY="$SECRET" \
  "$IMAGE" server -s3 -ip.bind=0.0.0.0 >/dev/null

echo "waiting for the S3 endpoint on port $PORT..."
for _ in $(seq 1 90); do
  # Unsigned requests are refused once the gateway is serving.
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" || true)
  if [ "$code" = "403" ] || [ "$code" = "200" ]; then ready=1; break; fi
  sleep 1
done
if [ -z "${ready:-}" ]; then
  docker logs "$NAME" | tail -30
  echo "S3 endpoint did not come up" >&2
  exit 1
fi

R2V2_TEST_ENDPOINT="http://127.0.0.1:$PORT" \
R2V2_TEST_BUCKET="r2v2-test" \
R2V2_TEST_ACCESS_KEY_ID="$KEY_ID" \
R2V2_TEST_SECRET_ACCESS_KEY="$SECRET" \
R2V2_TEST_CREATE_BUCKET=1 \
R2V2_TEST_REQUIRED=1 \
  npm run --silent test:integration
