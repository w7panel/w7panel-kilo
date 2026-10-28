---
name: kilo-60-cluster-mesh
description: 配置和验证 60 生产 K3s 集群的 Kilo 跨网络节点互联；适用于 server1 经公网 UDP 51820 与 NAT 后的 worker agent 通信。
---

# 60 集群跨网络 Kilo

60 集群的 K3s Node PodCIDR 与 Cilium 实际分配网段可能错位。排查与迁移注意事项见 [PodCIDR 错位记录](references/podcidr-mismatch.md)。
保留现有数据时按 [保守处理 skill](../kilo-cilium-ipam-conservative/SKILL.md) 验证和修复实际流量；需要统一 IPAM 分配来源时按 [重装迁移 skill](../kilo-cilium-ipam-reinstall/SKILL.md) 准备备份与迁移。

60 是主 K3s 集群，`server1` 为 `10.200.200.3`，公网 `60.166.152.115:51820/UDP` 需转发到该节点。`172.16.1.123` 是加入同一集群的 worker，所在网络不能直达 `10.200.200.3`。两节点分别放在不同的 Kilo location；worker 经 NAT 主动连接 server1，设置 25 秒 keepalive。不要在 worker 上运行 `kgctl connect` 或创建同名独立 Peer。

沿用现有 Kilo `0.7.0` 和 Cilium 附加模式（`--cni=false --compatibility=cilium --local=false`）。不要应用会删除 Cilium CNI 文件的独立 Kilo CNI 清单。加入步骤见 [k3s-agent-join-60](../k3s-agent-join-60/SKILL.md)；访问 212 VPC 数据库另见 [kilo-vpc-database-gateway](../kilo-vpc-database-gateway/SKILL.md)。

## 预检与配置

在持有 60 kubeconfig 的终端执行。先记录现有注解和 Node 地址，确认 Kilo、Cilium 均 Ready，并分别检查云安全组、上游路由器的 DNAT 和 server1 主机防火墙。公网 UDP 51820 必须转发到 `10.200.200.3:51820`；仅修改 Kubernetes 注解无法开启转发。

```sh
kubectl --kubeconfig "$KUBECONFIG" get nodes -o wide
kubectl --kubeconfig "$KUBECONFIG" get node server1 -o yaml
kubectl --kubeconfig "$KUBECONFIG" -n kube-system get ds kilo cilium
kubectl --kubeconfig "$KUBECONFIG" -n kube-system get pods -o wide -l app.kubernetes.io/name=kilo
sudo ss -uln '( sport = :51820 )'
```

确认 `server1` 的 InternalIP 仍为 `10.200.200.3`，且 `kilo.squat.ai/force-endpoint` 没有其他业务设定后，设置公网 Endpoint：

```sh
kubectl --kubeconfig "$KUBECONFIG" annotate node server1 \
  kilo.squat.ai/force-endpoint=60.166.152.115:51820 --overwrite
```

worker 注册并出现 Kilo Pod 后，先确认其 Node 名称和 InternalIP 是 `172.16.1.123`，再设独立 location 和 NAT keepalive；`server1` 保持原 location：

```sh
kubectl --kubeconfig "$KUBECONFIG" annotate node <AGENT_NODE_NAME> \
  kilo.squat.ai/location=agent-172-16-1-123 \
  kilo.squat.ai/persistent-keepalive=25 --overwrite
```

## 验证

等待两个 DaemonSet 均为 2/2 Ready；查询两个 Node 上的 Kilo Pod 日志和注解。Kilo 同步可能需要约 30 秒。两台主机装有 `wireguard-tools` 时执行 `sudo wg show kilo0`，检查最新握手和双向传输计数；worker 未安装该工具时，用 Kilo 日志、路由和双向 Pod 通信验证；worker 应能看到 `60.166.152.115:51820` Endpoint，server1 在握手后学习 worker 的 NAT Endpoint。

从分别固定到两个 Node 的现有诊断 Pod 测试另一节点的 Pod IP 和实际服务端口，再测所需 Service ClusterIP。检查 `ip -4 route get <OTHER_NODE_IP>`、Pod 网络策略以及 Cilium 状态。Pod Ready 或 WireGuard 握手单独不能证明跨节点业务可达。若访问 ClusterIP 失败，核对 Cilium 的 `bpf-lb-external-clusterip` 和具体 Service 类型；不要直接套用 218 的 Helm 参数。

## Pod IP 与 Service 验证命令

Pod 跨节点通信使用 **Pod IP**，从 `kubectl get pod -o wide` 的 `IP` 列读取。60 的 Pod 网段为 `10.42.0.0/16`，但 Pod IP 会随重建变化；2026-10-27 临时测试用过 `10.42.0.227`（server1）和 `10.42.1.139`（agent），测试 Pod 已删除，不能复用这些 IP。Service 通信使用 `kubectl get svc` 的 **ClusterIP + Service 端口**，也可使用集群 DNS 名；不要把 Node IP 当成 ClusterIP。

若没有带 `ping`、`nc`、`nslookup` 的现有诊断 Pod，可在 60 集群临时创建两个 Pod，每个节点一个。先确认名称未占用，测试完成立即删除：

```sh
kubectl --kubeconfig "$KUBECONFIG" -n kube-system run kilo-netcheck-server-60 \
  --image=squat/kilo:0.7.0 --image-pull-policy=IfNotPresent --restart=Never \
  --overrides='{"spec":{"nodeName":"server1","automountServiceAccountToken":false}}' \
  --command -- /bin/sh -c 'sleep 600'
kubectl --kubeconfig "$KUBECONFIG" -n kube-system run kilo-netcheck-agent-60 \
  --image=squat/kilo:0.7.0 --image-pull-policy=IfNotPresent --restart=Never \
  --overrides='{"spec":{"nodeName":"debian-test-1","automountServiceAccountToken":false}}' \
  --command -- /bin/sh -c 'sleep 600'
kubectl --kubeconfig "$KUBECONFIG" -n kube-system wait --for=condition=Ready pod/kilo-netcheck-server-60 pod/kilo-netcheck-agent-60 --timeout=120s
kubectl --kubeconfig "$KUBECONFIG" -n kube-system get pod kilo-netcheck-server-60 kilo-netcheck-agent-60 -o wide
```

将最后一条输出中的 IP 分别记为 `<SERVER_POD_IP>`、`<AGENT_POD_IP>`，从两个 Pod 双向测试，要求均收到回复：

```sh
kubectl --kubeconfig "$KUBECONFIG" -n kube-system exec kilo-netcheck-server-60 -- ping -c 3 -W 2 <AGENT_POD_IP>
kubectl --kubeconfig "$KUBECONFIG" -n kube-system exec kilo-netcheck-agent-60 -- ping -c 3 -W 2 <SERVER_POD_IP>
```

先读当前 Service 地址，60 在 2026-10-27 的实测值为 API `10.43.0.1:443/TCP`、CoreDNS `10.43.0.10:53/UDP`：

```sh
kubectl --kubeconfig "$KUBECONFIG" -n default get svc kubernetes -o wide
kubectl --kubeconfig "$KUBECONFIG" -n kube-system get svc kube-dns -o wide
kubectl --kubeconfig "$KUBECONFIG" -n kube-system exec kilo-netcheck-agent-60 -- nc -z -w 3 10.43.0.1 443
kubectl --kubeconfig "$KUBECONFIG" -n kube-system exec kilo-netcheck-agent-60 -- nslookup kubernetes.default.svc.cluster.local 10.43.0.10
kubectl --kubeconfig "$KUBECONFIG" -n kube-system exec kilo-netcheck-agent-60 -- nc -z -w 3 kubernetes.default.svc.cluster.local 443
```

`nc` 退出码应为 `0`；`nslookup` 应返回当前 API Service ClusterIP。2026-10-27 从 agent Pod 的这些测试均成功。若 Pod IP 可达而 Service 超时，分别查 Service Endpoint、NetworkPolicy 和 Cilium Service 转发；不要把 Pod 路由成功误当作 Service 已连通。最后清理：

```sh
kubectl --kubeconfig "$KUBECONFIG" -n kube-system delete pod kilo-netcheck-server-60 kilo-netcheck-agent-60
```

## 从 server1 Pod 访问 agent 所在内网

`172.16.1.3` 在 `debian-test-1` 的 `172.16.1.123/23` 本地网络中。先在 agent 上确认 `ip -4 route get 172.16.1.3` 使用 `ens18`，且 `ping -c 2 172.16.1.3` 成功；在 server1 Pod 内确认目标当前不通。只宣告所需目标，不宣告整个 `172.16.0.0/23`：

```sh
kubectl --kubeconfig "$KUBECONFIG" annotate node debian-test-1 \
  kilo.squat.ai/allowed-location-ips=172.16.1.3/32 --overwrite
```

Kilo 会在 server1 添加 `172.16.1.3/32 via 10.4.0.2 dev kilo0`，并在 agent 对该目标启用 `KILO-NAT` 的 MASQUERADE，以便内网主机把回包送回 `172.16.1.123`。当前 agent 的 `FORWARD` 默认 DROP，Cilium 的规则没有放行 `kilo0 → ens18`；还需在 **agent 主机** 加下列两条定向规则。先检查原规则，避免覆盖其他防火墙配置：

```sh
sudo iptables -S FORWARD
sudo iptables -C FORWARD -i kilo0 -o ens18 -d 172.16.1.3/32 -j ACCEPT 2>/dev/null || \
  sudo iptables -I FORWARD 1 -i kilo0 -o ens18 -d 172.16.1.3/32 -j ACCEPT
sudo iptables -C FORWARD -i ens18 -o kilo0 -s 172.16.1.3/32 \
  -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || \
  sudo iptables -I FORWARD 2 -i ens18 -o kilo0 -s 172.16.1.3/32 \
  -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
```

在 agent 上用下面的 systemd unit 持久化，`ExecStart` 先检查规则是否已存在；当前生产 agent 已安装并启用它。若主网卡不是 `ens18`，先修改接口名：

```sh
sudo tee /etc/systemd/system/kilo-172-16-1-3-forward.service >/dev/null <<'EOF'
[Unit]
Description=Forward Kilo traffic to 172.16.1.3 through this agent
After=k3s-agent.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c '/usr/sbin/iptables -C FORWARD -i kilo0 -o ens18 -d 172.16.1.3/32 -j ACCEPT 2>/dev/null || /usr/sbin/iptables -I FORWARD 1 -i kilo0 -o ens18 -d 172.16.1.3/32 -j ACCEPT'
ExecStart=/bin/sh -c '/usr/sbin/iptables -C FORWARD -i ens18 -o kilo0 -s 172.16.1.3/32 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || /usr/sbin/iptables -I FORWARD 2 -i ens18 -o kilo0 -s 172.16.1.3/32 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT'
ExecStop=/bin/sh -c '/usr/sbin/iptables -D FORWARD -i kilo0 -o ens18 -d 172.16.1.3/32 -j ACCEPT 2>/dev/null || true'
ExecStop=/bin/sh -c '/usr/sbin/iptables -D FORWARD -i ens18 -o kilo0 -s 172.16.1.3/32 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || true'

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now kilo-172-16-1-3-forward.service
systemctl is-enabled kilo-172-16-1-3-forward.service
systemctl is-active kilo-172-16-1-3-forward.service
```

重启后检查 `systemctl status kilo-172-16-1-3-forward.service` 和 `iptables -L FORWARD -nv --line-numbers`。

从固定在 server1 的临时 Pod 测试 `ping -c 3 -W 2 172.16.1.3`，并用实际业务端口做 TCP 测试；只验证 IP 时，不把 ping 成功当作数据库服务可用。2026-10-27 的测试 Pod `10.42.0.111` ping 收到 3/3 回包，平均 36.249 ms。测试 Pod 已删除。若路由正确但没有回包，检查 agent 的 `FORWARD` 计数、`KILO-NAT` 计数和目标主机防火墙；Kilo 及 Cilium Ready 不能代替这条路径的实际测试。

### MySQL 实际连接验证

`172.16.1.3` 是运行本仓库操作环境的主机。2026-10-27 已在该主机启动独立测试容器 `kilo-mysql-netcheck`，镜像为 `docker.m.daocloud.io/library/mysql:8.4`，仅绑定 `172.16.1.3:3306`。启动前先检查容器名和端口，避免影响已有数据库：

```sh
docker ps -a --filter name=kilo-mysql-netcheck
ss -ltn '( sport = :3306 )'
```

该测试容器的随机 root 密码在主机 `/home/afan/.config/kilo/mysql-netcheck.env`，文件权限为 `0600`；不要复制到仓库、聊天或 Kubernetes Pod 定义中。若需要重建**测试容器**，先确认原容器和数据确实可弃，再使用受限的本机密码文件启动：

```sh
docker run -d --rm --name kilo-mysql-netcheck \
  --env-file /home/afan/.config/kilo/mysql-netcheck.env \
  -p 172.16.1.3:3306:3306 docker.m.daocloud.io/library/mysql:8.4
```

先在数据库主机本地执行 `SELECT VERSION(), 1` 确认 MySQL Ready，并创建一个临时、无额外权限的测试账号。在持有 60 kubeconfig 的终端，从固定到 `server1` 的短时 MySQL 客户端 Pod 测试；`-p` 会交互提示输入该**临时账号**密码，避免把密码写入 Pod 定义或命令行参数：

```sh
kubectl --kubeconfig "$KUBECONFIG" -n kube-system run kilo-mysql-check-60 \
  --rm -it --restart=Never --image=docker.m.daocloud.io/library/mysql:8.4 \
  --overrides='{"spec":{"nodeName":"server1","automountServiceAccountToken":false}}' \
  --command -- mysql --connect-timeout=5 --protocol=TCP \
  -h 172.16.1.3 -P 3306 -u <TEMP_USER> -p -N \
  -e 'SELECT VERSION(), 1 AS remote_sql_ok'
```

实测从 server1 Pod 登录成功，查询返回 `8.4.13` 和 `1`。测试后删除临时数据库账号并确认测试 Pod 已删除；当前测试账号和 Pod 均已清理，MySQL 测试容器仍在运行。该容器使用 `--rm` 且没有数据卷，停止后数据会丢失，不能作为正式数据库。

撤销该目标访问：先在 agent 上执行 `sudo systemctl disable --now kilo-172-16-1-3-forward.service`，按需删除该 unit 并 `daemon-reload`；然后在 60 执行 `kubectl --kubeconfig "$KUBECONFIG" annotate node debian-test-1 kilo.squat.ai/allowed-location-ips-`。若原注解包含其他网段，只移除 `172.16.1.3/32` 并保留原值。

## 回滚

按预检记录恢复原有 `force-endpoint`、`location`、`persistent-keepalive` 值；原来不存在的注解用 `kubectl annotate node <NAME> <KEY>-` 删除。不要删除整个 Node 的注解集合。若需退出集群，先迁移或排空 worker 上的业务，再按 [agent 文档](../k3s-agent-join-60/SKILL.md)处理。
