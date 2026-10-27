---
name: kilo-vpc-database-gateway
description: 让 60 生产 K3s 集群的 server1 与跨网络 agent Pod，经 212 腾讯云 VPC 网关访问两个私有数据库；适用于两个集群网段重叠。
---

# 60 经 212 访问 VPC 数据库

60 主集群的 `server1` 和 `172.16.1.123` worker 上的 Pod 均需访问 `10.0.0.15:3306`、`10.0.0.17:3306`。212 是另一个 K3s 集群；两边 Pod `10.42.0.0/16`、Service `10.43.0.0/16`、Kilo `10.4.0.0/16` 网段重叠。不要互相宣告完整集群网段，也不要让 212 节点通过 `kgctl connect` 加入 60 集群。

在 212 `server1` 使用独立 WireGuard 接口 `wg-db212`，登记 **60 两个 Kilo location leader 各自的公钥**，只允许它们实测的出站源 `/32` 转发到两个数据库 TCP 3306。60 集群内的 `db-via-212` Kilo Peer 仅宣告数据库两个 `/32`。212 的 VPC 出口 SNAT 为 `10.0.70.189`。完整预检、配置、验证和回滚见 [212 数据库网关操作手册](references/212-vpc-database-gateway.md)。

先完成 [worker 加入 60](../k3s-agent-join-60/SKILL.md)及 [Kilo 跨网络互联](../kilo-60-cluster-mesh/SKILL.md)，再从两个 Node 提取 Kilo 公钥。在 212 的主机和安全组完成 UDP 51821 放行及网关部署后，才在 60 应用 Peer。212 主机与安全组仍由 212 操作者执行。不要将 WireGuard 私钥、数据库密码、kubeconfig、node-token 或 MCP 令牌写入仓库或聊天。

验收标准是 **分别调度在两个 Node 的 Pod 都能连接两个数据库原内网 IP 的 TCP 3306**。握手成功后仍要检查隧道源地址、VPC SNAT 与回包。若 Pod 源未伪装为对应节点 IP，停止并排查 Cilium；不要在 212 添加重叠 Pod 网段路由。
