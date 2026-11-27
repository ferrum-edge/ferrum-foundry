#!/usr/bin/env bash
# Start the pinned Ferrum Edge image ($FERRUM_EDGE_IMAGE) in one gateway mode
# for the "Gateway Modes" CI job. CI only: every container is disposable and
# every database starts empty. Admin APIs listen on 127.0.0.1:9000 (and, for
# the CP + DP pair, the data plane's on 127.0.0.1:9010).
#
#   scripts/gateway-modes/up.sh file|cp-dp|mesh|postgres|mysql
set -euo pipefail

mode="${1:?mode}"
image="${FERRUM_EDGE_IMAGE:?FERRUM_EDGE_IMAGE is required}"
work="${RUNNER_TEMP:-/tmp}/ferrum-gateway-modes"
admin_secret="contract-admin-signing-secret-at-least-32-characters"
sync_secret="contract-cp-dp-sync-secret-distinct-at-least-32-chars"
hmac_secret="contract-basic-auth-hmac-secret-at-least-32-characters"
namespace="ferrum-foundry-demo"
mkdir -p "$work"
docker network create ferrum-modes >/dev/null 2>&1 || true

common_admin=(
  --env "FERRUM_NAMESPACE=$namespace"
  --env FERRUM_ADMIN_BIND_ADDRESS=0.0.0.0
  --env FERRUM_ALLOW_INSECURE_ADMIN_HTTP=true
  --env "FERRUM_ADMIN_JWT_SECRET=$admin_secret"
  --env FERRUM_ADMIN_JWT_AUDIENCE=ferrum-admin
  --env FERRUM_ADMIN_REQUIRE_NAMESPACE_CLAIM=true
)

wait_for() {
  local port="$1" container="$2"
  for _attempt in $(seq 1 90); do
    if curl --silent --show-error --output /dev/null "http://127.0.0.1:${port}/live"; then
      return 0
    fi
    sleep 2
  done
  docker logs "$container" || true
  echo "the ${container} admin API never answered on ${port}" >&2
  return 1
}

case "$mode" in
  file)
    mkdir -p "$work/file"
    cat > "$work/file/config.yaml" <<YAML
version: "1"
proxies:
  - id: modes-file-proxy
    name: modes-file-proxy
    namespace: $namespace
    listen_path: /modes-file
    backend_scheme: http
    backend_host: host.docker.internal
    backend_port: 9101
    strip_listen_path: true
upstreams: []
consumers: []
plugin_configs: []
YAML
    chmod 0644 "$work/file/config.yaml"
    docker run --detach --name ferrum-edge-mode \
      --publish 127.0.0.1:9000:9000 --publish 127.0.0.1:8000:8000 \
      --add-host host.docker.internal:host-gateway \
      --volume "$work/file:/etc/ferrum-modes:ro" \
      --env FERRUM_MODE=file \
      --env FERRUM_FILE_CONFIG_PATH=/etc/ferrum-modes/config.yaml \
      --env FERRUM_PROXY_BIND_ADDRESS=0.0.0.0 \
      "${common_admin[@]}" \
      "$image"
    wait_for 9000 ferrum-edge-mode
    ;;

  cp-dp)
    docker run --detach --name ferrum-edge-cp --network ferrum-modes \
      --publish 127.0.0.1:9000:9000 \
      --env FERRUM_MODE=cp \
      --env FERRUM_DB_TYPE=sqlite \
      --env 'FERRUM_DB_URL=sqlite:////tmp/ferrum-cp.db?mode=rwc' \
      --env FERRUM_CP_GRPC_LISTEN_ADDR=0.0.0.0:50051 \
      --env FERRUM_CP_DP_GRPC_ALLOW_PLAINTEXT=true \
      --env "FERRUM_CP_DP_GRPC_JWT_SECRET=$sync_secret" \
      --env "FERRUM_BASIC_AUTH_HMAC_SECRET=$hmac_secret" \
      "${common_admin[@]}" \
      "$image"
    wait_for 9000 ferrum-edge-cp
    docker run --detach --name ferrum-edge-dp --network ferrum-modes \
      --publish 127.0.0.1:9010:9000 --publish 127.0.0.1:8000:8000 \
      --add-host host.docker.internal:host-gateway \
      --env FERRUM_MODE=dp \
      --env FERRUM_DP_CP_GRPC_URLS=http://ferrum-edge-cp:50051 \
      --env FERRUM_CP_DP_GRPC_ALLOW_PLAINTEXT=true \
      --env "FERRUM_CP_DP_GRPC_JWT_SECRET=$sync_secret" \
      --env FERRUM_PROXY_BIND_ADDRESS=0.0.0.0 \
      "${common_admin[@]}" \
      "$image"
    wait_for 9010 ferrum-edge-dp
    ;;

  mesh)
    # A sidecar data plane with no control plane: the slice comes from a local
    # mesh document (FERRUM_MESH_CONFIG_PROTOCOL=file), and its identity from
    # a throwaway root and X.509-SVID, issued as in Edge's local-mesh guide.
    dir="$work/mesh"
    trust_domain="cluster.local"
    spiffe="spiffe://$trust_domain/ns/$namespace/sa/modes"
    mkdir -p "$dir/ca" "$dir/svid" "$dir/state"
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
      -keyout "$dir/ca/root.key" -out "$dir/ca/root.crt" \
      -days 2 -subj "/CN=foundry-ci-mesh-root" \
      -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
      -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
    openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
      -keyout "$dir/svid/svid.key" -out "$dir/svid/svid.csr" -subj "/CN=modes" 2>/dev/null
    cat > "$dir/svid/svid.ext" <<EXT
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth, clientAuth
subjectAltName = URI:$spiffe
EXT
    openssl x509 -req -in "$dir/svid/svid.csr" -days 1 -sha256 \
      -CA "$dir/ca/root.crt" -CAkey "$dir/ca/root.key" -CAcreateserial \
      -extfile "$dir/svid/svid.ext" -out "$dir/svid/svid.crt" 2>/dev/null
    cp "$dir/ca/root.crt" "$dir/svid/bundle.pem"
    rm -f "$dir/svid/svid.csr" "$dir/svid/svid.ext"
    chmod 600 "$dir/svid/svid.key"
    cat > "$dir/svid/mesh.yaml" <<YAML
mesh:
  workloads:
    - spiffe_id: $spiffe
      service_name: modes
      namespace: $namespace
      trust_domain: $trust_domain
      service_account: modes
      addresses:
        - 127.0.0.1
      ports:
        - port: 18080
          protocol: http
          name: http
      selector:
        labels:
          app: modes
        namespace: $namespace
  services:
    - name: modes
      namespace: $namespace
      ports:
        - port: 18080
          protocol: http
          name: http
      workloads:
        - spiffe_id: $spiffe
YAML
    # The key is 0600 and owned by the runner, so the container runs as it.
    docker run --detach --name ferrum-edge-mode \
      --user "$(id -u):$(id -g)" \
      --publish 127.0.0.1:9000:9000 \
      --volume "$dir/svid:/etc/ferrum-mesh:ro" \
      --volume "$dir/state:/var/lib/ferrum-modes" \
      --env FERRUM_ADMIN_AUDIT_FALLBACK_PATH=/var/lib/ferrum-modes/audit \
      --env FERRUM_ADMIN_AUDIT_SPOOL_DIR=/var/lib/ferrum-modes/audit-spool \
      --env FERRUM_TLS_MANAGED_STORE_PATH=/var/lib/ferrum-modes/tls \
      --env FERRUM_MODE=mesh \
      --env FERRUM_MESH_TOPOLOGY=sidecar \
      --env FERRUM_MESH_CONFIG_PROTOCOL=file \
      --env FERRUM_MESH_FILE_CONFIG_PATH=/etc/ferrum-mesh/mesh.yaml \
      --env "FERRUM_MESH_WORKLOAD_SPIFFE_ID=$spiffe" \
      --env FERRUM_GATEWAY_SVID_CERT_PATH=/etc/ferrum-mesh/svid.crt \
      --env FERRUM_GATEWAY_SVID_KEY_PATH=/etc/ferrum-mesh/svid.key \
      --env FERRUM_GATEWAY_SVID_TRUST_BUNDLE_PATH=/etc/ferrum-mesh/bundle.pem \
      --env FERRUM_MESH_INBOUND_LISTEN_ADDR=127.0.0.1:15006 \
      --env FERRUM_MESH_OUTBOUND_LISTEN_ADDR=127.0.0.1:15001 \
      --env FERRUM_MESH_DNS_PROXY_ENABLED=false \
      --env FERRUM_MESH_FEDERATION_POLL_INTERVAL_SECONDS=0 \
      --env FERRUM_POOL_WARMUP_ENABLED=false \
      --env FERRUM_PROXY_HTTP_PORT=0 \
      --env FERRUM_ADMIN_HTTP_PORT=9000 \
      "${common_admin[@]}" \
      "$image"
    wait_for 9000 ferrum-edge-mode
    ;;

  postgres)
    docker run --detach --name ferrum-modes-db --network ferrum-modes \
      --env POSTGRES_USER=ferrum --env POSTGRES_PASSWORD=ferrum-ci-only --env POSTGRES_DB=ferrum \
      postgres@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94
    for _attempt in $(seq 1 60); do
      if docker exec ferrum-modes-db pg_isready -U ferrum -d ferrum >/dev/null 2>&1; then break; fi
      sleep 2
    done
    docker exec ferrum-modes-db pg_isready -U ferrum -d ferrum
    db_type=postgres
    db_url='postgres://ferrum:ferrum-ci-only@ferrum-modes-db:5432/ferrum'
    ;;&

  mysql)
    if [ "$mode" = mysql ]; then
      docker run --detach --name ferrum-modes-db --network ferrum-modes \
        --env MYSQL_USER=ferrum --env MYSQL_PASSWORD=ferrum-ci-only \
        --env MYSQL_DATABASE=ferrum --env MYSQL_ROOT_PASSWORD=ferrum-ci-root-only \
        mysql@sha256:8c233bad33d520a7aae1c1e619c3a9775f4a1ba2d463d692fada04ec7f40be00
      for _attempt in $(seq 1 90); do
        if docker exec ferrum-modes-db mysql -uferrum -pferrum-ci-only -e 'SELECT 1' ferrum >/dev/null 2>&1; then break; fi
        sleep 2
      done
      docker exec ferrum-modes-db mysql -uferrum -pferrum-ci-only -e 'SELECT 1' ferrum >/dev/null
      db_type=mysql
      db_url='mysql://ferrum:ferrum-ci-only@ferrum-modes-db:3306/ferrum'
    fi
    ;;&

  postgres|mysql)
    docker run --detach --name ferrum-edge-mode --network ferrum-modes \
      --publish 127.0.0.1:9000:9000 --publish 127.0.0.1:8000:8000 \
      --add-host host.docker.internal:host-gateway \
      --env FERRUM_MODE=database \
      --env "FERRUM_DB_TYPE=$db_type" \
      --env "FERRUM_DB_URL=$db_url" \
      --env FERRUM_PROXY_BIND_ADDRESS=0.0.0.0 \
      --env "FERRUM_BASIC_AUTH_HMAC_SECRET=$hmac_secret" \
      "${common_admin[@]}" \
      "$image"
    wait_for 9000 ferrum-edge-mode
    ;;

  *)
    echo "unknown mode: $mode" >&2
    exit 2
    ;;
esac
