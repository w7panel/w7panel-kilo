---
name: kilo-usage
description: Kilo 通用用法：查看 mesh 状态、读懂节点注解、用 kgctl 导出配置和接入外部 Peer、编写 Kilo Peer 清单；适用于任何已安装 Kilo 的 k3s 集群。
---

# Kilo 用法

Kilo 在集群网络之上用 WireGuard 把不同网络、不同位置的节点组成 mesh。安装步骤和 218/60 特定集群的操作见 [kilo-k3s-cilium-install](../kilo-k3s-cilium-install/SKILL.md) 和 [kilo-60-cluster-mesh](../kilo-60-cluster-mesh/SKILL.md)；本 skill 只写通用用法。先把 `KUBECONFIG` 指向目标集群，再用 `kubectl get nodes -o wide` 确认节点和地址。把外部网络接进 mesh 前，先查 Pod `10.42.0.0/16`、Service `10.43.0.0/16`、Kilo `10.4.0.0/16` 是否与对端网段重叠，再规划 Peer 的 `allowedIPs`。

## 概念

- 每个 Node 有 Kilo agent（DaemonSet `kilo`，在 `kube-system`），节点间经公钥互联。
- `location` 相同的节点算同一逻辑位置，每个 location 选出一个 leader（`kilo.squat.ai/leader=true`）；leader 代表本 location 与其它 location 的 leader 建 WireGuard 隧道。跨网络节点用不同 location，加 `persistent-keepalive` 穿 NAT。
- Granularity：`kilo.squat.ai/granularity` 默认 `location`；同一 location 内的节点走原生 CNI（Cilium/Flannel 附加模式下保持 Cilium 直连），只有跨 location 流量才走隧道。
- `kilo0` 是节点上的 WireGuard 接口，承载跨 location 流量。

## 查看状态

```sh
kubectl --kubeconfig "$KUBECONFIG" -n kube-system get ds kilo -o wide
kubectl --kubeconfig "$KUBECONFIG" -n kube-system get pods -o wide -l app.kubernetes.io/name=kilo
kubectl --kubeconfig "$KUBECONFIG" get nodes -o wide
kubectl --kubeconfig "$KUBECONFIG" get node <name> -o jsonpath='{.metadata.annotations}' | tr ',' '\n'
kubectl --kubeconfig "$KUBECONFIG" -n kube-system logs <kilo-pod> --tail=100
sudo wg show kilo0            # 节点上：握手时间、Endpoint、收发计数
sudo ip route get <目标IP>     # 确认跨 location 流量走 kilo0
```

`last-seen` 注解持续更新说明 agent 正常同步；握手成功不代表业务可达，仍要用实际 Pod IP 和 Service 端口验证（命令见 [kilo-60-cluster-mesh 的验证一节](../kilo-60-cluster-mesh/SKILL.md#验证)）。

## 节点注解

下表注解说明以 Kilo 源码为准（见末尾上游 checkout）。`key`、`endpoint`、`internal-ip`、`last-seen`、`wireguard-ip`、`discovered-endpoints` 由 Kilo 自行维护，一般不要手动改：

| 注解 | 用途 |
|---|---|
| `kilo.squat.ai/location` | 逻辑位置名；每个 location 至少有一个 leader |
| `kilo.squat.ai/leader` | 手动指定 leader 而不是自动选举 |
| `kilo.squat.ai/persistent-keepalive` | NAT 后节点设持续 keepalive 周期（秒），如本仓库实践的 25；0 为关闭 |
| `kilo.squat.ai/force-endpoint` | `host:port` 覆盖公开的 WireGuard Endpoint；NAT 后节点设公网入口 |
| `kilo.squat.ai/force-internal-ip` | 覆盖 InternalIP |
| `kilo.squat.ai/allowed-location-ips` | 逗号分隔网段，宣告 location 内除 Pod IP 外的可路由地址，例如网关所在主机的 `172.16.1.3/32` |

示例（跨网络 worker）：

```sh
kubectl --kubeconfig "$KUBECONFIG" annotate node <AGENT_NODE> \
  kilo.squat.ai/location=agent-172-16-1-123 \
  kilo.squat.ai/persistent-keepalive=25 --overwrite
kubectl --kubeconfig "$KUBECONFIG" annotate node <GATEWAY_NODE> \
  kilo.squat.ai/allowed-location-ips=172.16.1.3/32 --overwrite
```

修改注解只改变 Kilo 眼中的拓扑；公网 UDP 51820 转发、主机防火墙和 NAT 仍要在环境侧配置。也可用本仓库面板（w7panel-kilo 前端）管理表中 6 个配置注解，保存即写回集群。

## kgctl

`kgctl` 是 Kilo 的客户端命令行工具，读同一 `KUBECONFIG`：

```sh
# 生成拓扑图（graphviz）
kgctl --kubeconfig "$KUBECONFIG" graph | dot -Tpng -o kilo-graph.png

# 导出某节点作为其它 WireGuard 接口的 peer 配置
kgctl --kubeconfig "$KUBECONFIG" showconf node <node-name> --as-peer -o wireguard

# 查看外部 Peer 的对端配置
kgctl --kubeconfig "$KUBECONFIG" showconf peer <peer-name> --as-peer
```

主流场景是 Linux 主机以临时 Peer 身份接入集群（`kgctl connect` 的方向、参数和清理细节见下方[实例 1](#实例-1外部运维机临时接入集群外部发起)）；`showconf` 用得少时要小心：输出默认是 WireGuard 格式，喂给 `wg-quick` 前先核对接口名和网段。

## Peer 是什么、谁连谁

Peer 就是 WireGuard 对端：两边各自拿到**对方公钥**和对方**允许来源（AllowedIPs）**即可互访。WireGuard 没有服务端/客户端之分，"谁连谁"只决定**握手由谁主动发起**——NAT 后的一方通常必须主动拨公共可达的一方，并用 keepalive 维持映射。Kilo 里的三类链路：

| 链路 | 发起方 | 被连方要具备的条件 |
|---|---|---|
| 节点 ↔ 节点 | 各 location 的 leader 互拨 | 有公网入口的节点设 `force-endpoint` 做被连方；NAT 后节点设 `persistent-keepalive` 主动拨 |
| 外部 → 集群（临时接入） | 外部机器 | 节点公布 `force-endpoint` 且 UDP 51820 可达 |
| 集群 → 外部（常驻 Peer） | 集群 Kilo agent | Peer CRD 写 `spec.endpoint` 指向对端公开 `host:port`；对端监听并登记集群 leader 公钥 |

### 实例 1：外部运维机临时接入集群（外部发起）

外部 Linux 主机要访问 218 集群。方向是**运维机主动拨 server1 的公网 Endpoint** `218.23.2.48:51820`；集群不会反向拨运维机。一条 `kgctl connect` 包办三件事：创建临时 Peer 对象、本机起 `kilo0`、向该 Endpoint 发起握手：

```sh
sudo kgctl --kubeconfig "$KUBECONFIG" connect netops-tmp \
  --allowed-ip 10.10.10.77/32 --allowed-ips 10.43.0.0/16
```

`--allowed-ip` 给运维机自己分配集群内唯一地址（须空闲、不与集群网段冲突）；`--allowed-ips` 声明要访问的 Service 网段。若控制面已有同名 Peer，`kgctl connect` 不会更新它，换未占用名称或先清理旧对象。之后在同一台机器继续验证：

```sh
sudo wg show kilo0                          # 首次同步可能要等约 30 秒
ip route get <POD_IP>                       # 应走 kilo0
nc -vz -w 3 <SERVICE_CLUSTER_IP> <port>     # 实际端口才算通
```

注意 Service ClusterIP 能否从外部访问与 Cilium 的 `bpf-lb-external-clusterip` 有关，见 [kilo-k3s-cilium-install 的实测](../kilo-k3s-cilium-install/SKILL.md#从外部-linux-连接并验证)。测试完 Ctrl-C 退出 `kgctl`，确认临时 Peer `netops-tmp` 已被清理。

### 实例 2：集群外连外部网络（集群发起，如跨 VPC 数据库网关）

60 集群的 Pod 要访问 212 VPC 内 `10.0.0.15/.17` 的两台数据库。方向反过来：**60 的 Kilo leader 主动拨 212 网关**，所以在 60 声明的 Peer 写明 212 的公开地址；212 主机自己起独立 WireGuard 接口监听并登记 60 两个 leader 的公钥：

```yaml
apiVersion: kilo.squat.ai/v1alpha1
kind: Peer
metadata:
  name: db-via-212
spec:
  publicKey: <212_WG_PUBLIC_KEY>
  allowedIPs:            # 只宣告两台数据库的 /32，不宣告整个 VPC 网段
    - 10.0.0.15/32
    - 10.0.0.17/32
  endpoint:              # 集群方向：节点拨 212 的这个入口
    dnsOrIP:
      ip: <212_PUBLIC_IP>
    port: 51821
```

212 网关侧（非 Kilo，纯 wg-quick）要互通的三件套——WireGuard 配置、路由、防火墙，示意如下，完整命令见 [kilo-vpc-database-gateway](../kilo-vpc-database-gateway/SKILL.md)：

```ini
# /etc/wireguard/wg-db212.conf（212 网关，监听方）
[Interface]
ListenPort = 51821
PrivateKey = <212_PRIVATE_KEY>

# 登记 60 两个 Kilo location leader，只放行其真实出站源 /32
[Peer]   # leader-1
PublicKey = <60_LEADER1_PUBLIC_KEY>
AllowedIPs = <leader1-outbound-ip>/32
[Peer]   # leader-2
PublicKey = <60_LEADER2_PUBLIC_KEY>
AllowedIPs = <leader2-outbound-ip>/32
```

```sh
sudo ip route add 10.0.0.15/32 dev wg-db212   # 隧道内把目标指向 wg 网关
# iptables 只放行已登记源 /32 → 两库 TCP 3306，其余默认拒绝
sudo iptables -A FORWARD -i wg-db212 -o eth0 \
  -s <leader-outbound-ip>/32 -d 10.0.0.15/32 -p tcp --dport 3306 -j ACCEPT
```

验收方向：从 60 调度在**两个 leader 所在节点**的 Pod，分别直连 `10.0.0.15:3306` 和 `10.0.0.17:3306`；`wg show wg-db212` 在 212 侧看到两边握手。若握手不通，先按发起方分头查：集群侧核对 Peer CRD 的 `endpoint`/`allowedIPs`，212 侧核对安全组 UDP 51821 与网卡名。

## Kilo Peer 清单

外部设备（路由器、VPC 网关、远端机房）常驻接入用 CRD 声明；需先 `kubectl apply -f manifests/crds.yaml`：

```yaml
apiVersion: kilo.squat.ai/v1alpha1
kind: Peer
metadata:
  name: example-peer
spec:
  publicKey: <WG_PUBLIC_KEY>
  allowedIPs:              # 只声明要进 mesh 的网段，不要宣告整段私网
    - <peer-ip>/32
    - <remote-cidr>
  endpoint:
    dnsOrIP:
      dns: example-peer.example.com
    port: 51820
  persistentKeepalive: 25
```

- `publicKey` 必填。`endpoint`（`host:port`）填对端**自己的**公开地址时，表示集群主动外连它；Peer 主动拨入集群（如 `kgctl connect`）则不写 `endpoint`，集群在握手后学到它的真实地址。
- `allowedIPs` 决定集群侧写入 `kilo0` 的路由；地址重叠会导致路由错乱甚至业务不可达，文件应用前先核对 CIDR。
- 面板的“外部 Peer”页可创建、编辑和删除这些资源；接入端的 WireGuard 配置仍需在设备上完成。
- 验收：`kubectl get peer` 能读到、`wg show kilo0` 握手成功、再从集群 Pod 与对端实际端口双向测通。

## 参考链接

- [kilo-k3s-cilium-install](../kilo-k3s-cilium-install/SKILL.md)：在 Cilium 集群安装 Kilo 与外网接入验证
- [kilo-60-cluster-mesh](../kilo-60-cluster-mesh/SKILL.md)：60 生产集群跨网络互联实例
- [kilo-vpc-database-gateway](../kilo-vpc-database-gateway/SKILL.md)：经 212 访问 VPC 数据库实例
- 上游仓库：本地 checkout 在 `/home/afan/workspace/github/kilo`
