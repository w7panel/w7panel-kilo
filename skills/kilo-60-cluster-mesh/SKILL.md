---
name: kilo-60-cluster-mesh
description: 配置和验证 60 生产 K3s 集群的 Kilo 跨网络节点互联；适用于 server1 经公网 UDP 51820 与 NAT 后的 worker agent 通信。
---

# 60 集群跨网络 Kilo

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

## 回滚

按预检记录恢复原有 `force-endpoint`、`location`、`persistent-keepalive` 值；原来不存在的注解用 `kubectl annotate node <NAME> <KEY>-` 删除。不要删除整个 Node 的注解集合。若需退出集群，先迁移或排空 worker 上的业务，再按 [agent 文档](../k3s-agent-join-60/SKILL.md)处理。
