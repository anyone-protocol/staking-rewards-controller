job "staking-rewards-controller-live" {
  datacenters = ["ator-fin"]
  type = "service"
  namespace = "live-protocol"

  constraint {
    attribute = "${meta.pool}"
    value = "live-protocol"
  }

  group "staking-rewards-controller-live-group" {
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

    task "staking-rewards-controller-live-service" {
      kill_timeout = "30s"
      driver = "docker"
      config {
        network_mode = "host"
        image = "ghcr.io/anyone-protocol/staking-rewards-controller:[[ .commit_sha ]]"
        force_pull = true
      }

      env {
        IS_LIVE="true"
        VERSION="[[ .commit_sha ]]"
        REDIS_MODE="sentinel"
        REDIS_MASTER_NAME="operator-checks-live-redis-master"
        ROUND_PERIOD_SECONDS="3600"
        DO_CLEAN="true"
        PORT="${NOMAD_PORT_http}"
        NO_COLOR="1"
        MIN_HEALTHY_CONSENSUS_WEIGHT="50"
        
        CU_URL="https://cu.anyone.permaweb.services"
        ONIONOO_REQUEST_TIMEOUT="60000"
        ONIONOO_REQUEST_MAX_REDIRECTS="3"
        IS_LOCAL_LEADER="true"
        CPU_COUNT="1"
        CONSUL_HOST="${NOMAD_IP_http}"
        CONSUL_PORT="8500"
        CONSUL_SERVICE_NAME="staking-rewards-controller-live"
        BUNDLER_GATEWAY="https://ar.anyone.tech"
        BUNDLER_NODE="https://ar.anyone.tech/bundler"
      }

      vault {
        role = "any1-nomad-workloads-controller"
      }

      consul {}

      template {
        data = <<EOH
        STAKING_REWARDS_PROCESS_ID="{{ key "smart-contracts/live/staking-rewards-address" }}"
        OPERATOR_REGISTRY_PROCESS_ID="{{ key "smart-contracts/live/operator-registry-address" }}"
        TOKEN_CONTRACT_ADDRESS="{{ key "ator-token/sepolia/live/address" }}"
        HODLER_CONTRACT_ADDRESS="{{ key "hodler/sepolia/live/address" }}"
        {{- range service "validator-live-mongo" }}
        MONGO_URI="mongodb://{{ .Address }}:{{ .Port }}/staking-rewards-controller-live2"
        {{- end }}
        {{- range service "onionoo-war-live" }}
        ONIONOO_DETAILS_URI="http://{{ .Address }}:{{ .Port }}/details"
        {{- end }}
        {{- range service "staking-rewards-controller-live-redis-master" }}
        REDIS_MASTER_NAME="{{ .Name }}"
        {{- end }}
        {{- range service "staking-rewards-controller-live-sentinel-1" }}
        REDIS_SENTINEL_1_HOST={{ .Address }}
        REDIS_SENTINEL_1_PORT={{ .Port }}
        {{- end }}
        {{- range service "staking-rewards-controller-live-sentinel-2" }}
        REDIS_SENTINEL_2_HOST={{ .Address }}
        REDIS_SENTINEL_2_PORT={{ .Port }}
        {{- end }}
        {{- range service "staking-rewards-controller-live-sentinel-3" }}
        REDIS_SENTINEL_3_HOST={{ .Address }}
        REDIS_SENTINEL_3_PORT={{ .Port }}
        {{- end }}
        {{- range service "api-service-live" }}
        ANYONE_API_URL="http://{{ .Address }}:{{ .Port }}"
        {{- end }}
        EOH
        destination = "local/config.env"
        env         = true
      }

      template {
        data = <<EOH
        {{ $allocIndex := env "NOMAD_ALLOC_INDEX" }}
        {{ with secret "kv/live-protocol/staking-rewards-controller-live" }}
        STAKING_REWARDS_CONTROLLER_KEY="{{.Data.data.STAKING_REWARDS_CONTROLLER_KEY}}"
        BUNDLER_NETWORK="{{.Data.data.BUNDLER_NETWORK}}"
        BUNDLER_CONTROLLER_KEY="{{.Data.data.STAKING_REWARDS_CONTROLLER_KEY}}"
        CONSUL_TOKEN_CONTROLLER_CLUSTER="{{.Data.data.CONSUL_TOKEN_CONTROLLER_CLUSTER}}"
        EVM_JSON_RPC="https://sepolia.infura.io/v3/{{ index .Data.data (print `INFURA_SEPOLIA_API_KEY_` $allocIndex) }}"
        {{ end }}
        EOH
        destination = "secrets/keys.env"
        env         = true
      }

      resources {
        cpu    = 2048
        memory = 2048
      }

      service {
        name = "staking-rewards-controller-live"
        port = "http"
        tags = ["logging"]
        check {
          name     = "live staking-rewards-controller health check"
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
