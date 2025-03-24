job "staking-rewards-controller-stage" {
  datacenters = ["ator-fin"]
  type = "service"

  group "staking-rewards-controller-stage-group" {
    
    count = 2

    update {
      max_parallel     = 1
      min_healthy_time = "30s"
      healthy_deadline = "5m"
    }

    network {
      port "http" {
        host_network = "wireguard"
      }
    }

    task "staking-rewards-controller-stage-service" {
      driver = "docker"
      config {
        network_mode = "host"
        image = "ghcr.io/anyone-protocol/staking-rewards-controller:[[.deploy]]"
        force_pull = true
      }

      vault {
        policies = ["staking-rewards-stage"]
      }

      env {
        BUMP=""
        IS_LIVE="true"
        VERSION="[[.commit_sha]]"
        BUNDLER_GATEWAY="https://ar.anyone.tech"
        BUNDLER_NODE="https://ar.anyone.tech/bundler"
        CPU_COUNT="1"
        CONSUL_HOST="${NOMAD_IP_http}"
        CONSUL_PORT="8500"
        SERVICE_NAME="staking-rewards-controller-stage"
        ROUND_PERIOD_SECONDS="900"
        DO_CLEAN="false"
        PORT="${NOMAD_PORT_http}"
        NO_COLOR="1"
        MIN_HEALTHY_CONSENSUS_WEIGHT="50"
        CU_URL="https://cu.ardrive.io"
      }

      template {
        data = <<EOH
        {{with secret "kv/staking-rewards/stage"}}
          STAKING_REWARDS_CONTROLLER_KEY="{{.Data.data.STAKING_REWARDS_CONTROLLER_KEY}}"
          REWARDS_POOL_KEY="{{.Data.data.STAKING_REWARDS_CONTROLLER_KEY}}"
          BUNDLER_NETWORK="{{.Data.data.BUNDLER_NETWORK}}"
          BUNDLER_CONTROLLER_KEY="{{.Data.data.STAKING_REWARDS_CONTROLLER_KEY}}"
          EVM_JSON_RPC="{{.Data.data.EVM_JSON_RPC}}"
          CONSUL_TOKEN_CONTROLLER_CLUSTER="{{.Data.data.CONSUL_TOKEN_CONTROLLER_CLUSTER}}"
        {{end}}

        STAKING_REWARDS_PROCESS_ID="[[ consulKey "smart-contracts/stage/staking-rewards-address" ]]"
        OPERATOR_REGISTRY_PROCESS_ID="[[ consulKey "smart-contracts/stage/operator-registry-address" ]]"
        TOKEN_CONTRACT_ADDRESS="[[ consulKey "ator-token/sepolia/stage/address" ]]"
        HODLER_CONTRACT_ADDRESS="[[ consulKey "hodler/sepolia/stage/address" ]]"
        {{- range service "validator-stage-mongo" }}
          MONGO_URI="mongodb://{{ .Address }}:{{ .Port }}/staking-rewards-controller-stage-testnet"
        {{- end }}
        {{- range service "staking-rewards-controller-redis-stage" }}
          REDIS_HOSTNAME="{{ .Address }}"
          REDIS_PORT="{{ .Port }}"
        {{- end }}

        {{- range service "onionoo-war-live" }}
          ONIONOO_DETAILS_URI="http://{{ .Address }}:{{ .Port }}/details"
        {{- end }}
        ONIONOO_REQUEST_TIMEOUT="60000"
        ONIONOO_REQUEST_MAX_REDIRECTS="3"
        EOH
        destination = "secrets/file.env"
        env         = true
      }
      
      resources {
        cpu    = 2048
        memory = 2048
      }

      service {
        name = "staking-rewards-controller-stage"
        port = "http"
        tags = ["logging"]
        check {
          name     = "stage staking-rewards-controller health check"
          type     = "http"
          path     = "/health"
          interval = "5s"
          timeout  = "10s"
          check_restart {
            limit = 10
            grace = "15s"
          }
        }
      }
    }
  }
}
