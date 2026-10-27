# 60 双节点 Pod 经 212 访问 VPC 数据库

现场基线（2026-10-27）：60 主集群 `server1` 内网 `10.200.200.3`、公网 `60.166.152.115`；新 worker 内网 `172.16.1.123`，公网 NAT 出口待现场确认。212 独立集群 `server1` VPC 地址 `10.0.70.189`、公网 `212.64.5.249`。数据库为 `10.0.0.15:3306`、`10.0.0.17:3306`。两集群的 Pod `10.42.0.0/16`、Service `10.43.0.0/16`、Kilo `10.4.0.0/16` 重叠，只为数据库两个 `/32` 建路由。

```text
60 任一节点的 Pod → 该节点 Cilium 出站伪装 → 该节点 Kilo Peer
  → 212.64.5.249:51821 / wg-db212 → 212 SNAT 为 10.0.70.189
  → 10.0.0.15:3306 或 10.0.0.17:3306
```

60 的 worker 必须先加入同一个 K3s 集群，并由 Kilo 标为不同 location；两个 location leader 各有一把 Kilo 公钥。212 的网关当前尚未部署，因此以下是首次部署流程。212 主机及腾讯云安全组由 212 操作者执行；60 操作由持有 60 kubeconfig 的终端执行。只交换 WireGuard **公钥**。

## 1. 预检

在 60 查询两个 Node、Kilo 公钥与 Cilium IPv4 masquerade；确认 `db-via-212` 未占用：

```sh
kubectl --kubeconfig "$KUBECONFIG" get nodes -o wide
kubectl --kubeconfig "$KUBECONFIG" get node server1 -o jsonpath='{.metadata.annotations.kilo\.squat\.ai/key}{"\n"}'
kubectl --kubeconfig "$KUBECONFIG" get node <AGENT_NODE_NAME> -o jsonpath='{.metadata.annotations.kilo\.squat\.ai/key}{"\n"}'
kubectl --kubeconfig "$KUBECONFIG" -n kube-system get ds kilo cilium
kubectl --kubeconfig "$KUBECONFIG" -n kube-system get cm cilium-config -o jsonpath='{.data.enable-ipv4-masquerade}{"\n"}'
kubectl --kubeconfig "$KUBECONFIG" get peers.kilo.squat.ai
```

两条非空公钥分别记为 `<SERVER_KILO_PUBLIC_KEY>`、`<AGENT_KILO_PUBLIC_KEY>`。确认 Node InternalIP 为 `10.200.200.3`、`172.16.1.123`，且两个 location 各只有这一个 leader。预计 Pod 经 Cilium 伪装后的源地址分别为这些 Node IP；必须在 212 隧道抓包实测，若不符就停止并修正网关的源 `/32` 方案。不要把重叠的 `10.42.0.0/16` 加到 212 WireGuard AllowedIPs。

在 212 `server1` 执行：

```sh
ip -4 route get 10.0.0.15
ip -4 route get 10.0.0.17
ip -4 route get 10.200.200.3
ip -4 route get 172.16.1.123
sysctl net.ipv4.ip_forward
ip link show wg-db212
sudo ss -uln '( sport = :51821 )'
nc -vz -w 5 10.0.0.15 3306
nc -vz -w 5 10.0.0.17 3306
sudo iptables -S FORWARD
```

两条数据库路由应经同一 VPC 出口网卡，源为 `10.0.70.189`；记录网卡为 `<VPC_IF>`。`wg-db212` 应不存在、51821 未被占用。确认现有路由没有更具体的 `10.200.200.3/32` 或 `172.16.1.123/32` 业务依赖，否则停止；网关启动后这两个 `/32` 会改走隧道。数据库的访问控制应允许 `10.0.70.189`。

在 worker 网络出口查得其公网 NAT 源 IP，记为 `<AGENT_PUBLIC_EGRESS_IP>`。2026-10-27 从 worker 查询得到 `223.12.211.110`；若出口地址会变化，放行前和故障时必须重新查询。在腾讯云安全组和 212 主机防火墙，仅允许 `60.166.152.115/32` 与该公网 IP 入站 UDP 51821；确认两节点都能向 `212.64.5.249:51821/UDP` 出站。主机防火墙规则按 212 正在使用的管理器持久化，不要和临时规则重复维护。数据库无需开放公网入口。

## 2. 在 212 创建 WireGuard 网关

若缺少 `wg`、`wg-quick`，按 212 操作系统安装 `wireguard-tools`。先确认 `/etc/wireguard/wg-db212.key` 是否已存在；存在则复用，不覆盖。首次创建时仅在 212 本机执行：

```sh
sudo install -d -m 700 /etc/wireguard
sudo sh -c 'umask 077; wg genkey > /etc/wireguard/wg-db212.key'
sudo sh -c 'wg pubkey < /etc/wireguard/wg-db212.key'
```

公钥记为 `<212_WG_PUBLIC_KEY>`。通过 `sudoedit /etc/wireguard/wg-db212.conf` 建立以下配置。仅在 212 本机读取 `.key` 并填入 `<212_PRIVATE_KEY>`；替换两个公钥和 `<VPC_IF>`。不要把填好的配置提交或发到聊天。接口不设 `Address`，`wg-quick` 只为两个源 `/32` 建回程路由。

```ini
[Interface]
PrivateKey = <212_PRIVATE_KEY>
ListenPort = 51821
PostUp = for src in 10.200.200.3 172.16.1.123; do for db in 10.0.0.15 10.0.0.17; do iptables -I FORWARD -i %i -o <VPC_IF> -s "$src/32" -d "$db/32" -p tcp --dport 3306 -j ACCEPT; iptables -I FORWARD -i <VPC_IF> -o %i -s "$db/32" -d "$src/32" -p tcp --sport 3306 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT; iptables -t nat -I POSTROUTING -o <VPC_IF> -s "$src/32" -d "$db/32" -p tcp --dport 3306 -j SNAT --to-source 10.0.70.189; done; done
PostDown = for src in 10.200.200.3 172.16.1.123; do for db in 10.0.0.15 10.0.0.17; do iptables -D FORWARD -i %i -o <VPC_IF> -s "$src/32" -d "$db/32" -p tcp --dport 3306 -j ACCEPT; iptables -D FORWARD -i <VPC_IF> -o %i -s "$db/32" -d "$src/32" -p tcp --sport 3306 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT; iptables -t nat -D POSTROUTING -o <VPC_IF> -s "$src/32" -d "$db/32" -p tcp --dport 3306 -j SNAT --to-source 10.0.70.189; done; done

[Peer]
PublicKey = <SERVER_KILO_PUBLIC_KEY>
AllowedIPs = 10.200.200.3/32

[Peer]
PublicKey = <AGENT_KILO_PUBLIC_KEY>
AllowedIPs = 172.16.1.123/32
```

212 作为响应端，Peer 不填写 `Endpoint`；两节点发起握手后，WireGuard 学习其公网来源。使用 `sudo chmod 600 /etc/wireguard/wg-db212.conf`。两个 Peer 的 `AllowedIPs` 不得相同或重叠。212 不改现有 Kilo、Cilium 或 Pod/Service 路由。

若 `net.ipv4.ip_forward=0`，记录原值并确认 `/etc/sysctl.d/90-wg-db212.conf` 未被占用，再在 212 执行：

```sh
sudo sysctl -w net.ipv4.ip_forward=1
printf 'net.ipv4.ip_forward = 1\n' | sudo tee /etc/sysctl.d/90-wg-db212.conf
```

启动并检查：

```sh
sudo systemctl enable --now wg-quick@wg-db212
sudo wg show wg-db212
ip -4 route get 10.200.200.3
ip -4 route get 172.16.1.123
sudo iptables -L FORWARD -n -v
sudo iptables -t nat -L POSTROUTING -n -v
```

两个源 `/32` 应走 `wg-db212`；此时没有握手仍属正常。启动失败读 `journalctl -u wg-quick@wg-db212 -n 100 --no-pager`；若 `PostUp` 部分成功，先清理遗留的本次专用规则，再重试，避免重复规则。

## 3. 在 60 登记数据库 Peer

将以下清单保存为 60 操作终端的本地临时文件 `<PEER_FILE>`，替换 212 公钥。此 Peer 会由 60 的两个 Kilo location leader 各自使用，212 因此必须登记两把节点公钥。

```yaml
apiVersion: kilo.squat.ai/v1alpha1
kind: Peer
metadata:
  name: db-via-212
spec:
  publicKey: <212_WG_PUBLIC_KEY>
  endpoint:
    dnsOrIP:
      ip: 212.64.5.249
    port: 51821
  allowedIPs:
    - 10.0.0.15/32
    - 10.0.0.17/32
  persistentKeepalive: 25
```

```sh
kubectl --kubeconfig "$KUBECONFIG" apply --dry-run=server -f "<PEER_FILE>"
kubectl --kubeconfig "$KUBECONFIG" apply -f "<PEER_FILE>"
kubectl --kubeconfig "$KUBECONFIG" get peer db-via-212 -o yaml
```

## 4. 验证业务路径

在 60 的 **两台节点**分别检查 `ip -4 route get 10.0.0.15`、`ip -4 route get 10.0.0.17` 和 `sudo wg show kilo0`；数据库 `/32` 应走 Kilo。212 的 `sudo wg show wg-db212` 应显示两个不同 Peer 的最新握手和双向流量。Kilo 同步可能需要约 30 秒。

从分别固定在 `server1` 和 worker 的诊断 Pod，依次执行 `nc -vz -w 5 10.0.0.15 3306`、`nc -vz -w 5 10.0.0.17 3306`。若镜像没有 `nc`，使用已有数据库客户端仅测 TCP 建连，不记录密码。212 同时观察：

```sh
sudo tcpdump -ni wg-db212 'tcp port 3306 and (host 10.0.0.15 or host 10.0.0.17)'
sudo tcpdump -ni <VPC_IF> 'tcp port 3306 and (host 10.0.0.15 or host 10.0.0.17)'
sudo iptables -t nat -L POSTROUTING -n -v
```

隧道中来自 server1、worker 的源应分别为 `10.200.200.3`、`172.16.1.123`；VPC 出口均应为 `10.0.70.189`。若隧道源仍为 `10.42.x.x`，停止并查 60 Cilium 的出站伪装；不要把 212 重叠 Pod CIDR 改指向隧道。握手成功但 TCP 不通时检查两类 FORWARD/SNAT 计数、VPC 抓包、数据库安全组和监听。四种组合均成功才算完成。

## 5. 回滚

先在 60 删除**本次创建且此前不存在**的 Peer：

```sh
kubectl --kubeconfig "$KUBECONFIG" delete peer db-via-212
```

再在 212 停止网关：

```sh
sudo systemctl disable --now wg-quick@wg-db212
ip -4 route get 10.200.200.3
ip -4 route get 172.16.1.123
sudo iptables -S FORWARD
sudo iptables -t nat -S POSTROUTING
```

确认 `wg-db212` 路由和本次 12 条专用规则消失，再撤销本次 UDP 51821 安全组与主机防火墙许可。若只为此网关将 `ip_forward` 从 `0` 改为 `1`，确认无其他业务依赖后删除 `/etc/sysctl.d/90-wg-db212.conf` 并恢复原值。保留 212 原有 Kilo、Cilium 和数据库配置。
