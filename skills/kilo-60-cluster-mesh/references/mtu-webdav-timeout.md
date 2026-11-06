# 60 集群跨节点 WebDAV 大响应超时与 MTU

记录日期：2026-11-06。Pod IP 是当时的现场值，重建后必须重新查询。此文记录排查结论和待执行方案，尚未变更集群 MTU。

## 现象与证据

- 从面板代理访问 `10.42.5.17:8000` 的 WebDAV `PROPFIND Depth: 1` 卡住；绕过面板代理直连该 Pod IP 仍卡住，故不能只归因于面板代理。
- `10.42.5.17` 在 `agent1`，其 Pod 内访问自身正常；`server1` 上的 `10.42.0.51` 同类请求正常。跨节点请求中，小响应可完成，较大响应超时。实际应用响应大小仍需在修复后记录。
- 两节点物理网卡 MTU 均为 1500，`kilo0` 为 1420，Pod 与 `cilium_vxlan` 为 1500。到 `agent1` 的跨节点 Pod 路由经过 Cilium VXLAN，再由 Kilo WireGuard 承载节点间流量。

这些现象与路径 MTU 不匹配高度一致；尚未通过双端抓包证明具体丢包点。复测时若降低 MTU 后仍超时，应继续查 PMTUD、ICMP 过滤、重传及 WebDAV 处理耗时。

## 原因与边界

Kilo 0.7.0 支持 `--mtu`，默认 `auto`：从默认出口网卡 MTU 减去 WireGuard 开销 80；1500 - 80 = 1420。见上游 `cmd/kg/main.go` 的 `--mtu` 参数、`pkg/mesh/mesh.go` 的 `detectMTU`、`pkg/wireguard/wireguard.go` 的 `WireGuardOverhead`。本项目 Helm 模板 `charts/w7panel-kilo/templates/kilo.yaml` 未传 `--mtu`，所以当前 1420 符合自动计算。

IPv4 下 Cilium VXLAN 约增加 50 字节：若 Cilium 向 `kilo0` 发送的内层 Pod IP 包为 1500，则 WireGuard 前已约为 1550，超过 `kilo0` 的 1420。当前路径的 Pod MTU 理论上限约为 **1420 - 50 = 1370**；如有额外封装或路径更小，还需降低。大响应更容易触发大 TCP 段；PMTUD 或分片处理不通畅时会表现为小响应成功、大响应停住。

仅将 Kilo `--mtu` 提高到 1500，需要底层路径至少承载约 1580 字节的 WireGuard 外层 IP 包；要同时保留 1500 的 Pod MTU 和 VXLAN，底层路径至少约需 **1630**。现有物理网卡 1500，单改 Kilo 无法可靠达到该条件。手动 `ip link set kilo0 mtu ...` 也不是持久方案：Kilo 同步时会重新设置接口 MTU。

## 建议方案

1. 先读取 60 集群实际的 Cilium HelmChart/Helm 值、`cilium-config`、两端接口 MTU 和到对端 Node 的路由，保存原值及回滚方式。确认 Cilium 确实以 VXLAN 承载这条流量，并核实链路没有更小的 MTU。
2. 在 Cilium **当前安装来源**中设置 Pod MTU，初始建议 **1360**（低于 1370 理论上限，留 10 字节余量）；不要直接改 Helm 管理的 ConfigMap。按节点滚动更新 Cilium，并按 Cilium 的生效方式重建受影响的业务 Pod，使新 veth 采用新 MTU。该操作会扰动 Pod 网络，应安排维护窗口。
3. 保持 Kilo `--mtu=auto` 和当前 `kilo0=1420`。调整后在两个节点核对 Pod veth、`cilium_vxlan`、`kilo0` 的实际 MTU，并双向测试跨节点 Pod IP、大响应 WebDAV、面板代理和业务 Service。记录请求状态码、响应字节数、耗时及 TCP 重传。
4. 若验证失败，先恢复保存的 Cilium 配置并按原方式滚动更新、重建测试 Pod，再抓取两端隧道与 Pod 侧报文定位丢包点。不要仅凭 Kilo 握手或 Pod Ready 判定修复成功。

核对命令示例（在持有 **60 集群** kubeconfig 的终端执行；Node/Pod IP 以现场查询结果为准）：

```sh
kubectl --kubeconfig "$KUBECONFIG" get pods -A -o wide | grep -E 'webdav|w7panel-offline-agent|cilium'
kubectl --kubeconfig "$KUBECONFIG" -n kube-system get helmchart cilium -o yaml
kubectl --kubeconfig "$KUBECONFIG" -n kube-system get configmap cilium-config -o yaml
kubectl --kubeconfig "$KUBECONFIG" -n kube-system get ds cilium -o wide
ip -d link show kilo0
ip -d link show cilium_vxlan
ip -4 route get <OTHER_NODE_IP>
```

验收时从 `server1` 所在节点或固定到该节点的测试 Pod，使用新查询的 agent Pod IP 执行相同 `PROPFIND`；Authorization 使用现场凭据，勿保存到文档或命令历史：

```sh
curl --max-time 20 --silent --show-error --output /dev/null \\
  --write-out 'http=%{http_code} bytes=%{size_download} time=%{time_total}s\n' \\
  -X PROPFIND -H 'Depth: 1' -H 'Content-Type: text/xml; charset=utf-8' \\
  -H 'Authorization: Bearer <TOKEN>' \\
  'http://<AGENT_POD_IP>:8000/panel-api/v1/files/webdav-agent/1/agent/'
```

同样测试 `server1` 上的 agent Pod、面板代理路径和两个方向的大响应。目标是原先超时的请求在限定时间内完整返回，且滚动更新后没有新增跨节点连接故障。
