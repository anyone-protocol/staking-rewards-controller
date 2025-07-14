job "staking-rewards-controller-redis-sentinel-live" {
  datacenters = ["ator-fin"]
  type = "service"
  namespace = "live-protocol"

  constraint {
    attribute = "${meta.pool}"
    value = "live-protocol"
  }

  group "staking-rewards-controller-redis-sentinel-live-group" {
    count = 1

    network {
      mode = "bridge"
      port "redis-master" {
        static = 6392
        host_network = "wireguard"
      }
      port "redis-replica-1" {
        static = 6393
        host_network = "wireguard"
      }
      port "redis-replica-2" {
        static = 6394
        host_network = "wireguard"
      }
      port "sentinel-1" {
        static = 26392
        host_network = "wireguard"
      }
      port "sentinel-2" {
        static = 26393
        host_network = "wireguard"
      }
      port "sentinel-3" {
        static = 26394
        host_network = "wireguard"
      }
    }

    # volume "redis-master-data" {
    #   type      = "host"
    #   source    = "redis-master-data"
    #   read_only = false
    # }

    # volume "redis-replica-1-data" {
    #   type      = "host"
    #   source    = "redis-replica-1-data"
    #   read_only = false
    # }

    # volume "redis-replica-2-data" {
    #   type      = "host"
    #   source    = "redis-replica-2-data"
    #   read_only = false
    # }

    task "staking-rewards-controller-redis-sentinel-live-redis-master-task" {
      driver = "docker"

      config {
        image = "redis:latest"
        ports = ["redis-master"]

        args = [
          "redis-server",
          "--port", "${NOMAD_PORT_redis_master}",
          "--appendonly", "yes",
          "--repl-diskless-load", "on-empty-db",
          "--replica-announce-ip", "${NOMAD_IP_redis_master}",
          "--replica-announce-port", "${NOMAD_PORT_redis_master}",
          "--protected-mode", "no",
          "--bind", "0.0.0.0"
        ]
      }

      # volume_mount {
      #   volume      = "redis-master-data"
      #   destination = "/data"
      #   read_only   = false
      # }

      resources {
        cpu    = 1024
        memory = 2048
      }
    }

    task "staking-rewards-controller-redis-sentinel-live-redis-replica-1-task" {
      driver = "docker"

      config {
        image = "redis:latest"
        ports = ["redis-replica-1"]

        args = [
          "redis-server",
          "--port", "${NOMAD_PORT_redis_replica_1}",
          "--appendonly", "yes",
          "--replicaof", "${NOMAD_IP_redis_master}", "${NOMAD_PORT_redis_master}",
          "--repl-diskless-load", "on-empty-db",
          "--replica-announce-ip", "${NOMAD_IP_redis_replica_1}",
          "--replica-announce-port", "${NOMAD_PORT_redis_replica_1}",
          "--protected-mode", "no",
          "--bind", "0.0.0.0"
        ]
      }

      # volume_mount {
      #   volume      = "redis-replica-1-data"
      #   destination = "/data"
      #   read_only   = false
      # }

      resources {
        cpu    = 1024
        memory = 1024
      }
    }

    task "staking-rewards-controller-redis-sentinel-live-redis-replica-2-task" {
      driver = "docker"

      config {
        image = "redis:latest"
        ports = ["redis-replica-2"]

        args = [
          "redis-server",
          "--port", "${NOMAD_PORT_redis_replica_2}",
          "--appendonly", "yes",
          "--replicaof", "${NOMAD_IP_redis_master}", "${NOMAD_PORT_redis_master}",
          "--repl-diskless-load", "on-empty-db",
          "--replica-announce-ip", "${NOMAD_IP_redis_replica_2}",
          "--replica-announce-port", "${NOMAD_PORT_redis_replica_2}",
          "--protected-mode", "no",
          "--bind", "0.0.0.0"
        ]
      }

      # volume_mount {
      #   volume      = "redis-replica-2-data"
      #   destination = "/data"
      #   read_only   = false
      # }

      resources {
        cpu    = 1024
        memory = 1024
      }
    }

    task "staking-rewards-controller-redis-sentinel-live-sentinel-1-task" {
      driver = "docker"

      template {
        data = <<-EOT
        bind 0.0.0.0
        sentinel monitor staking-rewards-controller-live-redis-master {{ env "NOMAD_IP_redis_master" }} {{ env "NOMAD_PORT_redis_master" }} 2
        sentinel resolve-hostnames yes
        sentinel down-after-milliseconds staking-rewards-controller-live-redis-master 10000
        sentinel failover-timeout staking-rewards-controller-live-redis-master 10000
        sentinel parallel-syncs staking-rewards-controller-live-redis-master 1
        EOT
        destination = "local/sentinel.conf"
        change_mode = "restart"
      }

      config {
        image = "redis:latest"
        ports = ["sentinel-1"]
        args = [
          "redis-sentinel",
          "/local/sentinel.conf",
          "--port", "${NOMAD_PORT_sentinel_1}"
        ]
        volumes = [ "local/sentinel.conf:/local/sentinel.conf" ]
      }

      resources {
        cpu    = 256
        memory = 256
      }
    }

    task "staking-rewards-controller-redis-sentinel-live-sentinel-2-task" {
      driver = "docker"

      template {
        data = <<-EOT
        bind 0.0.0.0
        sentinel monitor staking-rewards-controller-live-redis-master {{ env "NOMAD_IP_redis_master" }} {{ env "NOMAD_PORT_redis_master" }} 2
        sentinel resolve-hostnames yes
        sentinel down-after-milliseconds staking-rewards-controller-live-redis-master 10000
        sentinel failover-timeout staking-rewards-controller-live-redis-master 10000
        sentinel parallel-syncs staking-rewards-controller-live-redis-master 1
        EOT
        destination = "local/sentinel.conf"
        change_mode = "restart"
      }

      config {
        image = "redis:latest"
        ports = ["sentinel-2"]
        args = [
          "redis-sentinel",
          "/local/sentinel.conf",
          "--port", "${NOMAD_PORT_sentinel_2}"
        ]
        volumes = [ "local/sentinel.conf:/local/sentinel.conf" ]
      }

      resources {
        cpu    = 256
        memory = 256
      }
    }

    task "staking-rewards-controller-redis-sentinel-live-sentinel-3-task" {
      driver = "docker"

      template {
        data = <<-EOT
        bind 0.0.0.0
        sentinel monitor staking-rewards-controller-live-redis-master {{ env "NOMAD_IP_redis_master" }} {{ env "NOMAD_PORT_redis_master" }} 2
        sentinel resolve-hostnames yes
        sentinel down-after-milliseconds staking-rewards-controller-live-redis-master 10000
        sentinel failover-timeout staking-rewards-controller-live-redis-master 10000
        sentinel parallel-syncs staking-rewards-controller-live-redis-master 1
        EOT
        destination = "local/sentinel.conf"
        change_mode = "restart"
      }

      config {
        image = "redis:latest"
        ports = ["sentinel-3"]
        args = [
          "redis-sentinel",
          "/local/sentinel.conf",
          "--port", "${NOMAD_PORT_sentinel_3}"
        ]
        volumes = [ "local/sentinel.conf:/local/sentinel.conf" ]
      }

      resources {
        cpu    = 256
        memory = 256
      }
    }

    service {
      name = "staking-rewards-controller-live-redis-master"
      port = "redis-master"

      check {
        type     = "tcp"
        interval = "10s"
        timeout  = "3s"
        address_mode = "alloc"
      }
    }

    service {
      name = "staking-rewards-controller-live-redis-replica-1"
      port = "redis-replica-1"

      check {
        type     = "tcp"
        interval = "10s"
        timeout  = "3s"
        address_mode = "alloc"
      }
    }

    service {
      name = "staking-rewards-controller-live-redis-replica-2"
      port = "redis-replica-2"

      check {
        type     = "tcp"
        interval = "10s"
        timeout  = "3s"
        address_mode = "alloc"
      }
    }

    service {
      name = "staking-rewards-controller-live-sentinel-1"
      port = "sentinel-1"

      check {
        type     = "tcp"
        interval = "10s"
        timeout  = "3s"
        address_mode = "alloc"
      }
    }

    service {
      name = "staking-rewards-controller-live-sentinel-2"
      port = "sentinel-2"

      check {
        type     = "tcp"
        interval = "10s"
        timeout  = "3s"
        address_mode = "alloc"
      }
    }

    service {
      name = "staking-rewards-controller-live-sentinel-3"
      port = "sentinel-3"

      check {
        type     = "tcp"
        interval = "10s"
        timeout  = "3s"
        address_mode = "alloc"
      }
    }
  }
}
