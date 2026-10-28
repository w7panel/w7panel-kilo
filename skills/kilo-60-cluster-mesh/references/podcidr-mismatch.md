# 60 集群 PodCIDR 错位记录

记录日期：2026-10-28。以下 IP 是当时的现场值；重建 Node 或 Pod 后须重新查询。

## 现象与原因

| 对象 | 当时的值 | 来源 |
| --- | --- | --- |
| `agent1` Kubernetes Node | `spec.podCIDR=10.42.2.0/24` | K3s Node CIDR 分配 |
| `agent1` CiliumNode | `spec.ipam.podCIDRs=[10.42.3.0/24]` | Cilium `cluster-pool` IPAM |
| `agent1` nginx Pod | `10.42.3.170` | Cilium 实际分配 |
| `server1` Node 与 CiliumNode | 均为 `10.42.0.0/24` | 两者在该节点碰巧一致 |

Cilium ConfigMap 当时为 `ipam=cluster-pool`、`cluster-pool-ipv4-cidr=10.42.0.0/16`、`cluster-pool-ipv4-mask-size=24`。K3s 和 Cilium 分别维护 `/24` 的分配记录；共用地址池不保证同一节点得到相同网段。重装 `agent1` 后仍出现 `.2` 与 `.3` 的错位，不能用反复重装作为修复方法。

Kilo 0.7.0 从 Kubernetes Node 的 `spec.podCIDR` 读取节点网段并加入区域可达网段，因此它看到的是 `10.42.2.0/24`；实际 Pod 却在 `10.42.3.0/24`。这会留下 Kilo 路由和实际 Pod 地址不一致的风险。现有一次从 `server1` nginx Pod 到 `agent1` nginx Pod 的 HTTP 测试返回 200，不能据此推断所有方向、所有新 Pod 或 Service 都可靠。

## 核对命令

在持有 **60 集群** kubeconfig 的终端运行，避免误查本机默认的其他集群：

```sh
kubectl --kubeconfig "$KUBECONFIG" get node agent1 server1 -o custom-columns=NAME:.metadata.name,PODCIDR:.spec.podCIDR
kubectl --kubeconfig "$KUBECONFIG" get ciliumnode agent1 server1 -o custom-columns=NAME:.metadata.name,PODCIDRS:.spec.ipam.podCIDRs
kubectl --kubeconfig "$KUBECONFIG" -n kube-system get configmap cilium-config -o jsonpath='{.data.ipam}{" "}{.data.cluster-pool-ipv4-cidr}{" "}{.data.cluster-pool-ipv4-mask-size}{"\n"}'
kubectl --kubeconfig "$KUBECONFIG" -n default get pod -o wide -l app=nginx-cross-node
```

比较每个 Node 的 PodCIDR、对应 CiliumNode 的 podCIDRs 与该节点实际 Pod IP。再从两个节点上的 Pod 双向测试 Pod IP 和所需 Service；`Ready` 或 WireGuard 握手只说明各自组件就绪。

## 处理原则

新集群应在安装 Cilium 前统一 Pod 网段分配来源，例如让 Cilium 使用 Kubernetes 分配的 PodCIDR，并确认 Kilo 读取到的网段与实际 Pod IP 一致。现有 60 集群需要安排维护窗口，制定 Cilium IPAM 与现有 Pod 的迁移方案，排空和重建受影响工作负载后双向验证。不要直接修改运行中 Node 的 `spec.podCIDR`，也不要在线切换 Cilium IPAM 模式后期待旧 Pod 地址自动迁移。

后方主机静态路由是另一条路径。例如 `10.0.64.16/32` 已从 `server1` 指向 Kilo 隧道，但 `agent1` 本机经 `eth0` 直接 ping 该地址也无回复；此故障不由上述 PodCIDR 错位解释，应检查目标主机、二层网络和目标防火墙。重装 Node 还会清除 `kilo.squat.ai/force-endpoint` 等 Node 注解，重装后需单独核对端点与静态路由。
