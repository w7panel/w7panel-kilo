# 60 Pod 经 212 访问 VPC 数据库

2026-10-26 核对值：60 是生产集群，单节点 `server1` 的内网 IP 为 `10.200.200.3`，公网出口 IP 为 `60.166.152.115`，Cilium IPv4 masquerade 为 `true`。60 的 Kilo 当前只公布内网 Endpoint `10.200.200.3:51820`，所以由 60 主动连接 212，212 不访问 60 的 UDP 51820。212 的 `server1` 内网 IP 为 `10.0.70.189`，公网 IP 为 `212.64.5.249`；212 已运行 Kilo 和 Cilium。两个集群的 Pod `10.42.0.0/16`、Service `10.43.0.0/16`、Kilo `10.4.0.0/16` 均重叠。218 是此前的测试集群，不是本文操作目标。数据库目标为 `10.0.0.15:3306`、`10.0.0.17:3306`。

```text
60 Pod → Cilium 出站伪装为 10.200.200.3 → 60 Kilo Peer
        → 212.64.5.249:51821 / wg-db212
        → 212 server1 SNAT 为 10.0.70.189
        → 10.0.0.15:3306 或 10.0.0.17:3306
```

在 212 `server1` 执行 212 命令；在持有 60 kubeconfig 的终端执行 60 命令。按顺序准备并启动 212 网关、登记 60 Peer、验证。仅交换 WireGuard 公钥，私钥不离开 212 主机。

## 1. 预检

在 60 执行，`KUBECONFIG` 指向 60：

```sh
kubectl --kubeconfig "$KUBECONFIG" get nodes -o wide
kubectl --kubeconfig "$KUBECONFIG" get node server1 -o jsonpath='{.metadata.annotations.kilo\.squat\.ai/key}{"\n"}'
kubectl --kubeconfig "$KUBECONFIG" -n kube-system get ds kilo cilium
kubectl --kubeconfig "$KUBECONFIG" -n kube-system get cm cilium-config -o jsonpath='{.data.enable-ipv4-masquerade}{"\n"}'
kubectl --kubeconfig "$KUBECONFIG" get peers.kilo.squat.ai
```

第二条输出是 60 Kilo 公钥，记作 `<60_KILO_PUBLIC_KEY>`。确认节点仍是单节点 `10.200.200.3`，两个 DaemonSet 正常，IPv4 masquerade 为 `true`，Peer 名 `db-via-212` 未占用。节点数或地址变化时停止，重新确定源地址和回程路由。

在 212 `server1` 执行：

```sh
ip -4 route get 10.0.0.15
ip -4 route get 10.0.0.17
ip -4 route get 10.200.200.3
sysctl net.ipv4.ip_forward
ip link show wg-db212
sudo ss -uln '( sport = :51821 )'
nc -vz -w 5 10.0.0.15 3306
nc -vz -w 5 10.0.0.17 3306
sudo wg show
sudo iptables -S FORWARD
```

数据库两条路由应显示同一个 VPC 出口网卡、源地址 `10.0.70.189`。将网卡名记作 `<VPC_IF>`。`ip link show` 应报告接口不存在，`ss` 应无监听记录；记录旧 `ip_forward` 值。两个 `nc` 测试应成功，数据库访问控制应允许来自 `10.0.70.189`。若任一条件不符，先查明实际网络；不要应用下述模板。

在腾讯云安全组和 212 主机防火墙仅允许 `60.166.152.115/32` 入站 UDP 51821，并允许 60 向 `212.64.5.249:51821` 发送 UDP。数据库本身无需开放公网入口。防火墙由 212 操作者按正在使用的管理方式持久化；不要同时用临时规则和防火墙管理器维护同一条规则。

## 2. 212 准备独立 WireGuard 接口

若缺少 `wg`、`wg-quick`，先按 212 操作系统安装 `wireguard-tools`。先确认 `/etc/wireguard/wg-db212.key` 不存在；若已存在，复用它，只运行下方读取公钥的最后一条命令，不覆盖私钥。在 212 生成密钥，只将公钥带到 60：

```sh
sudo install -d -m 700 /etc/wireguard
sudo sh -c 'umask 077; wg genkey > /etc/wireguard/wg-db212.key'
sudo sh -c 'wg pubkey < /etc/wireguard/wg-db212.key'
```

公钥输出记为 `<212_WG_PUBLIC_KEY>`。用 `sudoedit /etc/wireguard/wg-db212.conf` 创建下列配置。只在 212 本机从 `.key` 文件读取并填入 `<212_PRIVATE_KEY>`；替换两个公钥和 `<VPC_IF>`。该接口不设置 `Address`，仅通过 Peer 的 `AllowedIPs` 安装 `10.200.200.3/32` 回程路由，不占用现有的 `10.4.0.0/16`。

```ini
[Interface]
PrivateKey = <212_PRIVATE_KEY>
ListenPort = 51821
PostUp = iptables -I FORWARD -i %i -o <VPC_IF> -s 10.200.200.3/32 -d 10.0.0.15/32 -p tcp --dport 3306 -j ACCEPT
PostUp = iptables -I FORWARD -i %i -o <VPC_IF> -s 10.200.200.3/32 -d 10.0.0.17/32 -p tcp --dport 3306 -j ACCEPT
PostUp = iptables -I FORWARD -i <VPC_IF> -o %i -s 10.0.0.15/32 -d 10.200.200.3/32 -p tcp --sport 3306 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
PostUp = iptables -I FORWARD -i <VPC_IF> -o %i -s 10.0.0.17/32 -d 10.200.200.3/32 -p tcp --sport 3306 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
PostUp = iptables -t nat -I POSTROUTING -o <VPC_IF> -s 10.200.200.3/32 -d 10.0.0.15/32 -p tcp --dport 3306 -j SNAT --to-source 10.0.70.189
PostUp = iptables -t nat -I POSTROUTING -o <VPC_IF> -s 10.200.200.3/32 -d 10.0.0.17/32 -p tcp --dport 3306 -j SNAT --to-source 10.0.70.189
PostDown = iptables -D FORWARD -i %i -o <VPC_IF> -s 10.200.200.3/32 -d 10.0.0.15/32 -p tcp --dport 3306 -j ACCEPT
PostDown = iptables -D FORWARD -i %i -o <VPC_IF> -s 10.200.200.3/32 -d 10.0.0.17/32 -p tcp --dport 3306 -j ACCEPT
PostDown = iptables -D FORWARD -i <VPC_IF> -o %i -s 10.0.0.15/32 -d 10.200.200.3/32 -p tcp --sport 3306 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
PostDown = iptables -D FORWARD -i <VPC_IF> -o %i -s 10.0.0.17/32 -d 10.200.200.3/32 -p tcp --sport 3306 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
PostDown = iptables -t nat -D POSTROUTING -o <VPC_IF> -s 10.200.200.3/32 -d 10.0.0.15/32 -p tcp --dport 3306 -j SNAT --to-source 10.0.70.189
PostDown = iptables -t nat -D POSTROUTING -o <VPC_IF> -s 10.200.200.3/32 -d 10.0.0.17/32 -p tcp --dport 3306 -j SNAT --to-source 10.0.70.189

[Peer]
PublicKey = <60_KILO_PUBLIC_KEY>
AllowedIPs = 10.200.200.3/32
```

212 作为响应端，暂不填写该 Peer 的 `Endpoint`；收到 60 的首个 WireGuard 握手后，WireGuard 会学习其实际公网来源。保持 60 清单中的 `persistentKeepalive: 25`，让 60 持续发起并维持连接。

```sh
sudo chmod 600 /etc/wireguard/wg-db212.conf
```

`net.ipv4.ip_forward` 若为 `0`，先确认 `/etc/sysctl.d/90-wg-db212.conf` 未被其他用途占用，记录旧值后执行以下命令；若本来是 `1` 则不改：

```sh
sudo sysctl -w net.ipv4.ip_forward=1
printf 'net.ipv4.ip_forward = 1\n' | sudo tee /etc/sysctl.d/90-wg-db212.conf
```

不要更改 212 的 Kilo、Cilium 或本地 Pod/Service 路由。

## 3. 启动 212 网关，登记 60 数据库 Peer

先在 212 启动网关，确认回程只新增 `10.200.200.3/32`：

```sh
sudo systemctl enable --now wg-quick@wg-db212
sudo wg show wg-db212
ip -4 route get 10.200.200.3
sudo iptables -L FORWARD -n -v
sudo iptables -t nat -L POSTROUTING -n -v
```

回程路由应显示 `wg-db212`。此时还没有握手是正常的。启动失败时看 `journalctl -u wg-quick@wg-db212 -n 100 --no-pager`；若 `PostUp` 部分成功，先按相应 `PostDown` 命令清除遗留规则，再重试，不要累积重复规则。

仅向 60 应用以下清单；`<212_WG_PUBLIC_KEY>` 是上一步输出的公钥：

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

将清单保存为 60 操作终端的本地临时文件 `<PEER_FILE>`，先校验再应用：

```sh
kubectl --kubeconfig "$KUBECONFIG" apply --dry-run=server -f "<PEER_FILE>"
kubectl --kubeconfig "$KUBECONFIG" apply -f "<PEER_FILE>"
kubectl --kubeconfig "$KUBECONFIG" get peer db-via-212 -o yaml
```

## 4. 验证真实业务路径

在 60 节点执行下列命令，确认两个数据库 `/32` 走 `kilo0`，并检查握手；212 检查 `sudo wg show wg-db212`。Kilo 通常约 30 秒重新同步一次。

```sh
ip -4 route get 10.0.0.15
ip -4 route get 10.0.0.17
sudo wg show kilo0
```

握手后，从 60 已有的诊断 Pod 分别测试：

```sh
nc -vz -w 5 10.0.0.15 3306
nc -vz -w 5 10.0.0.17 3306
```

若 Pod 没有 `nc`，用已有数据库客户端只测试 TCP 建连，不在文档或日志中放密码。212 主机同时观察：

```sh
sudo tcpdump -ni wg-db212 'tcp port 3306 and (host 10.0.0.15 or host 10.0.0.17)'
sudo tcpdump -ni <VPC_IF> 'tcp port 3306 and (host 10.0.0.15 or host 10.0.0.17)'
sudo iptables -t nat -L POSTROUTING -n -v
```

在 `wg-db212` 上，请求源地址应为 `10.200.200.3`；在 VPC 出口上，源地址应为 `10.0.70.189`。若 60 Pod 源地址仍是 `10.42.x.x`，212 WireGuard 会因 Peer `AllowedIPs` 不匹配而丢弃；停止并排查 60 Cilium 的出站伪装。不要在 212 添加 `10.42.0.0/16` 回程路由，它与本集群 Pod 网段冲突。若握手正常但 TCP 不通，依次看 212 转发计数、VPC 出口抓包、数据库安全组及监听状态。验收必须两个 IP 均从 60 Pod 连通。

## 5. 回滚

先从 60 删除本次 Peer，再在 212 停止网关：

```sh
kubectl --kubeconfig "$KUBECONFIG" delete peer db-via-212
```

```sh
sudo systemctl disable --now wg-quick@wg-db212
ip -4 route get 10.200.200.3
sudo iptables -S FORWARD
sudo iptables -t nat -S POSTROUTING
```

确认 `wg-db212` 路由和这份配置的六条专用 iptables 规则均消失，再撤销本次新增的 UDP 51821 安全组或主机防火墙许可。若本次单独将 `ip_forward` 从 `0` 改为 `1`，确认没有其他业务依赖后删除 `/etc/sysctl.d/90-wg-db212.conf` 并执行 `sudo sysctl -w net.ipv4.ip_forward=0`。不要删除 212 现有 Kilo 接口、Cilium 规则或数据库配置。
