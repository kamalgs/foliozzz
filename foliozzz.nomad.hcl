variable "openrouter_api_key" {
  type        = string
  description = "OpenRouter API key for free-tier AI insights"
  default     = ""
}

variable "image" {
  type    = string
  default = "foliozzz:latest"
}

job "foliozzz" {
  datacenters = ["dc1"]
  type        = "service"

  group "web" {
    count = 1

    network {
      port "http" {
        to = 80
      }
    }

    service {
      name = "foliozzz"
      port = "http"

      check {
        type     = "http"
        path     = "/"
        interval = "10s"
        timeout  = "2s"
      }
    }

    task "nginx" {
      driver = "docker"

      config {
        image = var.image
        ports = ["http"]
      }

      env {
        OPENROUTER_API_KEY = var.openrouter_api_key
      }

      resources {
        cpu    = 100
        memory = 64
      }
    }
  }
}
