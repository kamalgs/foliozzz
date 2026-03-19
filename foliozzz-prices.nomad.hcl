job "foliozzz-prices" {
  datacenters = ["dc1"]
  type        = "batch"

  periodic {
    crons            = ["0 6 * * *"]  # 06:00 every morning
    prohibit_overlap = true
  }

  group "updater" {
    count = 1

    task "update-prices" {
      driver = "raw_exec"

      config {
        command = "/home/agent/.local/share/mise/installs/python/3.12.12/bin/python3"
        # No flags = run all: symbol-isin → corp-actions → stocks → benchmarks
        args    = ["/home/agent/projects/foliozzz/scripts/update_prices.py"]
      }

      resources {
        cpu    = 500
        memory = 512
      }
    }
  }
}
