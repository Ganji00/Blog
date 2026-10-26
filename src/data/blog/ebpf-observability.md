---
title: From a meetup talk to an eBPF observability pilot in a day
author: Mateusz Kiersnowski
pubDatetime: 2026-10-26T18:00:00Z
slug: ebpf-observability
featured: true
draft: false
tags:
  - eBPF
  - Observability
  - Grafana
  - Alloy
  - Pyroscope
  - Beyla
  - DevOps
description:
  I heard about eBPF profiling at a meetup, and the next day I had a PoC running with Grafana Alloy, Pyroscope and Beyla.
---

# Intro

Last Thursday I went to [SysOps/DevOps Warszawa MeetUp #88](https://www.sysopspolska.pl/event/sysops-devops-warszawa-meetup-88/).
The first talk, *"eBPF - 4 filar observability"* by Szymon Warda, went over the three classic observability pillars
(logs, metrics, traces) and then made the case for profiling, built on eBPF, as the fourth one. It also covered
the main approaches and vendors in this space.

I knew eBPF as "that kernel thing Cilium uses", and not much more. The pitch that got me was simple:
**you can get profiles, RED metrics and traces from running services without touching their code.** No SDK,
no redeploy, no asking every team to add a library.

The next day I went straight in and built a PoC at work. After that we ran a pilot with the
Mission Control team at Creotech Instruments. This post is a summary of what I set up, what surprised me,
and what still needs work.

# What is eBPF, in short

eBPF lets you run small, sandboxed programs inside the Linux kernel. The kernel checks each program before
loading it (the verifier), so it can't crash the kernel or loop forever. The programs attach to hooks such as
syscalls, kernel functions, network events or user-space functions, and they write data to maps that a
user-space process reads.

For observability this means:

- **Profiling**: sample stack traces of every process on the host, many times per second, at low overhead.
- **Auto-instrumentation**: watch HTTP/gRPC/SQL traffic at the kernel level and turn it into metrics and spans,
  whatever language the service is written in.

The application doesn't know any of this is happening. That's the whole point.

# The stack

I didn't want to run a pile of new agents, so everything goes through [Grafana Alloy](https://grafana.com/docs/alloy/latest/):

```
 Docker host
┌───────────────────────────────────────────────┐
│  app containers (Python, Rust)                │
│        ▲  eBPF probes                         │
│  ┌─────┴──────────────────────────────┐       │
│  │ Alloy                              │       │
│  │  pyroscope.ebpf  ── profiles ──────┼──────▶ Pyroscope
│  │  beyla.ebpf      ── metrics ───────┼──────▶ Prometheus
│  │                  ── traces ────────┼──────▶ Tempo
│  │  exporter.unix / exporter.cadvisor ┼──────▶ Prometheus
│  └────────────────────────────────────┘       │
└───────────────────────────────────────────────┘
```

Our backend is a self-hosted LGTM stack (Loki, Grafana, Tempo, Prometheus), with Pyroscope next to it.
The two Alloy components that matter here:

- [`pyroscope.ebpf`](https://grafana.com/docs/alloy/latest/reference/components/pyroscope/pyroscope.ebpf/), the
  eBPF profiler. It embeds Grafana's fork of the OpenTelemetry eBPF profiler.
- [`beyla.ebpf`](https://grafana.com/docs/alloy/latest/reference/components/beyla/beyla.ebpf/), Beyla
  (OpenTelemetry eBPF Instrumentation) running inside Alloy. It produces RED metrics and spans for HTTP, gRPC and SQL.

# Why Alloy surprised me

Before this, our host monitoring was the usual set: `node_exporter` and `cAdvisor` as separate containers on every
host, each with its own config and its own scrape job in Prometheus. It worked, but it was one more thing to keep in sync.

Alloy replaces both with built-in components, so a single config file per host covers system metrics,
container metrics, profiles and traces:

```alloy
prometheus.exporter.unix "host" { }

prometheus.exporter.cadvisor "containers" {
  docker_host = "unix:///var/run/docker.sock"
}

prometheus.scrape "host" {
  targets = array.concat(
    prometheus.exporter.unix.host.targets,
    prometheus.exporter.cadvisor.containers.targets,
  )
  forward_to = [prometheus.remote_write.default.receiver]
}

prometheus.remote_write "default" {
  endpoint {
    url = "http://prometheus:9090/api/v1/write"
  }
}
```

This is where most of the time savings came from. Adding eBPF on top was a few more blocks in a file I
already had, not a new agent to deploy.

# Setting it up on Docker

Our services run on plain Docker hosts, no Kubernetes. Alloy needs a lot of access to load eBPF programs and
see other containers' processes, so the container runs privileged in the host PID namespace:

```yaml
services:
  alloy:
    image: grafana/alloy:latest
    privileged: true
    pid: host
    command:
      - run
      - --server.http.listen-addr=0.0.0.0:12345
      - --storage.path=/var/lib/alloy/data
      # beyla.ebpf may need this, depending on your Alloy version
      - --stability.level=public-preview
      - /etc/alloy/config.alloy
    volumes:
      - ./config.alloy:/etc/alloy/config.alloy:ro
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - /sys/fs/bpf:/sys/fs/bpf
      - /sys/kernel/debug:/sys/kernel/debug:ro
    ports:
      - "12345:12345"
```

`privileged: true` is the lazy option. For a PoC it was fine. For production, the `pyroscope.ebpf` docs list the
exact capabilities you need if you want to drop it.

## Profiles

`discovery.docker` finds the containers, and a relabel rule turns the container name into `service_name`,
so each service shows up separately in Pyroscope:

```alloy
discovery.docker "local" {
  host = "unix:///var/run/docker.sock"
}

discovery.relabel "containers" {
  targets = discovery.docker.local.targets

  rule {
    action        = "replace"
    source_labels = ["__meta_docker_container_name"]
    regex         = "/(.*)"
    target_label  = "service_name"
  }
}

pyroscope.ebpf "default" {
  targets    = discovery.relabel.containers.output
  forward_to = [pyroscope.write.default.receiver]
}

pyroscope.write "default" {
  endpoint {
    url = "http://pyroscope:4040"
  }
}
```

That's it. A few minutes after Alloy restarted, flame graphs for every container showed up in Grafana.

## RED metrics and traces

Beyla discovers processes by the ports they listen on. It exports metrics as scrape targets, and traces go
through the regular `otelcol` pipeline to Tempo:

```alloy
beyla.ebpf "default" {
  discovery {
    instrument {
      open_ports = "8000-8999"
    }
  }

  metrics {
    features = ["application", "application_service_graph"]
  }

  output {
    traces = [otelcol.processor.batch.default.input]
  }
}

prometheus.scrape "beyla" {
  targets    = beyla.ebpf.default.targets
  forward_to = [prometheus.remote_write.default.receiver]
}

otelcol.processor.batch "default" {
  output {
    traces = [otelcol.exporter.otlp.tempo.input]
  }
}

otelcol.exporter.otlp "tempo" {
  client {
    endpoint = "tempo:4317"
    tls {
      insecure = true
    }
  }
}
```

# The pilot with Mission Control

The Mission Control team runs services written in Python and Rust. They were a good first team because we didn't
need anything from them: no code changes and no redeploys. I rolled Alloy out on their hosts and showed them the dashboards.

What landed best was **RED metrics for free**: request rate, error rate and latency histograms per endpoint,
for services that had never exported a single HTTP metric. Nobody had to add a Prometheus client or
decide on bucket boundaries. Beyla saw the traffic and the numbers were there.

The feedback was positive, which is what you want from a pilot. It also gave me arguments to roll it out more widely.

# The Python 3.14 issue

One thing didn't work out of the box. For services running on **Python 3.14**, the Python frames were missing
from the profiles. Alloy logged errors like:

```
could not extract TLS offset from _PyThreadState_GetCurrent
symbolization failed for PID ..., frame type 1: failed to get python object ...
```

Python 3.13 was fine. It turned out other people had hit the same thing, and there's an open issue:
[grafana/alloy#7460](https://github.com/grafana/alloy/issues/7460). I added my report there too.

The workaround for now is a dev image that already includes the patch. With it, the Python 3.14 profiles worked for me. With the official release
images, at the time of writing, **profiles for Python 3.14 don't work.** If you're on 3.14, check the issue
before you spend an evening debugging your own setup like I did.

Rust services just worked. Native code is the easy case for an eBPF profiler, as long as the binaries have symbols.

# Correlating everything: not done yet

This is the part that will take the most time. Having profiles, metrics, traces and logs in one Grafana is
nice. Jumping between them in one click is the real goal, and that needs some work.

My first assumption was that **for traces to correlate, the software needs an OpenTelemetry SDK anyway**.
After digging into it, that turned out to be only partly true:

- **Beyla creates spans without an SDK.** Since Beyla 2.0 it can also propagate trace context between HTTP
  services in any language, by writing the `traceparent` header at the network level. That part is **off by default**,
  and it won't work on kernels in lockdown mode (common with Secure Boot).
- **An SDK is still needed** for context across message queues and for business attributes on spans
  (user ID, mission ID and so on). eBPF only sees the traffic. It doesn't know what the request means.
- **Traces to profiles.** Pyroscope's classic "span profiles" do need the Pyroscope SDK plus an
  `otel-profiling-*` wrapper in the app. But recent Alloy versions added `obi_process_context_enabled` to
  `pyroscope.ebpf` (on by default). It shares a BPF map with `beyla.ebpf` and adds `trace_id`/`span_id` labels
  to profile samples, with no SDK at all. Both components must use the same `bpf_fs_root`:

```alloy
pyroscope.ebpf "default" {
  targets                     = discovery.relabel.containers.output
  forward_to                  = [pyroscope.write.default.receiver]
  bpf_fs_root                 = "/sys/fs/bpf/"
  obi_process_context_enabled = true
}
```

- **Logs.** To jump from a log line to a trace, the `trace_id` has to be in the log line. In our case that means
  work on the app side.

So eBPF gets you surprisingly far, but for full correlation some app-side OpenTelemetry work is still
needed. I'd treat eBPF as the baseline that covers every service from day one, with the SDK added
where a team wants more detail.

# Lessons learned

**Go from talk to PoC fast.** The day after the meetup I still remembered everything from the talk and was
excited about it. A week later it would have been another item on my "to try someday" list.

**Pick a pilot team that has to do nothing.** Zero-code instrumentation is an easy sell when the team
doesn't have to change, review or redeploy anything.

**Alloy is great.** Consolidating `node_exporter`, `cAdvisor`, profiling and auto-instrumentation into one
agent with one config language was the biggest win, more than eBPF itself.

**Check your runtime versions.** eBPF profilers read runtime internals (like the Python interpreter's
thread state), and those change between versions. New runtime releases can break profiling until the profiler catches up.

**Privileged containers are a PoC shortcut.** Fine for a pilot, but for production, trim it down to the specific capabilities.

# Closing

Not bad for something I barely knew a week ago. Thanks to Szymon Warda for the talk,
and to the SysOps/DevOps Polska organisers for running the meetup.

Next steps for me: fine-tuning what Beyla instruments, enabling context propagation, and getting
logs, traces and profiles linked properly. I'll probably write a follow-up once the correlation part works.
