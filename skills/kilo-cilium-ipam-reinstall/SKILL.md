---
name: kilo-cilium-ipam-reinstall
description: 为保留数据的 K3s+Cilium+Kilo 集群规划和执行重建迁移，使 Cilium 从 Kubernetes Node PodCIDR 分配 Pod IP；适用于已验证备份后的维护窗口。
---

# 重建并统一 Cilium IPAM

用于真正消除 Node PodCIDR 与 Cilium cluster-pool 网段错位。Cilium 1.16 官方文档不建议在已有集群直接切换 IPAM 模式；优先构建新 K3s 集群、恢复数据与工作负载，再切换流量。**卸载并重装现有集群上的 Cilium DaemonSet 不等于完成迁移。**

## 迁移门槛

1. 盘点 HelmChart/cilium、K3s cluster-cidr、Node/CiliumNode、所有工作负载、PVC/PV、StorageClass 和外部入口。60 集群在 2026-10-28 有 7 个 Bound PVC，其中 5 个 Longhorn 卷；PV 回收策略均为 Delete，当时 Longhorn Backup 资源为 0。重新执行盘点，不把历史数值当成当前值。
2. 为数据库做应用一致性备份，为每个 PVC 准备集群外备份或可迁移快照；把 K3s 配置、HelmChart/HelmChartConfig、工作负载清单和访问凭据的安全备份列入清单。**在隔离环境实际恢复并校验数据**，记录每项备份的恢复方法。只有备份文件、没有恢复测试，不满足迁移门槛。
3. 核对服务器清单、数据保留要求、维护窗口、切流和回退方式。若只能原机重装，必须先有独立于该集群和磁盘的数据副本；否则保留旧集群，另建目标集群。

## 目标集群配置

K3s 先分配 Node PodCIDR，再安装 Cilium 1.16.4。60 的安装源是 K3s Addon/cilium 管理的 HelmChart/cilium，对应安装清单需在**首次安装前**改为下列 IPAM 值，并保留原有与环境相关的 Cilium 设置：

~~~yaml
spec:
  set:
    ipam.mode: kubernetes
    nodeIPAM.enabled: "false"
~~~

从旧安装清单移除 ipam.operator.clusterPoolIPv4PodCIDRList；它只用于 cluster-pool。K3s 已在现有 60 集群给 Node 分配 PodCIDR（Node managedFields 的管理者为 k3s），但新集群仍需实际确认每个 Node 已有 spec.podCIDR。不要只 patch CiliumNode.spec.ipam.podCIDRs 或 Helm 生成的 cilium-config：前者不迁移 Pod IP，后者可能被 Helm 覆盖。Chart 其他参数以目标环境的安装源为准。

## 恢复与验收

等待 Cilium agent/operator Ready，确认 ConfigMap 中 ipam=kubernetes；再安装 Kilo 的 Cilium 兼容模式，恢复数据和工作负载。逐节点确认**实际 Pod IP 落在该 Node 的 spec.podCIDR 内**，不要求 CiliumNode 在 Kubernetes IPAM 模式下继续出现 cluster-pool 的 spec.ipam.podCIDRs 字段。验证双向 Pod IP、Service ClusterIP、DNS、存储读写及 Kilo 的公网 Endpoint 和后方静态路由。最后对数据库与关键文件做应用层校验，再切换入口。

旧集群保留到目标集群数据和流量均验收通过。若新集群失败，停止切流并回到旧集群；不要删除旧 PVC 或存储卷。若选择原机重装，回退只能依赖已验证的集群外备份和重建步骤，不能承诺即时恢复。

参考：Cilium 1.16 [IPAM 总览](https://docs.cilium.io/en/v1.16/network/concepts/ipam/) 与 [Kubernetes IPAM](https://docs.cilium.io/en/v1.16/network/concepts/ipam/kubernetes/)。
