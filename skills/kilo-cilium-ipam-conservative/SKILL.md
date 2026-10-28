---
name: kilo-cilium-ipam-conservative
description: 在保留数据的 K3s+Cilium+Kilo 集群排查 Node PodCIDR 与 Cilium cluster-pool 网段错位，保守验证和修复实际通信；不执行 IPAM 模式迁移。
---

# 保守处理 Cilium IPAM 错位

适用于 60 集群这类已有 PVC、必须保留数据的现场。目标是修复已定位的连接故障并记录剩余风险；**此方案不会让两个 PodCIDR 字段变成相同值**。需要统一分配来源时，使用 [重装迁移 skill](../kilo-cilium-ipam-reinstall/SKILL.md)。

## 先确认现状

明确 kubeconfig 指向目标集群，记录 Node、CiliumNode、实际 Pod IP、Cilium HelmChart 和 Kilo 注解。60 集群在 2026-10-28 的 agent1 是 Node 10.42.2.0/24、CiliumNode 10.42.3.0/24，实际 Pod 在 .3；重建后须重新查询。现场背景见 [PodCIDR 错位记录](../kilo-60-cluster-mesh/references/podcidr-mismatch.md)。

~~~sh
kubectl --kubeconfig "$KUBECONFIG" get nodes -o custom-columns=NAME:.metadata.name,PODCIDR:.spec.podCIDR
kubectl --kubeconfig "$KUBECONFIG" get ciliumnodes -o custom-columns=NAME:.metadata.name,PODCIDRS:.spec.ipam.podCIDRs
kubectl --kubeconfig "$KUBECONFIG" get pods -A -o wide
kubectl --kubeconfig "$KUBECONFIG" -n kube-system get helmchart cilium -o yaml
kubectl --kubeconfig "$KUBECONFIG" -n kube-system get configmap cilium-config -o jsonpath='{.data.ipam}'
~~~

CiliumNode.spec.ipam.podCIDRs 由 Cilium operator 管理。直接把它改成 Node 的值不会迁移已有 Pod、cilium_host 或 Cilium health IP，后续还可能被 operator 重写。也不要直接改 Node spec.podCIDR、只改 Helm 管理的 ConfigMap，或反复重装 agent 碰运气。

## 用实际流量定位

从两节点现有 Pod 双向测试对端 Pod IP 和服务端口，再测试 Service ClusterIP。分别检查 Kilo 隧道地址、目标节点内网 IP 的路由和 Cilium 状态；Pod Ready、WireGuard 握手或单向成功不足以证明所有业务流量可达。仅对已定位的故障修正对应配置，修改前记录旧值，修改后复测同一条路径。

60 集群曾因 agent 重装丢失 kilo.squat.ai/force-endpoint，server1 到 agent 内网 IP 走默认网关；恢复经确认的固定端点后，路由改走 kilo0，跨节点 nginx HTTP 返回 200。这是端点路由问题，不能归因于 PodCIDR 错位。访问 agent 后方主机还需在 agent 本机测试目标；10.0.64.16 从 agent 本机 ping 失败，也不是 PodCIDR 问题。

如果目标 Pod 流量确实因网段错位而失败，停止对该节点调度新业务，保留现场并安排重装迁移。不要把实际 Pod 网段盲目加入 allowed-location-ips：它可能与 Cilium 自身路由竞争。

## 完成条件

记录两套 CIDR、实际 Pod IP、双向 Pod HTTP/ICMP、Service 连通性和剩余错位风险。保守处理后若通信已恢复，保持 Cilium IPAM 模式不变；若关键路径失败，不能宣称问题已解决。
